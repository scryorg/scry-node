const axios = require('axios');
const fs = require('fs');
const { ApiError } = require('./errors.js');
const { createLogger } = require('./logger.js');
const { version: PACKAGE_VERSION } = require('../package.json');
const { uploadViaDelta } = require('./deltaUpload.js');

// Every Scry service echoes an x-scry-request-id; showing it as "Ref: <id>"
// lets a user quote it and support find the whole server-side trail.
const REQUEST_ID_HEADER = 'x-scry-request-id';
const REQUEST_ID_RE = /^[0-9A-Za-z-]{8,64}$/;

/** The request id from an axios error's response, or undefined (absent or malformed). */
function getRequestId(error) {
  const headers = error?.response?.headers;
  if (!headers) return undefined;
  const raw = typeof headers.get === 'function' ? headers.get(REQUEST_ID_HEADER) : headers[REQUEST_ID_HEADER];
  const id = typeof raw === 'string' ? raw.trim() : '';
  return REQUEST_ID_RE.test(id) ? id : undefined;
}

/**
 * The single gate for any server-provided string that reaches the console:
 * strips ANSI escape sequences and control characters, then caps at 200 chars.
 */
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- matching control characters is the point
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
function sanitizeServerText(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(ANSI_RE, '').replace(CONTROL_RE, ' ').slice(0, max);
}

/**
 * The only part of a server error body that is shown: its `error` string,
 * capped. The rest of the body can carry data and is never printed.
 */
function safeServerError(data) {
  if (data && typeof data === 'object' && typeof data.error === 'string') {
    return sanitizeServerText(data.error);
  }
  return undefined;
}

const isVerbose =
  process.env.SCRY_VERBOSE === 'true' ||
  process.env.STORYBOOK_DEPLOYER_VERBOSE === 'true' ||
  process.env.VERBOSE === 'true' ||
  process.env.SCRY_API_DEBUG === 'true' ||
  process.env.SCRY_DEBUG === 'true' ||
  process.argv.includes('--verbose');

const logger = createLogger({ verbose: isVerbose });

const COVERAGE_UPLOAD_DELAY_MS = 5000;
const COVERAGE_RETRY_DELAY_MS = 60000;

// The upload is the last step of a deploy, so a blip here discards several
// minutes of completed screenshot capture. Retrying is far cheaper than
// redoing that work. See ISSUES.md #19.
const UPLOAD_MAX_ATTEMPTS = 4;
const UPLOAD_BACKOFF_BASE_MS = 2000;

// Bodies POSTed through the upload service (metadata ZIP, coverage JSON).
const SERVICE_UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_TIMEOUT_FLOOR_MS = 60000;
const UPLOAD_MIN_BYTES_PER_S = 100 * 1024;
const UPLOAD_TIMEOUT_CAP_MS = 15 * 60 * 1000;

// Network-level failures that a later attempt can plausibly survive. Flapping
// DNS reports EAI_AGAIN (and, mid-flap, ENOTFOUND) rather than a clean refusal.
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_NETWORK',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed upload attempt is worth repeating.
 *
 * A 4xx other than 429 means the request itself is wrong — retrying it just
 * burns time and produces the identical failure.
 *
 * @param {Error & {code?: string, response?: {status?: number}}} error
 * @returns {boolean}
 */
function isTransientUploadError(error) {
  const status = error?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return TRANSIENT_CODES.has(error?.code);
}

/**
 * Run an upload attempt, repeating it while the failure looks transient.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} attemptFn
 * @param {string} label Shown in logs so a retried upload does not look like a hang.
 * @returns {Promise<T>}
 */
async function withUploadRetry(attemptFn, label) {
  let lastError;

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptFn(attempt);
    } catch (error) {
      lastError = error;

      if (!isTransientUploadError(error) || attempt === UPLOAD_MAX_ATTEMPTS) {
        throw error;
      }

      const backoff = UPLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      const reason = error.code || `HTTP ${error?.response?.status}`;
      // Deliberately at info level: a silent retry is indistinguishable from a
      // hung deploy, which is its own reported failure mode.
      logger.info(
        `${label} attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS} failed (${reason}); retrying in ${backoff / 1000}s...`
      );
      await sleep(backoff);
    }
  }

  throw lastError;
}

/**
 * How long one upload through the upload service may take: max(60 s,
 * bytes / 100 KB/s), capped at 15 min (RCA 2 of storybook-preview-ci-runtime).
 * A fixed 60 s failed a 28 MB metadata ZIP on a 0.4-0.85 MB/s runner uplink.
 * SCRY_UPLOAD_TIMEOUT_FLOOR_MS lowers or raises the 60 s floor (tests, very
 * slow links).
 *
 * @param {number} bytes
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} milliseconds
 */
