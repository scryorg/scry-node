/**
 * Bug: sentry-quota-noise (ISSUES #87). The CLI reported every error that reached
 * handleError to Sentry, including the user's own mistakes (missing folder, no
 * images, missing env var), and tests and CI sent too. 4,998 free-tier events
 * later the quota was gone.
 *
 * These tests drive the real CLI entry point (`main()` on a fake argv) with
 * Sentry's network transport swapped for a recorder, so they assert the symptom
 * a user or the quota sees: exit code, printed message and the number of events
 * sent, not how the code is organised.
 *
 *   guarantee-1  a user's own mistake never sends an event, exit code and message unchanged
 *   guarantee-2  an unexpected crash still sends exactly one event in production mode
 *   guarantee-4  test, CI, SCRY_TELEMETRY=0 and DO_NOT_TRACK send nothing
 */
// Order matters: the capture transport has to patch Sentry.init first.
const { sentEvents } = require('./fixtures/sentry-capture-transport');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { main } = require('../bin/cli.js');

const TELEMETRY_ENV = ['NODE_ENV', 'CI', 'SCRY_TELEMETRY', 'DO_NOT_TRACK'];
// Variables the CLI would otherwise read as configuration, so a developer's shell cannot change a case.
const CONFIG_ENV = [
  'STORYBOOK_DEPLOYER_DIR', 'STORYBOOK_DEPLOYER_PROJECT', 'STORYBOOK_DEPLOYER_API_KEY', 'STORYBOOK_DEPLOYER_API_URL',
  'GEMINI_API_KEY', 'JINA_API_KEY', 'OPENAI_API_KEY', 'MILVUS_ADDRESS', 'MILVUS_TOKEN', 'MILVUS_COLLECTION',
  'MILVUS_COLLECTION_G2',
];

/** Production as a customer's machine sees it: no test flag, no CI, no opt-out. */
function productionEnv() {
  for (const k of TELEMETRY_ENV) delete process.env[k];
  process.env.NODE_ENV = 'production';
}

describe('sentry-quota-noise: CLI telemetry', () => {
  const saved = {};
  let tmp;
  let emptyDir;
  let aFile;
  let cwd;
  let exitSpy;
  let output;

  beforeAll(() => {
    for (const k of [...TELEMETRY_ENV, ...CONFIG_ENV]) saved[k] = process.env[k];
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-sqn-'));
    emptyDir = path.join(tmp, 'no-images');
    fs.mkdirSync(emptyDir);
    aFile = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(aFile, 'not a directory');
    // A clean working directory: no config file of ours can add a --dir.
    process.chdir(tmp);
  });

  afterAll(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    for (const k of CONFIG_ENV) delete process.env[k];
    productionEnv();
    output = [];
    const grab = (...a) => { output.push(a.join(' ')); };
    jest.spyOn(console, 'log').mockImplementation(grab);
    jest.spyOn(console, 'error').mockImplementation(grab);
    jest.spyOn(console, 'warn').mockImplementation(grab);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Run the real CLI on a fake argv; returns the events it sent. */
  async function run(args) {
    const before = sentEvents().length;
    const prevArgv = process.argv;
    process.argv = ['node', 'scry', ...args];
    try {
      await main();
    } finally {
      process.argv = prevArgv;
    }
    return sentEvents().slice(before);
  }

  const text = () => output.join('\n');

  // The messages a user can cause on their own, one row per message and per command that throws it.
  // (The two "--dir is required" throws are not reachable from argv: deploy defaults --dir and
  // upload-images has yargs require it, so they are only converted, not driven.)
  const USER_MISTAKES = [
    ['deploy: directory not found', ['--dir', '/scry-sqn/does-not-exist'], /Directory not found at path: \/scry-sqn\/does-not-exist/],
    ['deploy: path is a file', ['--dir', 'a-file.txt'], /Path is not a directory: a-file\.txt/],
    ['upload-images: directory not found', ['upload-images', '--project', 'p', '--dir', '/scry-sqn/does-not-exist'], /Directory not found: \/scry-sqn\/does-not-exist/],
    ['upload-images: path is a file', ['upload-images', '--project', 'p', '--dir', 'a-file.txt'], /Path is not a directory: a-file\.txt/],
    ['upload-images --local: key env var missing', ['upload-images', '--dir', 'no-images', '--project', 'p', '--local'], /env var is required for local mode/],
    [
      'upload-images --local: no image files',
      ['upload-images', '--dir', 'no-images', '--project', 'p', '--local', '--gemini-api-key', 'g', '--openai-api-key', 'o',
        '--milvus-address', 'https://m.invalid', '--milvus-token', 't', '--collection', 'c_g2'],
      /No image files \(\.png, \.jpg, \.jpeg\) found in: no-images/,
    ],
    [
      'upload-images (queue): no image files',
      ['upload-images', '--dir', 'no-images', '--project', 'p', '--api-key', 'k', '--api-url', 'https://example.invalid'],
      /No image files \(\.png, \.jpg, \.jpeg\) found in: no-images/,
    ],
  ];

  describe('guarantee-1: a user mistake never uses Sentry quota', () => {
    test.each(USER_MISTAKES)('%s -> message and exit 1, 0 events', async (_label, args, message) => {
      const events = await run(args);

      // Acceptance row 3: the user sees what they saw before, and the exit code is unchanged.
      expect(text()).toMatch(message);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(events).toHaveLength(0);
    });
  });

  describe('guarantee-2: a real crash is still reported', () => {
    test('an unexpected thrown error sends exactly 1 event in production mode', async () => {
      const events = await run(['debug-sentry']);

      expect(text()).toMatch(/Sentry debug error from scry-node CLI/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(events).toHaveLength(1);
      expect(events[0].exception.values[0].value).toBe('Sentry debug error from scry-node CLI');
      expect(events[0].environment).toBe('production');
    });

    test('a server error from the API is a crash, not a user mistake: 1 event', async () => {
      const { ApiError } = require('../lib/errors.js');
      const { captureCliError, initTelemetry, flushTelemetry } = require('../lib/telemetry.js');
      const before = sentEvents().length;
      expect(initTelemetry()).toBe(true);
      captureCliError(new ApiError('The deployment service encountered an internal error', 500, 'REQ12345678'), { _: ['deploy'] });
      await flushTelemetry(2000);
      expect(sentEvents().length - before).toBe(1);
    });
  });

  describe('guarantee-4: tests, CI and opt-outs never use Sentry quota', () => {
    // The same crash that sends 1 event in production mode (guarantee-2) must send none here.
    test.each([
      ['NODE_ENV=test', { NODE_ENV: 'test' }],
      ['CI=true', { CI: 'true' }],
      ['CI=1', { CI: '1' }],
      ['SCRY_TELEMETRY=0', { SCRY_TELEMETRY: '0' }],
      ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
    ])('%s: a real crash sends 0 events', async (_label, env) => {
      Object.assign(process.env, env);

      const events = await run(['debug-sentry']);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(events).toHaveLength(0);
    });

    test('CI=false and CI=0 do not silence a customer who has CI set to a false value', async () => {
      process.env.CI = 'false';
      expect(await run(['debug-sentry'])).toHaveLength(1);
      process.env.CI = '0';
      expect(await run(['debug-sentry'])).toHaveLength(1);
    });
  });
});
