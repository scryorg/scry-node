const {
  scrub,
  sanitizeArgv,
  telemetryDisabled,
  SAFE_ARGV_FIELDS,
  redactArgv,
  scrubBreadcrumb,
} = require('../lib/telemetry.js');

/**
 * This CLI runs on customers' machines, so every field it reports left someone
 * else's laptop or CI runner. Three things were being sent that should not
 * have been, and these tests exist to keep them out.
 */
describe('scrub', () => {
  // The upload error message embeds the presigned URL in full. That query
  // string is a time-limited write credential for the bucket.
  it('removes the signature from a presigned URL but keeps the path', () => {
    const message =
      'No response received from https://bucket.r2.cloudflarestorage.com/p/v/storybook.zip' +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=645e571c8c169bf1&X-Amz-Expires=3600 (EAI_AGAIN)';

    const out = scrub(message);

    expect(out).not.toContain('645e571c8c169bf1');
    expect(out).not.toContain('X-Amz-Algorithm');
    // Still identifies which object failed, which is the diagnostic value.
    expect(out).toContain('storybook.zip');
    expect(out).toContain('<redacted>');
  });

  it('removes a project API key wherever it appears', () => {
    expect(scrub('key scry_proj_U9m2H2yeC9wFiR4hlMta_abc-123 rejected'))
      .toBe('key scry_proj_<redacted> rejected');
  });

  it('removes bearer tokens', () => {
    expect(scrub('Authorization: Bearer eyJhbGciOi.J9.xyz')).toContain('Bearer <redacted>');
  });

  it('leaves ordinary messages untouched', () => {
    const plain = 'Failed to upload file: connection reset (ECONNRESET)';
    expect(scrub(plain)).toBe(plain);
  });

  it('passes through non-strings rather than throwing', () => {
    expect(scrub(undefined)).toBeUndefined();
    expect(scrub(42)).toBe(42);
  });
});

describe('sanitizeArgv', () => {
  const argv = {
    _: ['deploy'],
    project: 'U9m2H2yeC9wFiR4hlMta',
    apiKey: 'scry_proj_SECRET',
    'api-key': 'scry_proj_SECRET',
    dir: '/home/alice/work/unreleased-product',
    deployVersion: 'v1.2.3',
    apiUrl: 'https://upload.example.com',
  };

  // The bug this whole module exists for: setExtra('argv', argv) sent the key.
  it('never includes the API key, under either spelling', () => {
    const safe = sanitizeArgv(argv);
    expect(safe.apiKey).toBeUndefined();
    expect(safe['api-key']).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('SECRET');
  });

  // Absolute paths carry the developer's username and often the name of an
  // unannounced product.
  it('never includes local filesystem paths', () => {
    const safe = sanitizeArgv(argv);
    expect(safe.dir).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('/home/alice');
  });

  it('keeps the fields that make an error diagnosable', () => {
    const safe = sanitizeArgv(argv);
    expect(safe.project).toBe('U9m2H2yeC9wFiR4hlMta');
    expect(safe.deployVersion).toBe('v1.2.3');
  });

  // An allowlist means a newly added option is invisible until someone opts it
  // in. A denylist would require remembering to exclude each new secret, which
  // is precisely how the API key got through.
  it('excludes anything not explicitly allowlisted', () => {
    const safe = sanitizeArgv({ ...argv, someNewSecretOption: 'oops' });
    expect(safe.someNewSecretOption).toBeUndefined();
    expect(Object.keys(safe).every((k) => SAFE_ARGV_FIELDS.includes(k))).toBe(true);
  });

  it('handles a missing argv', () => {
    expect(sanitizeArgv(undefined)).toEqual({});
  });
});

describe('telemetryDisabled', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is on by default in a production run', () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.SCRY_TELEMETRY;
    delete process.env.CI;
    process.env.NODE_ENV = 'production';
    expect(telemetryDisabled()).toBe(false);
  });

  // sentry-quota-noise: our own suites and CI jobs fail on purpose and routinely.
  it('is off under NODE_ENV=test and when CI is set, but not for an explicit false CI', () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.SCRY_TELEMETRY;
    delete process.env.CI;
    process.env.NODE_ENV = 'test';
    expect(telemetryDisabled()).toBe(true);
    process.env.NODE_ENV = 'production';
    for (const ci of ['true', '1', 'yes']) {
      process.env.CI = ci;
      expect(telemetryDisabled()).toBe(true);
    }
    for (const ci of ['', '0', 'false', 'FALSE']) {
      process.env.CI = ci;
      expect(telemetryDisabled()).toBe(false);
    }
  });

  it('honours SCRY_TELEMETRY=0', () => {
    process.env.SCRY_TELEMETRY = '0';
    expect(telemetryDisabled()).toBe(true);
  });

  // The cross-tool convention. Someone who sets it globally should not have to
  // find a Scry-specific variable to be heard.
  it('honours DO_NOT_TRACK=1', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(telemetryDisabled()).toBe(true);
  });
});

// Gap 4 of the 2026-09-26 observability audit: argv went out as a breadcrumb,
// and breadcrumbs were never scrubbed.
describe('credential flags, fields and env echoes', () => {
  const KEY = 'bogus-canary-91ab';

  it.each([
    [`deploy --api-key ${KEY} --verbose`],
    [`deploy --api-key=${KEY}`],
    [`deploy -k ${KEY}`],
    [`deploy --token ${KEY}`],
    [`deploy --openai-api-key ${KEY}`],
    [`{"apiKey":"${KEY}","project":"p"}`],
    [`{"api-key": "${KEY}"}`],
    [`SCRY_API_KEY=${KEY} npx scry-deployer`],
    [`STORYBOOK_DEPLOYER_API_KEY=${KEY}`],
  ])('scrub masks %s', (input) => {
    const out = scrub(input);
    expect(out).not.toContain(KEY);
    expect(out).toContain('<redacted>');
  });

  it('redactArgv masks every credential-named field but keeps the rest', () => {
    const out = redactArgv({
      _: ['deploy'], apiKey: KEY, 'api-key': KEY, commitApiKey: KEY, jinaApiKey: KEY, k: KEY,
      project: 'p1', dir: './storybook-static', verbose: true,
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.project).toBe('p1');
    expect(out.dir).toBe('./storybook-static');
    expect(out.verbose).toBe(true);
  });

  it('scrubBreadcrumb cleans the message and nested data', () => {
    const crumb = scrubBreadcrumb({
      category: 'console',
      message: `Received arguments: {"apiKey":"${KEY}"}`,
      data: { arguments: [`--api-key ${KEY}`], extra: { token: KEY } },
    });
    expect(JSON.stringify(crumb)).not.toContain(KEY);
    expect(crumb.category).toBe('console');
  });
});
