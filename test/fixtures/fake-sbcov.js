#!/usr/bin/env node
// A stand-in for @scrymore/scry-sbcov, selected with
//   SCRY_SBCOV_CMD="node test/fixtures/fake-sbcov.js"
// Behaviour comes from FAKE_SBCOV_MODE, following the exit-code contract with
// scry-sbcov (#51):
//   ok        3 stories captured; report + archive; exit 0
//   empty     every story failed after the browser launched; archive with
//             metadata.json = [] (what sbcov writes then); exit 0
//   exit2     broken / unknown capture config; nothing written; exit 2
//   exit3     1 of 3 stories dropped above --max-dropped; report + archive of
//             the 2 that captured; exit 3
//   crash     could not run at all; nothing written; exit 1
//   crash-after-zip  wrote part of an archive, then died; exit 1
//   no-metadata  exit 0 with an archive that has no metadata.json
//   dropped-ignored  1 of 3 dropped, listed in sbcov-manifest.json, but exit 0
//             (an sbcov that ignores --max-dropped)
// Archives carry sbcov-manifest.json {declared, captured, dropped:[...]} like
// sbcov 0.5.2. FAKE_SBCOV_OLD=1 behaves like sbcov <= 0.5.1: no manifest, no
// --max-dropped in --help, and "unknown option" (exit 1) if it is passed.
// FAKE_SBCOV_EXECUTION=1 behaves like sbcov 0.7 (storybook-preview-ci-runtime):
// the manifest carries an `execution` timing block and --help lists
// --concurrency / --render-timeout. FAKE_SBCOV_EXECUTE_MS sets its durationMs
// (default 1200) and the report carries the same block at execution.timing;
// FAKE_SBCOV_SLEEP_MS makes the process take that long.
// FAKE_SBCOV_NO_DURATION=1 leaves execution.summary.duration out of the report.
// FAKE_SBCOV_PAD_BYTES=<n> adds an incompressible images/_pad.png of n bytes to
// the archive (a large library's metadata ZIP).
// FAKE_SBCOV_ARGS_FILE, when set, receives the argv it was called with (JSON).
const fs = require('fs');
const path = require('path');
const archiver = require(require.resolve('archiver', { paths: [path.join(__dirname, '..', '..')] }));

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OLD = process.env.FAKE_SBCOV_OLD === '1';
const EXECUTION = !OLD && process.env.FAKE_SBCOV_EXECUTION === '1';
const EXECUTE_MS = Number(process.env.FAKE_SBCOV_EXECUTE_MS || 1200);
if (argv.includes('--help')) {
  console.log('Usage: scry-sbcov [options]\n  --output <path>\n  --output-zip <path>\n  --screenshots' +
    (OLD ? '' : '\n  --max-dropped <n>  exit 3 when more stories than this are dropped') +
    (process.env.FAKE_SBCOV_DELTA === '1' ? '\n  --delta-manifest  also write the delta bundle beside the metadata ZIP' : '') +
    (EXECUTION ? '\n  --concurrency <n>  stories rendered at once\n  --render-timeout <ms>  how long a story may take to show something' : ''));
  process.exit(0);
}
if (!EXECUTION && (argv.includes('--concurrency') || argv.includes('--render-timeout'))) {
  console.error(`error: unknown option '${argv.includes('--concurrency') ? '--concurrency' : '--render-timeout'}'`);
  process.exit(1);
}
if (OLD && argv.includes('--max-dropped')) {
  console.error("error: unknown option '--max-dropped'");
  process.exit(1);
}
if (process.env.FAKE_SBCOV_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_SBCOV_ARGS_FILE, JSON.stringify(argv));
}

const mode = process.env.FAKE_SBCOV_MODE || 'ok';
const output = opt('--output');
const outputZip = opt('--output-zip');

const STORIES = ['button--primary', 'button--secondary', 'card--default'];

// sbcov 0.7's execution timing block (the manifest's `execution`; the report's `execution.timing`).
function timingBlock(capturedCount, droppedCount) {
  return {
    durationMs: EXECUTE_MS,
    concurrency: 4,
    timeoutMs: 15000,
    renderTimeoutMs: 5000,
    declared: STORIES.length,
    passed: capturedCount,
    failed: STORIES.length - capturedCount,
    timeouts: droppedCount,
    notIndexed: droppedCount,
    timeLostMs: droppedCount ? { render_timeout: 5000 * droppedCount } : {},
    failedTimeShare: droppedCount ? Math.min(1, (5000 * droppedCount) / EXECUTE_MS) : 0,
  };
}

