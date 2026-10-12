'use strict';

/**
 * Manifest-first upload of a deploy's pictures (feature content-hash-identity, slice 2, PR 6).
 *
 *   POST /delta/{project}/manifest          open a build; the answer says which pictures the project does not hold
 *   PUT  <actions.upload.href>              only those, 8 at a time, href and header exactly as given
 *   POST /delta/{project}/builds/{id}/commit  every picture is held -> the build is queued
 *
 * It replaces the metadata+screenshots ZIP when sbcov wrote a delta bundle (`delta-manifest.json`
 * and the picture files). Anything that stops the delta path BEFORE the commit falls back to the
 * ZIP path with a one-line reason (the caller prints it). What is never a fallback, because the
 * ZIP would hide it: the upload service saying at commit that a picture it was told about did not
 * arrive (409 missing_blobs) or that the key may not commit this build (403). Those end the deploy
 * red with the request id (guarantee G6: never green with pictures missing).
 *
 * One deploy is one build: the manifest names the build the deploy's storybook.zip upload already
 * created (`buildId`) and carries the same git provenance the metadata-ZIP path sends, so the
 * pictures attach to that build instead of opening a second one. Without that build id the delta
 * path is not used (the ZIP is). A hard failure marks that build failed, as the ZIP path does.
 *
 * Secrets: the Scry API key goes only to the API's own origin. A foreign `href` (the direct-to-R2
 * link) is followed as given with exactly the header the server named and nothing else, and the
 * href itself (it carries a signature) is never printed.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const DELTA_MANIFEST_FILE = 'delta-manifest.json';
const DELTA_FILES_DIR = 'delta-files';
const STALE_SLACK_MS = 2000;
/** Highest-preference first: R2 direct links (a foreign origin), then the upload service itself. */
const TRANSFERS = ['r2-presigned', 'basic'];
const PUT_CONCURRENCY = 8;
/** A PUT is tried once plus this many retries (5xx, 429 and network errors only). */
const PUT_RETRIES = 3;
const PUT_BACKOFF_BASE_MS = 500;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * SCRY_DELTA=0 turns the delta path off (the ZIP path is used). Anything else, including unset, is on.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function deltaEnabled(env = process.env) {
  return String(env.SCRY_DELTA ?? '').trim() !== '0';
}

/**
 * Where sbcov (--delta-manifest) put the delta bundle: next to the metadata ZIP, `delta-manifest.json`
 * (written last, atomically) and `delta-files/` holding each picture at `delta-files/<manifest path>`
 * (e.g. `delta-files/images/<name>.png`).
 *
 * @param {string} metadataZipPath
 * @returns {{manifestPath: string, root: string}|null} null when sbcov wrote none
 */
function locateDeltaBundle(metadataZipPath) {
  if (!metadataZipPath) return null;
  const dir = path.dirname(metadataZipPath);
  const manifestPath = path.join(dir, DELTA_MANIFEST_FILE);
  return fs.existsSync(manifestPath) ? { manifestPath, root: path.join(dir, DELTA_FILES_DIR) } : null;
}

/**
 * True when the manifest is clearly older than the ZIP (left over from another run in a shared
 * directory). sbcov writes the manifest after the ZIP, so a fresh one is never older.
 */
function isStaleBundle(bundle, metadataZipPath) {
  try {
    const zipTime = fs.statSync(metadataZipPath).mtimeMs;
    return fs.statSync(bundle.manifestPath).mtimeMs < zipTime - STALE_SLACK_MS;
  } catch {
    return false;
  }
}

/** Remove what sbcov wrote for the delta upload (the manifest and the picture copies), nothing else. */
function removeDeltaBundle(metadataZipPath) {
  if (!metadataZipPath) return;
  const dir = path.dirname(metadataZipPath);
  fs.rmSync(path.join(dir, DELTA_MANIFEST_FILE), { force: true });
  fs.rmSync(path.join(dir, DELTA_FILES_DIR), { recursive: true, force: true });
}

const safeText = (value, max = 200) => String(value ?? '').replace(UNSAFE_TEXT_RE, ' ').slice(0, max);

