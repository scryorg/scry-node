/**
 * End-to-end: spawns the real bin/cli.js against a local HTTP server and checks what
 * an operator actually sees when the API fails (F37: .parse() was not awaited, so
 * handleError never ran and the output was yargs help plus a raw ApiError dump).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const STORYBOOK = path.join(__dirname, '..', 'test-storybook-static');
const REQUEST_ID = '01M3PVT5YG5QMPPJ72DXA6JNF8';
const API_KEY = 'scry_proj_e2eSecretKey1234567890';
const ESC = String.fromCharCode(27);

let server;
let port;
let tmp;
let respond;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-cli-e2e-'));
  // Replaces Sentry init/capture/close in the child so the test can see they ran, without any network.
  fs.writeFileSync(path.join(tmp, 'sentry-stub.js'), `
    const fs = require('fs');
    const S = require(${JSON.stringify(require.resolve('@sentry/node'))});
    const out = process.env.SENTRY_STUB_OUT;
    const log = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\\n');
    S.init = () => log({ init: true });
    const withScope = S.withScope;
    S.withScope = (fn) => fn({ setTag: (k, v) => log({ tag: [k, v] }), setExtra: () => {} });
    S.captureException = (e) => log({ captured: e && e.name });
    S.close = async () => { log({ flushed: true }); return true; };
  `);
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => respond(req, res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runCli(apiUrl, extra = []) {
  const stubOut = path.join(tmp, `sentry-${process.hrtime.bigint()}.log`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-r', path.join(tmp, 'sentry-stub.js'),
      CLI, '--dir', STORYBOOK, '--project', 'e2e', '--deploy-version', 'v1',
      '--api-url', apiUrl, '--api-key', API_KEY, '--no-coverage', ...extra,
    ], {
      // Telemetry is off under tests/CI (sentry-quota-noise); this test reads what the stub received, so run as a customer.
      env: { ...process.env, SENTRY_STUB_OUT: stubOut, SCRY_UPLOAD_BACKOFF_MS: '10', SCRY_TELEMETRY: '', DO_NOT_TRACK: '', NODE_ENV: 'production', CI: '', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const sentry = fs.existsSync(stubOut)
        ? fs.readFileSync(stubOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        : [];
      resolve({ code, out: stdout + stderr, sentry });
    });
  });
}

function expectClean(out) {
  expect(out).not.toMatch(/Usage:|Commands:|Options:|--coverage-execute/);
  expect(out).not.toContain(ESC);
  expect(out).not.toContain(API_KEY);
  expect(out).not.toMatch(/ApiError/); // no raw error object
  expect(out).not.toContain('node_modules'); // no stack frames
}

describe('bin/cli.js failure path (real subprocess)', () => {
  test('401 with request id: Ref line, sanitized message, no help dump, telemetry captured and flushed', async () => {
    respond = (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'x-scry-request-id': REQUEST_ID });
      res.end(JSON.stringify({ error: `\u001b[31mbad key ${API_KEY}\u001b[0m\u001b[2J` }));
    };
    const { code, out, sentry } = await runCli(`http://127.0.0.1:${port}`);
    expect(code).not.toBe(0);
    expect(out).toContain(`Ref: ${REQUEST_ID}`);
    expect(out).toMatch(/Error: Failed to upload file: HTTP 401/);
    expect(out).toContain('bad key');
    expectClean(out);
    expect(sentry).toContainEqual({ captured: 'ApiError' });
    expect(sentry).toContainEqual({ tag: ['request_id', REQUEST_ID] });
    expect(sentry).toContainEqual({ flushed: true });
  }, 30000);

  test('500 with request id: Ref line and server-side suggestion', async () => {
    respond = (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json', 'x-scry-request-id': REQUEST_ID });
      res.end(JSON.stringify({ error: 'boom \u001b[1mbold\u001b[0m' }));
    };
    const { code, out } = await runCli(`http://127.0.0.1:${port}`);
    expect(code).not.toBe(0);
    expect(out).toContain(`Ref: ${REQUEST_ID}`);
    expect(out).toMatch(/HTTP 500/);
    expect(out).toContain('server-side issue');
    expectClean(out);
  }, 60000);

  test('response without the header: no Ref line, still a clean one-line failure', async () => {
    respond = (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    };
    const { code, out } = await runCli(`http://127.0.0.1:${port}`);
    expect(code).not.toBe(0);
    expect(out).not.toContain('Ref:');
    expect(out).toContain('HTTP 401');
    expectClean(out);
  }, 30000);

  test('connection refused: non-zero exit, human message, no help dump', async () => {
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    const { code, out, sentry } = await runCli(`http://127.0.0.1:${closedPort}`);
    expect(code).not.toBe(0);
    expect(out).toMatch(/Error: Failed to upload file/);
    expect(out).not.toContain('Ref:');
    expectClean(out);
    expect(sentry).toContainEqual({ flushed: true });
  }, 60000);

  test('--verbose adds the stack, default does not', async () => {
    respond = (req, res) => {
      res.writeHead(401, { 'x-scry-request-id': REQUEST_ID, 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    };
    const { out } = await runCli(`http://127.0.0.1:${port}`, ['--verbose']);
    expect(out).toContain(`Ref: ${REQUEST_ID}`);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(ESC);
  }, 30000);
});
