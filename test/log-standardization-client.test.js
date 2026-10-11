/* eslint-disable no-control-regex, sonarjs/no-control-regex -- these tests assert that ANSI and control characters are stripped */
/**
 * log-standardization PR 6 (scry-node): the CLI reads x-scry-request-id, shows
 * it as "Ref: <id>", sends x-scry-client, never prints a server error body, and
 * never falls back to Sentry environment "production".
 */
const { sentText, sentEvents } = require('./fixtures/sentry-capture-transport');
const { version } = require('../package.json');
const { ApiError } = require('../lib/errors.js');
const { getApiClient, uploadFileDirectly, getRequestId } = require('../lib/apiClient.js');
const { initTelemetry, captureCliError, flushTelemetry } = require('../lib/telemetry.js');

process.env.SCRY_UPLOAD_BACKOFF_MS = '0';
const REF = '01J8ZQ4M7N2X5V9K3T6R1B0CDE';
const BODY_CANARY = 'canary-body-alice@example.com-sk-abcdefghijklmnop';

function axiosError(status, data, headers) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, statusText: 'Bad Request', data, headers: headers || {} };
  return err;
}

describe('x-scry-client header', () => {
  test('every API call carries scry-deployer/<version>', () => {
    const client = getApiClient('https://api.example.test', 'k');
    expect(client.defaults.headers['x-scry-client']).toBe(`scry-deployer/${version}`);
  });
});

describe('getRequestId', () => {
  test('reads the header from a plain object or an AxiosHeaders-like getter', () => {
    expect(getRequestId(axiosError(500, {}, { 'x-scry-request-id': REF }))).toBe(REF);
    expect(getRequestId(axiosError(500, {}, { get: (n) => (n === 'x-scry-request-id' ? REF : undefined) }))).toBe(REF);
  });
  test('absent or malformed header gives undefined', () => {
    expect(getRequestId(axiosError(500, {}, {}))).toBeUndefined();
    expect(getRequestId(new Error('no response'))).toBeUndefined();
    expect(getRequestId(axiosError(500, {}, { 'x-scry-request-id': 'bad id with spaces & <script>' }))).toBeUndefined();
  });
});

describe('failed API call', () => {
  function clientFailing(err) {
    return { defaults: { baseURL: 'https://api.example.test' }, post: jest.fn().mockRejectedValue(err) };
  }
  const opts = { fileName: 'storybook.zip', contentType: 'application/zip' };

  test('ApiError carries the request id when the response has the header', async () => {
    const client = clientFailing(axiosError(400, { error: 'Bad project' }, { 'x-scry-request-id': REF }));
    const err = await uploadFileDirectly(client, { project: 'p', version: 'v' }, __filename, opts.fileName, opts.contentType).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.requestId).toBe(REF);
    expect(err.statusCode).toBe(400);
  });

  test('absent header: no request id, message unchanged in shape', async () => {
    const client = clientFailing(axiosError(400, { error: 'Bad project' }, {}));
    const err = await uploadFileDirectly(client, { project: 'p', version: 'v' }, __filename, opts.fileName, opts.contentType).catch((e) => e);
    expect(err.requestId).toBeUndefined();
    expect(err.message).toContain('HTTP 400 Bad Request - Bad project');
  });

  test('guarantee-1 server error body is not printed, only status and the error field', async () => {
    const client = clientFailing(
      axiosError(422, { error: 'Upload failed', detail: BODY_CANARY, user: { email: 'alice@example.com' } }, { 'x-scry-request-id': REF })
    );
    const err = await uploadFileDirectly(client, { project: 'p', version: 'v' }, __filename, opts.fileName, opts.contentType).catch((e) => e);
    expect(err.message).toContain('HTTP 422');
    expect(err.message).toContain('Upload failed');
    expect(err.message).not.toContain(BODY_CANARY);
    expect(err.message).not.toContain('alice@example.com');
    expect(err.message).not.toContain('{');
  });
});