/** The request id of an axios error's response (header, else the body's request_id), if well formed. */
function requestIdOf(error) {
  const headers = error?.response?.headers;
  const raw = headers && (typeof headers.get === 'function' ? headers.get('x-scry-request-id') : headers['x-scry-request-id']);
  const candidates = [raw, error?.response?.data?.request_id];
  for (const c of candidates) {
    const id = typeof c === 'string' ? c.trim() : '';
    if (REQUEST_ID_RE.test(id)) return id;
  }
  return undefined;
}

const codeOf = (error) => {
  const data = error?.response?.data;
  return data && typeof data === 'object' && typeof data.error === 'string' ? safeText(data.error, 64) : undefined;
};

function describe(error) {
  const status = error?.response?.status;
  const code = codeOf(error);
  if (status) return code ? `HTTP ${status} ${code}` : `HTTP ${status}`;
  return safeText(error?.code || error?.message || 'unknown error', 80);
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Thrown inside this module to leave the delta path: `fallback` = send the ZIP, else the deploy fails. */
class DeltaStop extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // 'fallback' | 'fail'
    this.extra = extra;
  }
}
const fallback = (reason) => new DeltaStop('fallback', reason);
const fail = (message, extra) => new DeltaStop('fail', message, extra);

/**
 * Read and check the bundle on disk: the manifest parses, every picture is a regular file inside
 * the bundle whose size and sha256 are what the manifest says (an sbcov bug must not reach the
 * server as a wrong oid). Throws a fallback for anything unusable.
 *
 * @param {{buildId: string, gitContext: {commitSha?: string, branch?: string}}} attach
 * @returns {Promise<{body: object, files: Map<string, {file: string, size: number}>, entries: number}>}
 */
async function readBundle(bundle, target, attach) {
  const manifest = readManifestFile(bundle.manifestPath);
  const root = path.resolve(bundle.root);
  /** @type {Map<string, {file: string, size: number}>} one entry per distinct picture (oid) */
  const files = new Map();
  for (const [name, entry] of Object.entries(manifest.images)) {
    if (!isImageEntry(entry)) throw fallback('the delta manifest has a picture entry that is not {oid, size}');
    if (!files.has(entry.oid)) files.set(entry.oid, await verifyPicture(root, name, entry));
  }
  if (files.size === 0) throw fallback('the delta manifest lists no pictures');
  // The deploy's own version wins over whatever label sbcov wrote.
  const body = {
    ...manifest,
    protocol: PROTOCOL_VERSION,
    hash: HASH_ALGORITHM,
    version: target.version || manifest.version || 'latest',
    // The storybook.zip build this deploy already has, and the same provenance the metadata ZIP carries
    // (members that are not known are left out). Both are part of the body, so of the Idempotency-Key.
    buildId: attach.buildId,
    ...(attach.gitContext.commitSha ? { commitSha: attach.gitContext.commitSha } : {}),
    ...(attach.gitContext.branch ? { branch: attach.gitContext.branch } : {}),
    transfers: TRANSFERS,
  };
  return { body, files, entries: Object.keys(manifest.images).length };
}

function readManifestFile(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw fallback('the delta manifest sbcov wrote cannot be read');
  }
  const images = manifest && typeof manifest === 'object' ? manifest.images : null;
  const wellFormed = images && typeof images === 'object' && !Array.isArray(images) && manifest.scf && typeof manifest.source === 'string';
  if (!wellFormed) throw fallback('the delta manifest sbcov wrote is not the expected shape');
  return manifest;
}

function isImageEntry(entry) {
  const { oid, size: bytes } = entry || {};
  return typeof oid === 'string' && SHA256_HEX.test(oid) && Number.isInteger(bytes) && bytes >= 0;
}

/** One picture of the bundle: inside the root, a regular file, the size and sha256 the manifest says. */
async function verifyPicture(root, name, entry) {
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw fallback('the delta manifest names a picture outside its bundle');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw fallback('a picture named in the delta manifest is missing on disk');
  }
  if (!stat.isFile() || stat.size !== entry.size) throw fallback('a picture on disk does not match its delta manifest size');
  if ((await sha256OfFile(file)) !== entry.oid) throw fallback('a picture on disk does not match its delta manifest oid');
  return { file, size: stat.size };
}

/** The API key and base URL of an axios instance made by `getApiClient`. */
function apiIdentity(apiClient) {
  const base = apiClient?.defaults?.baseURL;
  const headers = apiClient?.defaults?.headers || {};
  const key = headers['X-API-Key'] ?? headers.common?.['X-API-Key'];
  return { base: typeof base === 'string' ? base : '', key: typeof key === 'string' ? key : '' };
}

