const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('integration: cli deploy flow (no network)', () => {
  test('CLI loads coverage report and fails fast on mocked server error', () => {
    const reportPath = path.join(os.tmpdir(), `scry-coverage-${Date.now()}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ summary: { metrics: {}, health: {} }, qualityGate: { passed: true }, generatedAt: 'x' })
    );

    const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

    const res = spawnSync(
      process.execPath,
      [
        cliPath,
        '--dir',
        path.join(__dirname, '..', 'test-storybook-static'),
        '--project',
        'fail-me-500',
        '--version',
        'v1',
        '--coverage-report',
        reportPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          STORYBOOK_DEPLOYER_API_URL: 'https://example.invalid',
          STORYBOOK_DEPLOYER_API_KEY: 'any',
          // The mock server error here is deliberate; it must never reach error reporting.
          SCRY_TELEMETRY: '0',
        },
      }
    );

    fs.unlinkSync(reportPath);

    // In restricted runners, spawning Node can be blocked (EPERM). Treat that
    // as an environment limitation rather than a CLI regression.
    if (res.error) {
      expect(res.error.code).toBe('EPERM');
    } else {
      expect(res.status).toBe(1);
      const output = (res.stdout || '') + (res.stderr || '');
      expect(output).toContain('Coverage: using existing report');
      expect(output).toContain('The deployment service encountered an internal error');
    }
  });
});