function report({ passed, failures }) {
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalComponents: 2,
      componentsWithStories: 2,
      totalStories: STORIES.length,
      metrics: { componentCoverage: 100, propCoverage: 50, variantCoverage: 50 },
      health: { status: failures.length ? 'broken' : 'healthy', passingStories: passed.length, failingStories: failures.length, passRate: Math.round((passed.length / STORIES.length) * 100) },
    },
    execution: {
      executed: true,
      summary: {
        total: STORIES.length, passed: passed.length, failed: failures.length, skipped: 0,
        // FAKE_SBCOV_NO_DURATION=1: a report that says nothing about time.
        ...(process.env.FAKE_SBCOV_NO_DURATION === '1' ? {} : { duration: 1 }),
      },
      ...(EXECUTION ? { timing: timingBlock(passed.length, failures.length) } : {}),
      stories: [],
      failures: failures.map((storyId) => ({
        storyId,
        componentName: 'Button',
        storyName: storyId,
        failureType: 'render_error',
        message: "browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell",
      })),
    },
    qualityGate: { passed: true, checks: [] },
  };
}

// sbcov with --delta-manifest: delta-manifest.json + delta-files/images/* beside the ZIP (the shared fixture's pictures).
function writeDeltaBundle() {
  const { fixturePictures, sbcovManifest } = require('../helpers/deltaFixtures.js');
  const dir = path.dirname(outputZip);
  const root = path.join(dir, 'delta-files');
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'delta-manifest.json'), JSON.stringify(sbcovManifest()));
  for (const [name, bytes] of Object.entries(fixturePictures())) fs.writeFileSync(path.join(root, name), bytes);
}

function writeZip(entries, dropped = []) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outputZip);
    const a = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    a.on('error', reject);
    a.pipe(out);
    const metadata = entries.map((storyId) => ({ storyId, componentName: 'Button', screenshotPath: `images/${storyId}.png` }));
    a.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
    if (!OLD) {
      a.append(JSON.stringify({
        declared: STORIES.length,
        captured: entries.length,
        dropped: dropped.map((storyId) => ({ storyId, storyTitle: storyId, reason: 'timeout' })),
        capture: { mode: 'root', viewport: '1280x720', scale: 2, source: 'defaults' },
        sbcovVersion: EXECUTION ? '0.7.0-fake' : '0.5.2-fake',
        ...(EXECUTION ? { execution: timingBlock(entries.length, dropped.length) } : {}),
      }), { name: 'sbcov-manifest.json' });
    }
    for (const storyId of entries) a.append(Buffer.from('png'), { name: `images/${storyId}.png` });
    const pad = Number(process.env.FAKE_SBCOV_PAD_BYTES || 0);
    if (pad > 0) a.append(require('crypto').randomBytes(pad), { name: 'images/_pad.png', store: true });
    a.finalize();
  });
}

async function main() {
  const sleepMs = Number(process.env.FAKE_SBCOV_SLEEP_MS || 0);
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  switch (mode) {
    case 'ok':
      fs.writeFileSync(output, JSON.stringify(report({ passed: STORIES, failures: [] })));
      if (outputZip) await writeZip(STORIES);
      if (outputZip && argv.includes('--delta-manifest')) writeDeltaBundle();
      return 0;
    case 'empty':
      fs.writeFileSync(output, JSON.stringify(report({ passed: [], failures: STORIES })));
      if (outputZip) await writeZip([], STORIES);
      return 0;
    case 'exit2':
      console.error('scry-sbcov: unknown capture option "captureModee" in scry-sbcov.config.json');
      return 2;
    case 'exit3': {
      const passed = STORIES.slice(0, 2);
      fs.writeFileSync(output, JSON.stringify(report({ passed, failures: STORIES.slice(2) })));
      if (outputZip) await writeZip(passed, STORIES.slice(2));
      console.log('sbcov: 2/3 stories captured, 1 not indexed (timeout 1)');
      console.error(`scry-sbcov: 1 story dropped, more than --max-dropped ${opt('--max-dropped') ?? '(default)'}`);
      return 3;
    }
    case 'crash-after-zip':
      if (outputZip) await writeZip(STORIES.slice(0, 1));
      console.error('scry-sbcov: killed mid-capture');
      return 1;
    case 'no-metadata': {
      fs.writeFileSync(output, JSON.stringify(report({ passed: STORIES, failures: [] })));
      if (outputZip) {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(outputZip);
          const a = archiver('zip');
          out.on('close', resolve);
          a.on('error', reject);
          a.pipe(out);
          a.append('x', { name: 'images/only.png' });
          a.finalize();
        });
      }
      return 0;
    }
    case 'dropped-ignored': {
      const passed = STORIES.slice(0, 2);
      fs.writeFileSync(output, JSON.stringify(report({ passed, failures: STORIES.slice(2) })));
      if (outputZip) await writeZip(passed, STORIES.slice(2));
      return 0;
    }
    case 'crash':
      console.error('scry-sbcov: Cannot find module typescript');
      return 1;
    default:
      console.error(`fake-sbcov: unknown FAKE_SBCOV_MODE ${mode}`);
      return 99;
  }
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(98); });