/**
 * Whether an upload `href` may be followed, and whether the Scry key may go with it.
 * @returns {{sameOrigin: boolean}} throws a fallback when the href cannot be followed
 */
function checkHref(href, apiBase) {
  let url;
  try {
    url = new URL(href);
  } catch {
    throw fallback('the upload service sent an upload address that cannot be used');
  }
  let api = null;
  try {
    api = apiBase ? new URL(apiBase) : null;
  } catch {
    api = null;
  }
  if (api && url.origin === api.origin) return { sameOrigin: true };
  // A foreign address is where the picture goes (the direct-to-storage link); it must be encrypted
  // in transit unless it is this machine.
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw fallback('the upload service sent a non-https upload address on another host');
  }
  return { sameOrigin: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffBaseMs(env = process.env) {
  const raw = Number(env.SCRY_UPLOAD_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : PUT_BACKOFF_BASE_MS;
}

/**
 * PUT one picture to the address the server named. Retried up to PUT_RETRIES times on 5xx, 429
 * and network errors. Returns bytes on success; throws the last error otherwise.
 */
async function putPicture({ action, picture, identity, uploadTimeoutMs, isTransient, log }) {
  const { sameOrigin } = checkHref(action.href, identity.base);
  const headers = {};
  for (const [name, value] of Object.entries(action.header || {})) {
    if (typeof value === 'string') headers[name] = value;
  }
  // The server's header map cannot set authentication; the key is ours to add, to our own origin only.
  if (sameOrigin && identity.key) headers['X-API-Key'] = identity.key;
  let lastError;
  for (let attempt = 1; attempt <= PUT_RETRIES + 1; attempt++) {
    try {
      const data = fs.readFileSync(picture.file);
      await axios.put(action.href, data, {
        headers,
        timeout: uploadTimeoutMs(picture.size),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        // A redirect would carry the key (or the signature) to a host nobody chose.
        maxRedirects: 0,
        // Axios would add a Content-Type; the server named exactly the headers it signed.
        transformRequest: [(d) => d],
      });
      return picture.size;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === PUT_RETRIES + 1) break;
      const wait = backoffBaseMs() * 2 ** (attempt - 1);
      log.info(`Delta picture upload attempt ${attempt}/${PUT_RETRIES + 1} failed (${describe(error)}); retrying in ${wait / 1000} s...`);
      await sleep(wait);
    }
  }
  throw lastError;
}

/** Run `worker(item)` over `items`, at most `limit` at once; stops handing out work after the first failure. */
async function runPool(items, limit, worker) {
  let next = 0;
  let failure = null;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (error) {
        failure = failure || error;
      }
    }
  });
  await Promise.all(lanes);
  if (failure) throw failure;
}

/** A manifest request that failed for good: fall back, except for answers the ZIP path would hide. */
function stopForManifestError(error) {
  const status = error?.response?.status;
  const code = codeOf(error);
  // The build this deploy created cannot take a delta (not an untouched Storybook build of this project).
  // Nothing was committed, so the metadata ZIP goes to that same build.
  if (status === 409 && code === 'build_not_attachable') {
    return fallback('the upload service cannot attach pictures to this build (build_not_attachable)');
  }
  if (status === 401 || status === 403 || status === 409) {
    return fail(`the upload service refused the delta manifest (${describe(error)})`, { requestId: requestIdOf(error) });
  }
  if (status === 404) return fallback('the upload service has no delta route (HTTP 404)');
  if (status === 503 && code === 'delta_disabled') return fallback('the upload service has delta upload switched off (delta_disabled)');
  return fallback(`the delta manifest request failed (${describe(error)})`);
}

/** Read `objects` from the manifest answer into oid -> {upload action | error}. */
function readObjects(data) {
  if (!data || typeof data.buildId !== 'string' || !Array.isArray(data.objects)) {
    throw fallback('the upload service sent a manifest answer that cannot be read');
  }
  const byOid = new Map();
  for (const o of data.objects) {
    if (!o || typeof o.oid !== 'string') continue;
    const upload = o.actions && o.actions.upload;
    byOid.set(o.oid, {
      upload: upload && typeof upload.href === 'string' ? { href: upload.href, header: upload.header || {} } : null,
      error: o.error && typeof o.error.code === 'string' ? safeText(o.error.code, 64) : null,
    });
  }
  return byOid;
}

