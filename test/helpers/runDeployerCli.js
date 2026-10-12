// Runs the real CLI (bin/cli.js) in a child process against the local stub
// upload service and the fake scry-sbcov, with a clean environment: no API
// URL from the developer's shell, no GitHub context, no telemetry, no npm
// version check.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startStub } = require('../fixtures/stub-upload-service.js');
const { startDeltaStub } = require('./deltaStub.js');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const FAKE_SBCOV = path.join(ROOT, 'test', 'fixtures', 'fake-sbcov.js');
const STORYBOOK_DIR = path.join(ROOT, 'test', 'fixtures', 'storybook-static');

async function runDeployerCli({ args = [], sbcovMode = 'ok', metadata = 'ok', ciTimings = 'ok', actionsApi = 'ok', metadataRate = 0, presign = 'none', metadataPut = 'ok', metadataComplete = 'ok', env = {}, configFile = null, command = null, delta = null } = {}) {
  // delta: options for the /delta stub (test/helpers/deltaStub.js); null = no /delta route (an upload service without it).
  const deltaStub = delta ? await startDeltaStub(delta) : null;
  const stub = await startStub({ metadata, ciTimings, actionsApi, metadataRate, presign, metadataPut, metadataComplete, delegate: deltaStub ? deltaStub.url : null });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-deployer-e2e-'));
  const argsFile = path.join(cwd, 'sbcov-args.json');
  if (configFile) fs.writeFileSync(path.join(cwd, '.storybook-deployer.json'), configFile);
  const childEnv = {
    PATH: process.env.PATH,
    HOME: cwd,
    TMPDIR: os.tmpdir(),
    SCRY_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    SCRY_NO_UPDATE_CHECK: '1',
    SCRY_SBCOV_CMD: `node ${FAKE_SBCOV}`,
    FAKE_SBCOV_MODE: sbcovMode,
    FAKE_SBCOV_ARGS_FILE: argsFile,
    ...(typeof env === 'function' ? env(stub.url) : env),
  };
  const fullArgs = command === 'coverage'
    ? [CLI, 'coverage', '--dir', STORYBOOK_DIR, '--output', path.join(cwd, 'report.json'), ...args]
    : [
      CLI,
      '--dir', STORYBOOK_DIR,
      '--api-url', stub.url,
      '--api-key', 'test-key-not-a-credential',
      '--project', 'fixture',
      '--deploy-version', 'main',
      ...args,
    ];
  try {
    const { code, out } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, fullArgs, { cwd, env: childEnv });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', (c) => resolve({ code: c, out }));
    });
    const sbcovArgs = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null;
    return {
      code,
      out,
      sbcovArgs,
      requests: stub.requests.slice(),
      failed: stub.failed.slice(),
      deltaRequests: deltaStub ? deltaStub.requests.slice() : [],
      deltaStorageRequests: deltaStub ? deltaStub.storageRequests.slice() : [],
      sentMetadata: stub.requests.some((r) => r.method === 'POST' && /\/metadata$/.test(r.path)),
      hostedStorybook: stub.requests.some((r) => r.method === 'PUT' && /storybook\.zip$/.test(r.path)),
    };
  } finally {
    await stub.close();
    if (deltaStub) await deltaStub.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

module.exports = { runDeployerCli, STORYBOOK_DIR, FAKE_SBCOV, ROOT };
