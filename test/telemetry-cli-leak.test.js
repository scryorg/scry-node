/**
 * Gap 4 of scry-management/research/observability-audit-2026-09-26.md.
 *
 * Every deploy logged the whole argv as a Sentry breadcrumb
 * ("Received arguments: {...}", bin/cli.js) and beforeSend only scrubbed the
 * event, never its breadcrumbs, so the customer's API key rode along with any
 * later error report.
 *
 * This runs the real runDeployment with a bogus key and a forced upload
 * failure, reports the error the way handleError does, and reads what a stub
 * Sentry transport received.
 */
// Order matters: the capture transport has to patch Sentry.init first.
const { sentText, sentEvents } = require('./fixtures/sentry-capture-transport');

jest.mock('../lib/apiClient.js', () => ({
  getApiClient: jest.fn(() => ({})),
  uploadBuild: jest.fn(async () => {
    const err = new Error('Failed to upload file: forced failure for the leak test');
    err.statusCode = 500;
    throw err;
  }),
}));

const path = require('path');
const { initTelemetry, captureCliError, flushTelemetry } = require('../lib/telemetry.js');
const { runDeployment } = require('../bin/cli.js');
const { version } = require('../package.json');

// Deliberately not shaped like scry_proj_*, so the scrubber's key pattern is
// not what saves us: redaction has to be by field name.
const BOGUS_KEY = 'bogus-leak-canary-7f3a9c2e5d1b';
const OTHER_SECRET = 'bogus-commit-canary-44c1e0';

describe('CLI never sends the API key to Sentry', () => {
  const saved = {
    DO_NOT_TRACK: process.env.DO_NOT_TRACK, SCRY_TELEMETRY: process.env.SCRY_TELEMETRY,
    NODE_ENV: process.env.NODE_ENV, CI: process.env.CI,
  };
  let logSpy;

  beforeAll(async () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.SCRY_TELEMETRY;
    // Telemetry is off under tests and CI (sentry-quota-noise); this test needs it on to read what would be sent.
    delete process.env.CI;
    process.env.NODE_ENV = 'production';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(initTelemetry()).toBe(true);

    const argv = {
      _: ['deploy'],
      dir: path.join(__dirname, '..', 'test-storybook-static'),
      project: 'leak-test-project',
      version: 'v1',
      apiKey: BOGUS_KEY,
      'api-key': BOGUS_KEY,
      commitApiKey: OTHER_SECRET,
      apiUrl: 'https://example.invalid',
      coverage: false,
      verbose: true,
    };

    let error;
    try {
      await runDeployment(argv);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    // What handleError does.
    captureCliError(error, argv);
    await flushTelemetry(2000);
  });

  afterAll(() => {
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('the forced error was reported, with the argv breadcrumb behind it', () => {
    const events = sentEvents();
    expect(events).toHaveLength(1);
    const crumbs = events[0].breadcrumbs || [];
    expect(crumbs.some((b) => /Received arguments/.test(b.message || ''))).toBe(true);
    // The verbose console line is a breadcrumb too (Sentry's console integration).
    expect(logSpy).toHaveBeenCalled();
  });

  test('no event or breadcrumb contains the API key or other secrets', () => {
    const text = sentText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(BOGUS_KEY);
    expect(text).not.toContain(OTHER_SECRET);
  });

  test('the argv breadcrumb still carries the non-secret fields', () => {
    const crumb = sentEvents()[0].breadcrumbs.find((b) => /Received arguments/.test(b.message || ''));
    expect(crumb.message).toContain('leak-test-project');
    expect(crumb.message).toContain('<redacted>');
  });

  test('events carry the package version as release', () => {
    expect(sentEvents()[0].release).toBe(`@scrymore/scry-deployer@${version}`);
  });
});