/**
 * Upload the pictures of a deploy through the delta protocol.
 *
 * @param {import('axios').AxiosInstance} apiClient made by getApiClient (baseURL + X-API-Key)
 * @param {{project: string, version: string}} target
 * @param {string} metadataZipPath where sbcov's metadata ZIP is; the delta bundle sits beside it
 * @param {object} deps from apiClient.js: postThroughService, markMetadataUploadFailed, uploadTimeoutMs, isTransientUploadError, formatBytes, log
 * @param {{env?: NodeJS.ProcessEnv, buildId?: string, gitContext?: {commitSha?: string, branch?: string}}} [options]
 *   buildId: the build the deploy's storybook.zip upload created (the pictures attach to it); gitContext: the provenance
 *   the metadata-ZIP path sends.
 * @returns {Promise<{handled: false, reason: string} | {handled: true, result: object}>}
 *   handled=false: use the ZIP path (reason is one line). handled=true: result has the shape of
 *   an uploadMetadataZip result (success true, or success false with error/requestId/markedFailed).
 */
async function uploadViaDelta(apiClient, target, metadataZipPath, deps, options = {}) {
  const env = options.env || process.env;
  if (!deltaEnabled(env)) return { handled: false, reason: 'SCRY_DELTA=0' };
  const bundle = locateDeltaBundle(metadataZipPath);
  if (!bundle) return { handled: false, reason: 'sbcov wrote no delta manifest' };
  if (isStaleBundle(bundle, metadataZipPath)) return { handled: false, reason: 'the delta manifest is older than the metadata ZIP' };
  // One deploy is one build: without the storybook.zip build to attach to, the delta would open a second one.
  const buildId = typeof options.buildId === 'string' ? options.buildId : '';
  if (!buildId) return { handled: false, reason: 'the storybook.zip upload returned no build id to attach the pictures to' };
  const attach = { buildId, gitContext: options.gitContext || {} };

  try {
    return { handled: true, result: await runDelta(apiClient, target, bundle, deps, attach) };
  } catch (error) {
    if (!(error instanceof DeltaStop)) throw error;
    if (error.kind === 'fallback') return { handled: false, reason: error.message };
    deps.log.error(`Delta upload failed: ${error.message}`);
    // As the ZIP path does (failMetadataUpload): the build the dashboard shows must not stay "pending".
    const markedFailed = typeof deps.markMetadataUploadFailed === 'function'
      && await deps.markMetadataUploadFailed(apiClient, target, buildId, `delta upload failed: ${safeText(error.message)}`, deps.log);
    return {
      handled: true,
      result: {
        success: false,
        delta: true,
        error: safeText(error.message),
        requestId: error.extra.requestId,
        buildId,
        markedFailed: Boolean(markedFailed),
      },
    };
  }
}

async function runDelta(apiClient, target, bundle, deps, attach) {
  const { postThroughService, formatBytes, log } = deps;
  const project = encodeURIComponent(target.project || 'main');
  const identity = apiIdentity(apiClient);
  const { body, files, entries } = await readBundle(bundle, target, attach);
  const serialized = JSON.stringify(body);
  const idempotencyKey = sha256Hex(`${target.project || 'main'}\n${body.version}\n${sha256Hex(serialized)}`);

  // 1. Manifest: which pictures does the project not hold yet?
  log.info(`Delta upload: ${files.size} distinct pictures in ${entries} entries; asking which are new...`);
  let answer;
  try {
    const response = await postThroughService(apiClient, `/delta/${project}/manifest`, serialized, {
      label: 'Delta manifest',
      bytes: Buffer.byteLength(serialized),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      maxRedirects: 0, // F64: the client sends X-API-Key; a redirect here would carry it to another host
      log,
    });
    answer = response.data;
  } catch (error) {
    throw stopForManifestError(error);
  }
  const objects = readObjects(answer);
  // A service that does not know `buildId` opens a build of its own. Never carry on with a second build.
  if (answer.buildId !== attach.buildId) throw fallback('the upload service opened a different build than the one named, so it cannot attach pictures');

  // 2. Send only what the answer asks for.
  const toSend = [];
  for (const [oid, picture] of files) {
    const object = objects.get(oid);
    if (object && object.error) throw fallback(`the upload service refused a picture (${object.error})`);
    if (object && object.upload) toSend.push({ oid, picture, action: object.upload });
  }
  for (const item of toSend) checkHref(item.action.href, identity.base);
  const sentBytes = await sendPictures(toSend, identity, deps);
  log.info(`pictures: sent ${toSend.length} of ${files.size} (${formatBytes(sentBytes)}), already held ${files.size - toSend.length}`);

  // 3. Commit: the server checks every picture is held before it queues the build.
  const commit = await commitBuild(apiClient, project, attach.buildId, deps);
  const data = commit.data || {};
  const buildNumber = data.buildNumber ?? answer.buildNumber;
  log.success(`Delta upload committed (build #${buildNumber ?? 'n/a'}, queued: ${data.queued !== false})`);
  return {
    success: true,
    delta: true,
    status: commit.status,
    // 202 queued; 200 = this build was already accepted by an earlier commit.
    queued: commit.status === 200 ? true : Boolean(data.queued),
    buildId: attach.buildId,
    buildNumber,
    picturesSent: toSend.length,
    picturesTotal: files.size,
    bytesSent: sentBytes,
  };
}