function uploadTimeoutMs(bytes, env = process.env) {
  const floorRaw = Number(env.SCRY_UPLOAD_TIMEOUT_FLOOR_MS);
  const floor = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : UPLOAD_TIMEOUT_FLOOR_MS;
  const scaled = Math.ceil((Math.max(0, bytes) / UPLOAD_MIN_BYTES_PER_S) * 1000);
  return Math.min(UPLOAD_TIMEOUT_CAP_MS, Math.max(floor, scaled));
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function describeUploadError(error) {
  if (error?.response?.status) return `HTTP ${error.response.status}`;
  if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message))) return `timeout: ${error.message}`;
  return error?.code || error?.message || 'unknown error';
}

/**
 * POST a body through the upload service with a size-scaled timeout, retrying
 * timeouts, 5xx/429 and network errors (never other 4xx) up to 3 attempts
 * with backoff. Every attempt is logged with its size and elapsed time, so a
 * slow link reads as slow, not hung. Throws the last error.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {string} url
 * @param {Buffer|string|object} body
 * @param {{label:string, bytes:number, headers:object, log?:{info:Function}}} o
 */
async function postThroughService(apiClient, url, body, { label, bytes, headers, log = logger }) {
  const timeout = uploadTimeoutMs(bytes);
  const backoffRaw = Number(process.env.SCRY_UPLOAD_BACKOFF_MS);
  const backoffBase = Number.isFinite(backoffRaw) && backoffRaw >= 0 ? backoffRaw : UPLOAD_BACKOFF_BASE_MS;
  const size = formatBytes(bytes);
  let lastError;
  for (let attempt = 1; attempt <= SERVICE_UPLOAD_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    log.info(`${label}: attempt ${attempt}/${SERVICE_UPLOAD_MAX_ATTEMPTS}, ${size}, timeout ${Math.round(timeout / 1000)} s...`);
    try {
      const response = await apiClient.post(url, body, {
        headers,
        timeout,
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
      });
      log.info(`${label}: sent ${size} in ${((Date.now() - started) / 1000).toFixed(1)} s (attempt ${attempt}/${SERVICE_UPLOAD_MAX_ATTEMPTS}).`);
      return response;
    } catch (error) {
      lastError = error;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (!isTransientUploadError(error) || attempt === SERVICE_UPLOAD_MAX_ATTEMPTS) {
        log.info(`${label}: attempt ${attempt}/${SERVICE_UPLOAD_MAX_ATTEMPTS} (${size}) failed after ${elapsed} s (${describeUploadError(error)}).`);
        throw error;
      }
      const backoff = backoffBase * Math.pow(2, attempt - 1);
      log.info(`${label}: attempt ${attempt}/${SERVICE_UPLOAD_MAX_ATTEMPTS} (${size}) failed after ${elapsed} s (${describeUploadError(error)}); retrying in ${backoff / 1000} s...`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/**
 * Creates a pre-configured axios instance for making API calls.
 * @param {string} apiUrl The base URL of the API.
 * @param {string} apiKey The API key for authentication (optional).
 * @returns {axios.AxiosInstance} A configured axios instance.
 */
function getApiClient(apiUrl, apiKey) {
  logger.debug(`Initializing API client with baseURL: ${apiUrl}`);
  // This is a mock check to allow testing of a 401 error case.
  if (apiKey === 'fail-me-401') {
    logger.debug('Mock 401 failure triggered by API key');
    throw new ApiError('The provided API key is invalid or has expired.', 401);
  }
  
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-scry-client': `scry-deployer/${PACKAGE_VERSION}`,
  };
  
  // Only add X-API-Key header if API key is provided
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  
  return axios.create({
    baseURL: apiUrl,
    headers: headers,
    timeout: 60000, // 60 second timeout for large uploads
  });
}

/**
 * Request a presigned URL from the backend.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {{project: string, version: string}} target
 * @param {{fileName: string, contentType: string, ciTimings?: object}} file
 *   `ciTimings`: the pre-upload part of the CI timings record, sent next to
 *   contentType. An upload service older than the field ignores it.
 * @returns {Promise<{url: string, visibility?: string, buildId?: string, buildNumber?: number}>} presigned URL details
 */
async function requestPresignedUrl(apiClient, target, file) {
  const projectName = target.project || 'main';
  const versionName = target.version || 'latest';

  logger.debug(`Requesting presigned URL for ${projectName}/${versionName}/${file.fileName}`);
  
  const presignedResponse = await apiClient.post(
    `/presigned-url/${projectName}/${versionName}/${file.fileName}`,
    file.ciTimings ? { contentType: file.contentType, ciTimings: file.ciTimings } : { contentType: file.contentType },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  logger.debug(`Presigned URL response status: ${presignedResponse.status}`);
  if (presignedResponse.data?.buildId || presignedResponse.data?.buildNumber) {
    logger.info(
      `Build record confirmed by presigned URL response (buildId: ${presignedResponse.data?.buildId || 'n/a'}, buildNumber: ${presignedResponse.data?.buildNumber || 'n/a'}).`
    );
  } else {
    logger.debug(
      `Presigned URL response did not include buildId/buildNumber. Response keys: ${Object.keys(presignedResponse.data || {}).join(', ') || 'none'}`
    );
  }
  const presignedUrl = presignedResponse.data?.url;
  const visibility = presignedResponse.data?.visibility;
  if (!presignedUrl || typeof presignedUrl !== 'string' || presignedUrl.trim() === '') {
    logger.debug(`Invalid presigned URL received (HTTP ${presignedResponse.status}).`);
    throw new ApiError(
      `Failed to get valid presigned URL from server response (HTTP ${presignedResponse.status}).`
    );
  }

  const parsedUrl = validatePresignedUrl(presignedUrl);
  logger.debug(`Validated presigned URL host: ${parsedUrl.hostname}`);

  return {
    url: presignedUrl,
    visibility,
    buildId: presignedResponse.data?.buildId,
    buildNumber: presignedResponse.data?.buildNumber,
  };
}

function getAxiosErrorDetails(error, fallbackUrl) {
  if (error.response) {
    const serverError = safeServerError(error.response.data);
    const serverSuffix = serverError ? ` - ${serverError}` : '';
    return {
      message: `HTTP ${error.response.status} ${error.response.statusText}${serverSuffix}`,
      statusCode: error.response.status,
      requestId: getRequestId(error),
      kind: 'response'
    };
  }

  if (error.request) {
    const code = error.code ? ` (${error.code})` : '';
    const url = error.config?.url || fallbackUrl || 'unknown URL';
    const baseURL = error.config?.baseURL ? ` (baseURL: ${error.config.baseURL})` : '';
    return {
      message: `No response received from ${url}${baseURL}${code}`,
      statusCode: undefined,
      requestId: undefined,
      kind: 'request'
    };
  }

  return {
    message: error.message || 'Unknown error',
    statusCode: undefined,
    requestId: undefined,
    kind: 'unknown'
  };
}

function validatePresignedUrl(presignedUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(presignedUrl);
  } catch {
    throw new ApiError('Received invalid URL format from server (not printed: it can carry a signature).');
  }

  const hostname = parsedUrl.hostname || '';
  if (hostname.includes('undefined')) {
    throw new ApiError(
      `Presigned URL hostname contains "undefined": ${hostname}. This usually means the upload service is missing its R2 account ID or bucket configuration.`
    );
  }

  if (!hostname.endsWith('.r2.cloudflarestorage.com')) {
    logger.debug(`Presigned URL hostname does not look like a standard R2 host: ${hostname}`);
  }

  return parsedUrl;
}

/**
 * Upload a buffer to a presigned URL.
 *
 * @param {string} presignedUrl
 * @param {Buffer|import('stream').Readable} data
 * @param {string} contentType
 * @param {{timeout?: number}} [options] timeout in ms (axios: a stalled socket
 *   is aborted after this long without traffic); omitted keeps the old
 *   no-timeout behaviour for the Storybook archive.
 * @returns {Promise<{status:number}>}
 */
async function putToPresignedUrl(presignedUrl, data, contentType, options = {}) {
  const size = Buffer.isBuffer(data) ? `${data.length} bytes` : 'stream';
  logger.debug(`Starting PUT upload to presigned URL. Size: ${size}, Content-Type: ${contentType}`);
  
  const uploadResponse = await axios.put(presignedUrl, data, {
    headers: {
      'Content-Type': contentType,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    ...(options.timeout ? { timeout: options.timeout } : {}),
    // Use a separate timeout for the actual upload if needed, 
    // but here we rely on the global axios or the one passed in.
  });

  logger.debug(`PUT upload completed with status: ${uploadResponse.status}`);
  return { status: uploadResponse.status };
}

/**
 * Uploads a file using a presigned URL workflow.
 *
 * @param {axios.AxiosInstance} apiClient The configured axios instance.
 * @param {object} payload The metadata for the deployment.
 * @param {string} payload.project The project name/identifier.
 * @param {string} payload.version The version identifier.
 * @param {string} filePath The local path to the file to upload.
 * @param {{fileName?: string, contentType?: string, ciTimings?: object}} [file] Optional overrides
 * @returns {Promise<object>} A promise that resolves to the upload result.
 */
async function uploadFileDirectly(apiClient, { project, version }, filePath, file = {}) {
  logger.debug(`uploadFileDirectly called for file: ${filePath}`);
  
  // This is a mock check to allow testing of a 500 server error.
  if (project === 'fail-me-500') {
    logger.debug('Mock 500 failure triggered by project name');
    throw new ApiError('The deployment service encountered an internal error.', 500);
  }

  if (!fs.existsSync(filePath)) {
    logger.debug(`File not found: ${filePath}`);
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = file.fileName || 'storybook.zip';
  const contentType = file.contentType || 'application/zip';

  try {
    // The presigned URL is signed at request time, so a retry after a long
    // backoff must re-request it — reusing a stale one fails with a confusing
    // signature error instead of the real network cause.
    return await withUploadRetry(async () => {
      const presigned = await requestPresignedUrl(apiClient, { project, version }, { fileName, contentType, ciTimings: file.ciTimings });
      const upload = await putToPresignedUrl(presigned.url, fileBuffer, contentType);
      return {
        success: true,
        url: presigned.url,
        status: upload.status,
        visibility: presigned.visibility,
        buildId: presigned.buildId,
        buildNumber: presigned.buildNumber,
      };
    }, `Upload of ${fileName}`);
  } catch (error) {
    logger.debug(`Upload failed. Error type: ${error.constructor.name}, Message: ${error.message}`);
    const details = getAxiosErrorDetails(error, apiClient.defaults.baseURL);
    if (details.kind === 'response') {
      logger.debug(`Error response status: ${details.statusCode}`);
    } else if (details.kind === 'request') {
      logger.debug(`Error request details: ${details.message}`);
    }
    throw new ApiError(`Failed to upload file: ${details.message}`, details.statusCode, details.requestId);
  }
}

/**
 * Upload coverage report via the coverage attach endpoint.
 * This uploads the JSON to R2 and attaches normalized coverage to the build.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {{project: string, version: string}} target
 * @param {any} coverageReport
 * @returns {Promise<{success: boolean, buildId?: string, coverageUrl?: string}>}
 */
async function uploadCoverageReportDirectly(apiClient, target, coverageReport) {
  const projectName = target.project || 'main';
  const versionName = target.version || 'latest';

  logger.info(`Uploading coverage report for ${projectName}/${versionName}...`);
  logger.debug(`Uploading coverage report for ${projectName}/${versionName}`);

  try {
    const json = JSON.stringify(coverageReport);
    const response = await postThroughService(
      apiClient,
      `/upload/${projectName}/${versionName}/coverage`,
      json,
      { label: 'Coverage report', bytes: Buffer.byteLength(json), headers: { 'Content-Type': 'application/json' } },
    );

    logger.debug(`Coverage upload response status: ${response.status}`);
    logger.info(`Coverage report upload complete (status ${response.status}).`);
    return {
      success: response.data?.success ?? true,
      buildId: response.data?.buildId,
      coverageUrl: response.data?.coverageUrl,
    };
  } catch (error) {
    logger.debug(`Coverage upload failed. Message: ${error.message}`);
    const details = getAxiosErrorDetails(error, apiClient.defaults.baseURL);

    if (
      details.statusCode === 404 &&
      error.response?.data &&
      typeof error.response.data === 'object' &&
      String(error.response.data.error || '').includes('Build not found')
    ) {
      logger.error('Coverage upload failed with 404: Build not found for this version.');
      logger.info('This is not a missing-secret error. The production Worker did not find a Firestore build record for the project + version you are attaching coverage to.');
      logger.info('Coverage requires an existing build record created by a prior build upload or presigned URL generation.');
      logger.info('Most common causes and fixes:');
      logger.info('1) Coverage called before build exists. Upload the build ZIP first (or call the presigned URL endpoint) and then upload coverage.');
      logger.info('2) Project/version mismatch. Coverage must use the same {project}/{version} as the build upload or presigned URL call.');
      logger.info('3) Firestore secrets present but invalid. A malformed FIREBASE_PRIVATE_KEY (missing literal \\n sequences) or wrong project ID can prevent build creation.');
      logger.info('4) Firestore integration disabled in prod. Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIRESTORE_SERVICE_ACCOUNT_ID are set.');
      logger.info('Recommended checks:');
      logger.info('- Trigger a production upload or presigned URL call first and verify it returns buildId/buildNumber (confirms Firestore created a build).');
      logger.info('- Then call the coverage endpoint for the same project/version.');
      logger.info('- If upload does not return buildId/buildNumber, fix Firestore secrets and ensure FIREBASE_PRIVATE_KEY preserves literal \\n as documented.');
      logger.info('See README.md and docs/PRODUCTION_SETUP.md for details.');
    }

    throw new ApiError(`Failed to upload coverage: ${details.message}`, details.statusCode, details.requestId);
  }
}

// The upload Worker refuses a metadata body above this on the old
// POST .../metadata route (and the deployer never sent more through it).
const METADATA_OLD_ROUTE_MAX_BYTES = 100 * 1024 * 1024;

function metadataUrl(target, suffix, query = '') {
  const project = encodeURIComponent(target.project || 'main');
  const version = encodeURIComponent(target.version || 'latest');
  return `/upload/${project}/${version}/metadata${suffix}${query}`;
}

/** An upload service older than the presign route answers 404 (no such route). */
function isPresignRouteMissing(error) {
  return error?.response?.status === 404;
}

/**
 * Old route: POST the whole ZIP through the upload Worker. Kept for an upload
 * service that has no presign route, up to METADATA_OLD_ROUTE_MAX_BYTES.
 */
async function uploadMetadataZipViaWorker(apiClient, target, fileBuffer, query, customLogger) {
  const response = await postThroughService(apiClient, metadataUrl(target, '', query), fileBuffer, {
    label: 'Metadata ZIP',
    bytes: fileBuffer.length,
    headers: { 'Content-Type': 'application/zip' },
    log: customLogger,
  });
  const data = response.data || {};
  customLogger.success(
    `Metadata ZIP uploaded (build #${data.buildNumber ?? 'n/a'}, queued: ${Boolean(data.queued)})`
  );
  return {
    success: true,
    status: response.status,
    queued: Boolean(data.queued),
    buildNumber: data.buildNumber,
    zipKey: data.zipKey,
  };
}

/**
 * Ask the upload service to mark the build failed, with a reason, so a metadata
 * upload that did not finish does not leave the build "pending" for ever.
 * Never throws: when this cannot be done the caller is told, and the warning is
 * printed here, so the build being left pending is never silent.
 *
 * @returns {Promise<boolean>} true when the service recorded the failure
 */
async function markMetadataUploadFailed(apiClient, target, buildId, reason, customLogger) {
  if (!buildId) {
    customLogger.warn('The build could not be marked failed: no build id is known (the upload service did not return one).');
    return false;
  }
  try {
    await postThroughService(apiClient, metadataUrl(target, '/failed'), { buildId, reason }, {
      label: 'Mark build failed',
      bytes: 0,
      headers: { 'Content-Type': 'application/json' },
      log: customLogger,
    });
    customLogger.info(`Build ${buildId} marked failed on the upload service.`);
    return true;
  } catch (error) {
    customLogger.warn(
      `The build could not be marked failed (${sanitizeServerText(error.response?.data?.error || describeUploadError(error))}); ` +
      `build ${buildId} stays pending.`
    );
    return false;
  }
}

/**
 * presign + PUT in one retried unit: the presigned URL is signed at request
 * time, so every attempt asks for a fresh one. `stage` says which half failed.
 */
async function presignAndPutMetadataZip(apiClient, target, fileBuffer, stage) {
  return withUploadRetry(async () => {
    stage.name = 'presign';
    const response = await apiClient.post(metadataUrl(target, '/presign'), {}, { headers: { 'Content-Type': 'application/json' } });
    const { url, key, buildId } = response.data || {};
    if (!url || typeof url !== 'string') throw new ApiError(`The metadata presign response had no url (HTTP ${response.status}).`);
    if (!key || typeof key !== 'string') throw new ApiError(`The metadata presign response had no key (HTTP ${response.status}).`);
    if (!buildId || typeof buildId !== 'string') throw new ApiError(`The metadata presign response had no buildId (HTTP ${response.status}).`);
    stage.buildId = buildId;
    validatePresignedUrl(url);
    stage.name = 'put';
    // A PUT that stalls must end (and be retried, then marked failed), never hang the deploy.
    await putToPresignedUrl(url, fileBuffer, 'application/zip', { timeout: uploadTimeoutMs(fileBuffer.length) });
    return { buildId, buildNumber: response.data?.buildNumber, zipKey: key };
  }, 'Metadata ZIP upload to storage');
}

/**
 * Upload the metadata+screenshots ZIP and queue it for processing.
 *
 * The ZIP goes straight to storage on a presigned URL (presign, PUT, complete),
 * so it never passes through the upload Worker and has no 100 MiB cap. Against
 * an upload service that has no presign route (HTTP 404) the old route is used
 * for a ZIP of up to 100 MiB, with a warning; a larger ZIP stops with
 * "upload service too old for a ZIP this size". A failed PUT or complete marks
 * the build failed (metadata/failed) and returns {success:false}.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {{project: string, version: string}} target
 * @param {string} metadataZipPath
 * @param {{info:Function,success:Function,warn:Function}} customLogger
 * @param {{commitSha?: string, branch?: string}} [gitContext] Provenance for the
 *   build document. Sent as query parameters so the service can record which
 *   commit a build's indexed rows came from (P13a). Omitted members are simply
 *   not sent; the service treats their absence as unknown rather than guessing.
 * @param {{buildId?: string}} [known] The build the storybook ZIP created, used
 *   to mark it failed when the presign step itself fails.
 * @returns {Promise<{success:boolean, status?:number, queued?:boolean, buildNumber?:number, zipKey?:string, error?:string, requestId?:string, markedFailed?:boolean}>}
 */
async function uploadMetadataZip(apiClient, target, metadataZipPath, customLogger = logger, gitContext = {}, known = {}) {
  const query = new URLSearchParams();
  if (gitContext.commitSha) query.set('commitSha', gitContext.commitSha);
  if (gitContext.branch) query.set('branch', gitContext.branch);
  const queryString = query.toString() ? `?${query.toString()}` : '';

  customLogger.info('Uploading metadata ZIP...');

  const stage = { name: 'read', buildId: known.buildId };
  let fileBuffer;
  let presigned;
  try {
    fileBuffer = fs.readFileSync(metadataZipPath);
    stage.name = 'presign';
    presigned = await presignAndPutMetadataZip(apiClient, target, fileBuffer, stage);
  } catch (error) {
    if (stage.name === 'presign' && isPresignRouteMissing(error)) {
      return uploadMetadataZipOldService(apiClient, target, fileBuffer, queryString, customLogger);
    }
    return failMetadataUpload(apiClient, target, stage, error, customLogger);
  }
  customLogger.info(`Metadata ZIP stored (${formatBytes(fileBuffer.length)}, build #${presigned.buildNumber ?? 'n/a'}).`);

  stage.name = 'complete';
  try {
    const response = await postThroughService(
      apiClient,
      metadataUrl(target, '/complete', queryString),
      { buildId: presigned.buildId, zipKey: presigned.zipKey },
      { label: 'Metadata complete', bytes: 0, headers: { 'Content-Type': 'application/json' }, log: customLogger }
    );
    const data = response.data || {};
    customLogger.success(
      `Metadata ZIP uploaded (build #${data.buildNumber ?? presigned.buildNumber ?? 'n/a'}, queued: ${Boolean(data.queued)})`
    );
    return {
      success: true,
      status: response.status,
      queued: Boolean(data.queued),
      buildNumber: data.buildNumber ?? presigned.buildNumber,
      zipKey: data.zipKey || presigned.zipKey,
    };
  } catch (error) {
    return failMetadataUpload(apiClient, target, stage, error, customLogger);
  }
}

/** The upload service has no presign route: the old route, or a clear stop. */
async function uploadMetadataZipOldService(apiClient, target, fileBuffer, queryString, customLogger) {
  if (fileBuffer.length > METADATA_OLD_ROUTE_MAX_BYTES) {
    const message =
      `upload service too old for a ZIP this size (${formatBytes(fileBuffer.length)}; it has no presigned metadata upload ` +
      `and its metadata route takes at most ${formatBytes(METADATA_OLD_ROUTE_MAX_BYTES)}). Update the upload service, then re-run.`;
    customLogger.error(`Metadata ZIP upload failed: ${message}`);
    return { success: false, error: message, markedFailed: false, markFailedUnsupported: true };
  }
  customLogger.warn(
    'The upload service has no presigned metadata upload (HTTP 404); using the old route ' +
    `(ZIP of ${formatBytes(fileBuffer.length)}, limit ${formatBytes(METADATA_OLD_ROUTE_MAX_BYTES)}).`
  );
  try {
    return await uploadMetadataZipViaWorker(apiClient, target, fileBuffer, queryString, customLogger);
  } catch (error) {
    const message = sanitizeServerText(error.response?.data?.error || error.message || 'Unknown error');
    customLogger.error(`Metadata ZIP upload failed: ${message}`);
    return { success: false, error: message, requestId: getRequestId(error), markedFailed: false, markFailedUnsupported: true };
  }
}

/** A step of the presigned flow failed for good: say so, mark the build failed. */
async function failMetadataUpload(apiClient, target, stage, error, customLogger) {
  // Never print the presigned URL (it carries a signature): an error from the
  // PUT is described by status or code only.
  const detail = stage.name === 'put' || stage.name === 'read'
    ? sanitizeServerText(describeUploadError(error))
    : sanitizeServerText(error.response?.data?.error || error.message || 'Unknown error');
  const step = { read: 'reading the ZIP', presign: 'requesting the upload URL', put: 'sending the ZIP to storage', complete: 'completing the upload' }[stage.name];
  const message = sanitizeServerText(`${step} failed: ${detail}`);
  customLogger.error(`Metadata ZIP upload failed: ${message}`);
  const markedFailed = await markMetadataUploadFailed(apiClient, target, stage.buildId, `metadata upload failed while ${step}: ${detail}`, customLogger);
  return { success: false, error: message, requestId: getRequestId(error), markedFailed, buildId: stage.buildId };
}

/**
 * The manifest-first (delta) upload of the metadata part of a deploy; see lib/deltaUpload.js.
 * `handled: false` + a reason means: use the metadata ZIP path.
 *
 * @param {{commitSha?: string, branch?: string}} [gitContext] The provenance uploadMetadataZip sends.
 * @param {{buildId?: string}} [known] The build the storybook ZIP created; the pictures attach to it.
 *   Without one the delta path is not used.
 */
function uploadMetadataDelta(apiClient, target, metadataZipPath, customLogger = logger, gitContext = {}, known = {}) {
  return uploadViaDelta(apiClient, target, metadataZipPath, {
    postThroughService,
    markMetadataUploadFailed,
    uploadTimeoutMs,
    isTransientUploadError,
    formatBytes,
    log: customLogger,
  }, { buildId: known.buildId, gitContext });
}

/**
 * The metadata + screenshots part of a deploy. Manifest-first: send only the pictures the
 * project does not hold. Anything that stops it before the commit falls back to the metadata
 * ZIP, with the reason on one line; a commit that says pictures are missing ends the deploy
 * red (never green, G6).
 */
async function sendMetadata(apiClient, target, options, zipUpload) {
  // gitContext is passed in rather than resolved here: the caller knows the repository the
  // deploy is for, and a helper that shells out to git on its own would do so in every test
  // that touches this path. The delta and the ZIP get the same provenance and the same build.
  const gitContext = options.gitContext || {};
  const known = { buildId: zipUpload?.buildId };
  const delta = await uploadMetadataDelta(apiClient, target, options.metadataZipPath, logger, gitContext, known);
  if (delta.handled) return delta.result;
  logger.info(`Delta upload not used (${delta.reason}); sending the metadata ZIP.`);
  return uploadMetadataZip(apiClient, target, options.metadataZipPath, logger, gitContext, known);
}

/**
 * Upload storybook zip plus optional coverage report.
 *
 * NOTE: The backend currently supports uploads via presigned URLs only.
 * This helper keeps the orchestration in one place.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {{project: string, version: string}} target
 * @param {{zipPath: string, coverageReport?: any|null, metadataZipPath?: string|null, gitContext?: {commitSha?: string, branch?: string}, ciTimings?: object|null}} options
 *   `ciTimings`: the pre-upload part of the CI timings record; rides on the
 *   storybook.zip presigned-URL request, which is what creates the build.
 */
async function uploadBuild(apiClient, target, options) {
  logger.debug('uploadBuild orchestration started');
  const zipUpload = await uploadFileDirectly(apiClient, target, options.zipPath, {
    fileName: 'storybook.zip',
    contentType: 'application/zip',
    ...(options.ciTimings ? { ciTimings: options.ciTimings } : {}),
  });

  let coverageUpload = null;
  if (options.coverageReport) {
    logger.info(`Waiting ${COVERAGE_UPLOAD_DELAY_MS / 1000}s before uploading coverage report...`);
    await sleep(COVERAGE_UPLOAD_DELAY_MS);

    // The retry used to be unguarded, so a second failure threw out of
    // uploadBuild and the metadata upload below never ran. Coverage is a
    // report; the metadata archive is what makes components searchable — so a
    // failure in the optional artifact was silently taking down the essential
    // one. Observed on a 467-story library: every story captured, nothing
    // indexed, twice.
    // Timeouts, 5xx and network errors are retried inside the upload. The
    // one 4xx worth waiting for is the build record not existing yet (the
    // presigned call creates it), so only that gets the old 60 s second try.
    const coverageFailed = (err) => logger.warn(
      `⚠️  Coverage report upload failed: ${err.message}\n` +
      '   Continuing — this affects the coverage report only. Screenshots and\n' +
      '   metadata still upload, so components will still be indexed.'
    );
    try {
      coverageUpload = await uploadCoverageReportDirectly(apiClient, target, options.coverageReport);
    } catch (error) {
      if (error.statusCode === 404 && /Build not found/.test(error.message)) {
        logger.info('Coverage upload found no build yet; retrying in 60s...');
        await sleep(COVERAGE_RETRY_DELAY_MS);
        try {
          coverageUpload = await uploadCoverageReportDirectly(apiClient, target, options.coverageReport);
        } catch (retryError) {
          coverageFailed(retryError);
        }
      } else {
        coverageFailed(error);
      }
    }
  }

  const metadataUpload = options.metadataZipPath ? await sendMetadata(apiClient, target, options, zipUpload) : null;

  return { zipUpload, coverageUpload, metadataUpload };
}

/**
 * Upload an SCF bundle ZIP through the upload service's bundle route (capture-sources
 * contract §9): the presigned call creates the build with its `source`, the ZIP goes straight
 * to storage, and `complete` validates it server-side with the same validator (G7) and queues
 * it for indexing. A rejected bundle comes back as HTTP 422 with the validator's messages.
 *
 * Wire shapes (ledger F38/F46 — reconciled against scryorg/scry-storybook-upload-service#33's
 * actual Zod schemas, not assumed): the presign response is `{url, fields:{key}, buildId?,
 * buildNumber?}` — `fields.key` is the object key the client PUT the ZIP to, and it is exactly
 * what `complete` calls `zipKey`. `complete`'s body is `{buildId, zipKey}` and nothing else (both
 * required); the server does not read a `source`/`commitSha`/`branch` query string on that route.
 *
 * @param {axios.AxiosInstance} apiClient
 * @param {{project: string, version: string}} target
 * @param {string} zipPath
 * @param {{sourceKey: string, gitContext?: {commitSha?: string, branch?: string}, log?: object}} opts
 * @returns {Promise<{success: boolean, buildId?: string, buildNumber?: number, queued?: boolean, zipKey?: string, status?: number, errors?: Array<object>, error?: string}>}
 */
async function uploadBundle(apiClient, target, zipPath, { sourceKey, gitContext = {}, log = logger }) {
  const projectName = target.project || 'main';
  const versionName = target.version || 'latest';
  const fileBuffer = fs.readFileSync(zipPath);
  const sourceQuery = `source=${encodeURIComponent(sourceKey)}`;

  let presigned;
  try {
    presigned = await withUploadRetry(async () => {
      const response = await apiClient.post(
        `/presigned-url/${encodeURIComponent(projectName)}/${encodeURIComponent(versionName)}/bundle.zip?${sourceQuery}`,
        { contentType: 'application/zip', ...(gitContext.commitSha ? { commitSha: gitContext.commitSha } : {}), ...(gitContext.branch ? { branch: gitContext.branch } : {}) },
        { headers: { 'Content-Type': 'application/json' } }
      );
      const url = response.data?.url;
      if (!url || typeof url !== 'string') {
        throw new ApiError(`Failed to get a presigned URL for the bundle (HTTP ${response.status}).`);
      }
      const zipKey = response.data?.fields?.key;
      if (!zipKey || typeof zipKey !== 'string') {
        throw new ApiError(`Presigned URL response had no fields.key (the bundle object key) (HTTP ${response.status}).`);
      }
      const buildId = response.data?.buildId;
      if (!buildId || typeof buildId !== 'string') {
        throw new ApiError(`Presigned URL response had no buildId (HTTP ${response.status}).`);
      }
      validatePresignedUrl(url);
      await putToPresignedUrl(url, fileBuffer, 'application/zip');
      return { buildId, buildNumber: response.data?.buildNumber, zipKey };
    }, 'Bundle upload');
  } catch (error) {
    const details = getAxiosErrorDetails(error, apiClient.defaults.baseURL);
    throw new ApiError(`Failed to upload the bundle: ${details.message}`, details.statusCode, details.requestId);
  }
  const buildSuffix = presigned.buildNumber !== undefined ? `, build #${presigned.buildNumber}` : '';
  log.info(`Bundle stored (${formatBytes(fileBuffer.length)}${buildSuffix}).`);

  try {
    const response = await postThroughService(
      apiClient,
      `/upload/${encodeURIComponent(projectName)}/${encodeURIComponent(versionName)}/bundle/complete`,
      { buildId: presigned.buildId, zipKey: presigned.zipKey },
      { label: 'Bundle complete', bytes: 0, headers: { 'Content-Type': 'application/json' }, log }
    );
    const data = response.data || {};
    return {
      success: true,
      status: response.status,
      queued: Boolean(data.queued),
      buildId: data.buildId || presigned.buildId,
      buildNumber: data.buildNumber ?? presigned.buildNumber,
      // The server's success response never echoes zipKey back (BundleCompleteResponseSchema
      // has no such field) — it's the value we already know from the presign response.
      zipKey: presigned.zipKey,
    };
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data || {};
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const message = sanitizeServerText(data.error || data.message || error.message || 'Unknown error');
    return { success: false, status, errors, error: message, requestId: getRequestId(error), buildId: presigned.buildId, buildNumber: presigned.buildNumber, zipKey: presigned.zipKey };
  }
}

module.exports = {
  getApiClient,
  getRequestId,
  sanitizeServerText,
  safeServerError,
  uploadBundle,
  uploadFileDirectly,
  uploadCoverageReportDirectly,
  uploadMetadataZip,
  uploadMetadataDelta,
  uploadBuild,
  requestPresignedUrl,
  putToPresignedUrl,
  isTransientUploadError,
  withUploadRetry,
  uploadTimeoutMs,
  postThroughService,
  UPLOAD_MAX_ATTEMPTS,
  SERVICE_UPLOAD_MAX_ATTEMPTS,
};