describe('Sentry', () => {
  const saved = { DO_NOT_TRACK: process.env.DO_NOT_TRACK, SCRY_TELEMETRY: process.env.SCRY_TELEMETRY, NODE_ENV: process.env.NODE_ENV, CI: process.env.CI };
  beforeAll(async () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.SCRY_TELEMETRY;
    delete process.env.NODE_ENV;
    delete process.env.CI; // telemetry is off in CI (sentry-quota-noise); this test reads what would be sent
    expect(initTelemetry()).toBe(true);
    captureCliError(new ApiError('Failed to upload file: HTTP 500', 500, REF), { _: ['deploy'], project: 'proj' });
    await flushTelemetry(2000);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('environment does not fall back to production', () => {
    expect(sentEvents()[0].environment).toBe('development');
  });
  test('request id is a tag; the only tags are project, command, request_id (no PII)', () => {
    const tags = sentEvents()[0].tags;
    expect(tags.request_id).toBe(REF);
    expect(Object.keys(tags).sort()).toEqual(['command', 'project', 'request_id']);
    expect(sentText()).not.toContain('@example.com');
  });
});

describe('N1/N2 console-bound server strings', () => {
  const SIG_URL = 'https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeefcanary&X-Amz-Credential=AKIAcanary';
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { sanitizeServerText, uploadBundle, uploadMetadataZip, requestPresignedUrl } = require('../lib/apiClient.js');
  const zip = () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scry-n-')), 'x.zip');
    fs.writeFileSync(p, Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'binary'));
    return p;
  };

  test('bundle response lacking fields.key never prints the presigned URL body', async () => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: { url: SIG_URL, buildId: 'b1' } });
    const errors = [];
    const log = { info() {}, success() {}, warn() {}, error: (m) => errors.push(m) };
    const res = await uploadBundle({ defaults: { baseURL: 'https://u' }, post }, { project: 'p', version: 'v' }, zip(), { sourceKey: 's', log }).catch((e) => e);
    const all = `${res.message} ${JSON.stringify(errors)}`;
    expect(res).toBeInstanceOf(ApiError);
    expect(all).toContain('HTTP 200');
    expect(all).not.toContain('X-Amz-Signature');
    expect(all).not.toContain('canary');
  });

  test('invalid presigned URL messages carry status only', async () => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: { url: '', signature: 'canary-sig', buildId: 'b' } });
    const err = await requestPresignedUrl({ post }, { project: 'p', version: 'v' }, { fileName: 'a.zip', contentType: 'application/zip' }).catch((e) => e);
    expect(err.message).toContain('HTTP 200');
    expect(err.message).not.toContain('canary');
    const bad = await requestPresignedUrl({ post: jest.fn().mockResolvedValue({ status: 200, data: { url: 'not a url ?X-Amz-Signature=canary' } }) }, { project: 'p', version: 'v' }, { fileName: 'a.zip', contentType: 'application/zip' }).catch((e) => e);
    expect(bad.message).not.toContain('canary');
  });

  test('an error with ANSI and 10,000 chars is cleaned and capped on every path', async () => {
    const evil = '\u001b[2J\u001b]0;pwn\u0007\u0000' + 'A'.repeat(10000);
    const clean = sanitizeServerText(evil);
    expect(clean).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(clean.length).toBeLessThanOrEqual(200);
    expect(clean).not.toContain('pwn');

    const e422 = axiosError(422, { error: evil });
    const errs = [];
    const meta = await uploadMetadataZip({ defaults: { baseURL: 'https://u' }, post: jest.fn().mockRejectedValue(e422) }, { project: 'p', version: 'v' }, zip(), { info() {}, success() {}, warn() {}, error: (m) => errs.push(m) });
    expect(meta.error.length).toBeLessThanOrEqual(200);
    expect(meta.error).not.toMatch(/[\u0000-\u001f]/);
    expect(errs.join('')).not.toMatch(/\u001b/);

    const post = jest.fn().mockResolvedValueOnce({ status: 200, data: { url: 'https://acct.r2.cloudflarestorage.com/x?s=1', fields: { key: 'k' }, buildId: 'b' } }).mockRejectedValueOnce(axiosError(422, { message: evil }));
    const axios2 = require('axios');
    jest.spyOn(axios2, 'put').mockResolvedValue({ status: 200 });
    const b = await uploadBundle({ defaults: { baseURL: 'https://u' }, post }, { project: 'p', version: 'v' }, zip(), { sourceKey: 's', log: { info() {}, success() {}, warn() {}, error() {} } });
    expect(b.error.length).toBeLessThanOrEqual(200);
    expect(b.error).not.toMatch(/[\u0000-\u001f]/);

    const client = { defaults: { baseURL: 'https://u' }, post: jest.fn().mockRejectedValue(axiosError(400, { error: evil })) };
    const err = await uploadFileDirectly(client, { project: 'p', version: 'v' }, __filename, 'a.zip', 'application/zip').catch((x) => x);
    expect(err.message).not.toMatch(/\u001b/);
    expect(err.message.length).toBeLessThan(400);
  });
});