/** PUT the pictures, PUT_CONCURRENCY at a time; returns the bytes sent. Any failure is a fallback. */
async function sendPictures(toSend, identity, deps) {
  const { uploadTimeoutMs, isTransientUploadError, log } = deps;
  let sentBytes = 0;
  try {
    await runPool(toSend, PUT_CONCURRENCY, async (item) => {
      // Not `sentBytes += await ...`: that reads sentBytes before the await and loses concurrent additions.
      const bytes = await putPicture({ action: item.action, picture: item.picture, identity, uploadTimeoutMs, isTransient: isTransientUploadError, log });
      sentBytes += bytes;
    });
  } catch (error) {
    if (error instanceof DeltaStop) throw error;
    // The build stays open on the server and expires by itself; the ZIP path makes a new one.
    throw fallback(`a picture could not be sent (${describe(error)})`);
  }
  return sentBytes;
}

/** How many pictures a missing_blobs answer says are missing: `count` is the full number, `missing` is capped by the service (1000). */
function missingCount(data) {
  if (Number.isInteger(data?.count)) return String(data.count);
  return Array.isArray(data?.missing) ? String(data.missing.length) : 'some';
}

/** Why a commit that was refused did not queue the build: one line, the count when the service gave one. */
function commitFailureText(error) {
  const status = error?.response?.status;
  const code = codeOf(error);
  const data = error?.response?.data;
  if (status === 422 && code === 'invalid_picture') {
    // The service looked at pictures sent straight to storage, removed the ones that are not valid pictures
    // and did not queue the build. The ZIP would carry the same pictures, so this is a failure, not a fallback.
    const count = Number(data?.count);
    const some = Number.isInteger(count) && count > 0 ? String(count) : 'some';
    return `the upload service says ${some} ${count === 1 ? 'picture is' : 'pictures are'} not a valid picture (invalid_picture), so the build was not queued`;
  }
  if (status === 409 && code === 'missing_blobs') {
    return `the upload service says ${missingCount(data)} pictures never arrived (missing_blobs), so the build was not queued`;
  }
  return `the delta build could not be committed (${describe(error)}), so it was not queued`;
}

/** POST commit. A refusal or an unreachable server is a failure (never green, never a ZIP behind it). */
async function commitBuild(apiClient, project, buildId, deps) {
  try {
    return await deps.postThroughService(apiClient, `/delta/${project}/builds/${encodeURIComponent(buildId)}/commit`, '{}', {
      label: 'Delta commit',
      bytes: 0,
      headers: { 'Content-Type': 'application/json' },
      maxRedirects: 0, // F64: same as the manifest call
      log: deps.log,
    });
  } catch (error) {
    throw fail(commitFailureText(error), { requestId: requestIdOf(error) });
  }
}

module.exports = {
  PROTOCOL_VERSION,
  TRANSFERS,
  PUT_CONCURRENCY,
  PUT_RETRIES,
  deltaEnabled,
  locateDeltaBundle,
  removeDeltaBundle,
  uploadViaDelta,
  // Tests only.
  __runPool: runPool,
};
