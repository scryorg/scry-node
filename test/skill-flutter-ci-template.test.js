const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// flutter-capture F19: the skill ships a Flutter CI template. Guarantee G5 (the upload can never run for a pull
// request, never on a machine we do not control, only one secret) is checked statically on the file, and the guard
// is itself tested against broken copies. The same rules run in scripts/check-skill-sync.sh.

const TEMPLATE = path.join(__dirname, '..', 'skills', 'scry-native-capture-setup', 'assets', 'flutter', 'scry-capture-flutter.yml');
const DEPLOYER = '@scrymore/scry-deployer@0.11.1';
const DEFAULT_REF = "format('refs/heads/{0}', github.event.repository.default_branch)";
const GATE = `if: github.event_name == 'push' && github.ref == ${DEFAULT_REF}`;
const NOTE_GATE = `if: github.event_name == 'push' && github.ref != ${DEFAULT_REF}`;
const FORBIDDEN_TRIGGERS = ['pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'workflow_run', 'issue_comment', 'repository_dispatch'];
const PIN = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

// Whole-line comments and trailing ` # ...` comments are dropped.
function codeLines(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => (l.includes(' #') ? l.slice(0, l.indexOf(' #')) : l).trimEnd());
}

// A step starts at a line whose text begins with "- " at the step indent (six spaces).
function stepsOf(lines) {
  const steps = [];
  for (const l of lines) {
    if (l.startsWith(`${' '.repeat(6)}- `)) steps.push([]);
    if (steps.length > 0) steps[steps.length - 1].push(l);
  }
  return steps.map((s) => s.join('\n'));
}

const hasKey = (l, key) => l.trim() === key || l.trim().startsWith(`${key} `);

function triggerRules(lines) {
  const out = [];
  const onAt = lines.indexOf('on:');
  const trigger = lines.slice(onAt, onAt + 3);
  if (JSON.stringify(trigger) !== JSON.stringify(['on:', '  push:', '    branches: [main]'])) out.push('push is not limited to branches: [main]');
  const names = lines.map((l) => l.trim().replace(/[:[\]{},]/g, ' ').trim().split(' ')[0]);
  for (const t of FORBIDDEN_TRIGGERS) if (names.includes(t)) out.push(`trigger ${t}`);
  if (lines.some((l) => l.includes('self-hosted'))) out.push('self-hosted runner');
  if (!lines.includes('    runs-on: ubuntu-latest')) out.push('not on a GitHub-hosted ubuntu-latest runner');
  return out;
}

function permissionRules(lines) {
  const out = [];
  const at = lines.indexOf('permissions:');
  if (at < 0 || lines[at + 1] !== '  contents: read' || lines[at + 2].startsWith(' ')) out.push('permissions are not exactly contents: read');
  if (lines.some((l) => l.includes(': write') || l.includes('write-all'))) out.push('write permission');
  if (!lines.includes('          persist-credentials: false')) out.push('checkout without persist-credentials: false');
  if (lines.some((l) => hasKey(l, 'env:') && l.length < 12)) out.push('job or workflow level env');
  return out;
}

function secretRules(lines) {
  const out = [];
  const body = lines.join('\n');
  const refs = body.split('secrets').length - 1;
  const bracket = body.includes('secrets[') || body.includes('inherit');
  if (refs !== 1 || bracket || !body.includes('${{ secrets.SCRY_API_KEY }}')) out.push(`secret references: ${refs}`);
  const withSecret = stepsOf(lines).filter((s) => s.includes('secrets'));
  const upload = withSecret[0] || '';
  if (withSecret.length !== 1 || !upload.includes('name: Upload to Scry')) out.push('secret is not only on the Upload to Scry step');
  if (!upload.includes(GATE)) out.push('upload step is not gated on a push to the repository default branch');
  if (!upload.includes('[ -z "$SCRY_API_KEY" ]') || !upload.includes('[ -z "$SCRY_PROJECT_ID" ]')) out.push('upload step does not test for missing credentials');
  if (!upload.includes('::notice ') || !upload.includes('exit 0')) out.push('upload step does not skip with a notice and exit 0');
  if (lines.some((l) => l.includes('echo') && l.includes('$SCRY_API_KEY'))) out.push('prints the key');
  if (lines.some((l) => l.includes('set -x') || l.includes('bash -x'))) out.push('traces the shell');
  return out;
}

function pinRules(text, lines) {
  const out = [];
  const uses = text.split('\n').filter((l) => !l.trim().startsWith('#') && l.includes('uses:'));
  if (uses.length !== 3) out.push(`expected checkout, setup-node and flutter-action, got ${uses.length}`);
  for (const l of uses) {
    const [ref, comment = ''] = l.slice(l.indexOf('uses:') + 5).trim().split(' # ');
    if (!PIN.test(ref.trim()) || !comment.startsWith('v')) out.push(`not SHA-pinned with a version comment: ${l.trim()}`);
  }
  const npx = lines.filter((l) => l.includes('npx '));
  if (npx.length !== 2) out.push(`expected 2 npx lines (dry-run, upload), got ${npx.length}`);
  for (const l of npx) if (!l.includes(`npx ${DEPLOYER} upload .scry/capture`)) out.push(`deployer not pinned to 0.11.1: ${l.trim()}`);
  if (!lines.some((l) => l.endsWith('upload .scry/capture --dry-run'))) out.push('no secret-free bundle check (--dry-run)');
  return out;
}

function deviceRules(lines) {
  const out = [];
  if (!lines.some((l) => l.endsWith('bash scripts/capture.sh headless'))) out.push('does not run scripts/capture.sh headless');
  const device = ['android-emulator-runner', 'capture.sh android', 'capture.sh ios', 'macos-', 'avdmanager', 'xcrun'];
  if (lines.some((l) => device.some((d) => l.includes(d)))) out.push('ships a device job');
  return out;
}

// Evaluate a step's `if:` expression for one event. Only the subset the template uses is understood: clauses joined
// by `&&`, each `<operand> == <operand>` or `<operand> != <operand>`, an operand being a 'string', a github.* path or
// format('refs/heads/{0}', <github.* path>). Anything else throws, so the template cannot drift past the test.
function operand(text, github) {
  const s = text.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  const fmt = "format('refs/heads/{0}', ";
  if (s.startsWith(fmt) && s.endsWith(')')) return `refs/heads/${operand(s.slice(fmt.length, -1), github)}`;
  if (s.startsWith('github.')) return s.slice('github.'.length).split('.').reduce((o, k) => o[k], github);
  throw new Error(`unsupported expression: ${s}`);
}

function clause(text, github) {
  for (const op of ['==', '!=']) {
    const at = text.indexOf(` ${op} `);
    if (at > -1) {
      const same = operand(text.slice(0, at), github) === operand(text.slice(at + 4), github);
      return op === '==' ? same : !same;
    }
  }
  throw new Error(`unsupported clause: ${text}`);
}

function runsFor(stepText, github) {
  const line = stepText.split('\n').find((l) => l.trim().startsWith('if: '));
  if (!line) return true; // no condition: the step always runs
  return line.trim().slice(4).split(' && ').every((c) => clause(c, github));
}

// Every (pushed branch, default branch) pair where a push reaches the workflow: the upload runs on the default
// branch, and on any other branch the notice step runs, so a push never ends with neither (the silent skip, F71).
// A pull request never runs the upload.
const BRANCHES = ['main', 'trunk', 'master'];
const ghFor = (event_name, branch, def) => ({ event_name, ref: `refs/heads/${branch}`, ref_name: branch, event: { repository: { default_branch: def } } });

function pushGaps(upload, note, branch, def) {
  const gh = ghFor('push', branch, def);
  const up = runsFor(upload, gh);
  const nt = note !== '' && runsFor(note, gh);
  const where = `push to ${branch} with default ${def}`;
  const out = [];
  if (up !== (branch === def)) out.push(`${where}: upload ${up}`);
  if (!up && !nt) out.push(`${where}: no upload and no notice`);
  if (up && nt) out.push(`${where}: upload and the not-default notice both run`);
  return out;
}

function coverageGaps(text) {
  const steps = stepsOf(codeLines(text));
  const upload = steps.find((s) => s.includes('name: Upload to Scry')) || '';
  const note = steps.find((s) => s.includes('::notice title=Scry upload skipped::') && !s.includes('name: Upload to Scry')) || '';
  const out = BRANCHES.flatMap((branch) => BRANCHES.flatMap((def) => pushGaps(upload, note, branch, def)));
  for (const event of ['pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule']) {
    if (runsFor(upload, ghFor(event, 'main', 'main'))) out.push(`upload runs for ${event}`);
  }
  return out;
}

function violations(text) {
  const lines = codeLines(text);
  return [...triggerRules(lines), ...permissionRules(lines), ...secretRules(lines), ...pinRules(text, lines), ...deviceRules(lines), ...coverageGaps(text)];
}

// The upload step's script, extracted from the template, so the skip logic is run for real below.
function uploadScript(text) {
  const lines = codeLines(text);
  const start = lines.findIndex((l) => l.includes('name: Upload to Scry'));
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  const envAt = lines.findIndex((l, i) => i > runAt && l.trim() === 'env:');
  return lines
    .slice(runAt + 1, envAt)
    .map((l) => l.slice(10))
    .join('\n');
}

describe('flutter CI template (G5 guard)', () => {
  const text = fs.readFileSync(TEMPLATE, 'utf8');

  test('the shipped template has no violations', () => {
    expect(violations(text)).toEqual([]);
  });

  test('the capture and the bundle check come before the upload and need no secret', () => {
    const body = codeLines(text).join('\n');
    const at = (s) => body.indexOf(s);
    expect(at('capture.sh headless')).toBeGreaterThan(-1);
    expect(at('capture.sh headless')).toBeLessThan(at('--dry-run'));
    expect(at('--dry-run')).toBeLessThan(at('name: Upload to Scry'));
  });

  test('the upload step exits 0 with a notice when the credentials are missing, and uploads when both are set', () => {
    const script = uploadScript(text);
    expect(script).toContain('npx');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-ci-'));
    const bash = '/bin/bash';
    fs.writeFileSync(path.join(dir, 'npx'), '#!/bin/sh\necho "NPX-CALLED $*"\n', { mode: 0o755 });
    const summary = path.join(dir, 'summary.md');
    const run = (env) =>
      spawnSync(bash, ['-eo', 'pipefail', '-c', script], {
        env: { PATH: `${dir}:/usr/bin:/bin`, GITHUB_STEP_SUMMARY: summary, ...env },
        encoding: 'utf8',
      });
    try {
      for (const env of [{}, { SCRY_API_KEY: 'sk_live_FAKE' }, { SCRY_PROJECT_ID: 'proj_FAKE' }, { SCRY_API_KEY: '', SCRY_PROJECT_ID: '' }]) {
        const r = run(env);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('::notice title=Scry upload skipped::');
        expect(r.stdout).not.toContain('NPX-CALLED');
        expect(r.stdout + r.stderr).not.toContain('sk_live');
      }
      expect(fs.readFileSync(summary, 'utf8')).not.toContain('sk_live');
      const ok = run({ SCRY_API_KEY: 'sk_live_FAKE', SCRY_PROJECT_ID: 'proj_FAKE' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain(`NPX-CALLED ${DEPLOYER} upload .scry/capture`);
      expect(ok.stdout + ok.stderr).not.toContain('sk_live');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a branch rename can never skip the upload silently (F71)', () => {
    expect(coverageGaps(text)).toEqual([]);
    // The trigger renamed to another branch while the repository default stays main: no upload, but a notice.
    const renamed = text.replace('branches: [main]', 'branches: [trunk]');
    expect(renamed).not.toBe(text);
    const steps = stepsOf(codeLines(renamed));
    const note = steps.find((s) => s.includes('Note the skipped upload'));
    const gh = { event_name: 'push', ref: 'refs/heads/trunk', ref_name: 'trunk', event: { repository: { default_branch: 'main' } } };
    expect(runsFor(steps.find((s) => s.includes('name: Upload to Scry')), gh)).toBe(false);
    expect(runsFor(note, gh)).toBe(true);
    expect(note).toContain('::notice title=Scry upload skipped::');
    // The same rename to the default branch needs no second edit: the upload runs.
    expect(runsFor(steps.find((s) => s.includes('name: Upload to Scry')), { ...gh, event: { repository: { default_branch: 'trunk' } } })).toBe(true);
    // The notice step reads no secret and takes the branch names from env, not from the script text.
    expect(note).not.toContain('secrets');
    expect(note.split('        env:')[0].replace(NOTE_GATE, '')).not.toContain('${{');
    expect(note).toContain(NOTE_GATE);
  });

  describe('the guard fails on a broken copy', () => {
    const pinned = text.split('\n').find((l) => l.includes('actions/checkout@')).trim();
    const cases = {
      'pull_request trigger': (t) => t.replace('on:\n  push:', 'on:\n  pull_request:\n  push:'),
      'pull_request_target trigger': (t) => t.replace('on:\n  push:', 'on:\n  pull_request_target:\n  push:'),
      'workflow_dispatch trigger': (t) => t.replace('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'),
      'push to any branch': (t) => t.replace('branches: [main]', "branches: ['**']"),
      'self-hosted runner': (t) => t.replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, linux]'),
      'unpinned action': (t) => t.replace(pinned.slice(pinned.indexOf('actions/')), 'actions/checkout@v4'),
      'pin without version comment': (t) => t.replace(' # v2.23.0', ''),
      'second secret': (t) => t.replace('${{ vars.SCRY_PROJECT_ID }}', '${{ secrets.SCRY_PROJECT_ID }}'),
      'job-level env hands the key to every step': (t) =>
        t.replace('    timeout-minutes: 30\n', '    timeout-minutes: 30\n    env:\n      SCRY_API_KEY: ${{ secrets.SCRY_API_KEY }}\n'),
      'upload without the default-branch guard': (t) => t.replace(`        ${GATE}\n`, ''),
      'upload gated on a hard-coded main (the F71 silent skip)': (t) => t.replace(GATE, "if: github.event_name == 'push' && github.ref == 'refs/heads/main'"),
      'no notice step for a push to a non-default branch': (t) => t.replace(/ {6}# The same trigger on a branch[\s\S]*?(?= {6}# Device path)/, ''),
      'notice step never runs': (t) => t.replace(NOTE_GATE, "if: github.event_name == 'pull_request'"),
      'upload also runs for a pull request': (t) => t.replace(GATE, `if: github.ref == ${DEFAULT_REF}`),
      'write permission': (t) => t.replace('contents: read', 'contents: write'),
      'checkout keeps credentials': (t) => t.replace('persist-credentials: false', 'persist-credentials: true'),
      'deployer unpinned': (t) => t.replace(`npx ${DEPLOYER} upload .scry/capture\n        env`, 'npx @scrymore/scry-deployer upload .scry/capture\n        env'),
      'missing credentials fail the run': (t) => t.replace('            exit 0\n', '            exit 1\n'),
      'no skip test': (t) => t.replace('[ -z "$SCRY_API_KEY" ] ||', '[ -z "$OTHER" ] ||'),
      'prints the key': (t) => t.replace(`          npx ${DEPLOYER} upload .scry/capture\n        env`, `          echo "$SCRY_API_KEY"\n          npx ${DEPLOYER} upload .scry/capture\n        env`),
      'ships an emulator job': (t) => t.replace('capture.sh headless', 'capture.sh android'),
    };
    test.each(Object.keys(cases))('%s', (name) => {
      const broken = cases[name](text);
      expect(broken).not.toBe(text); // the mutation applied
      expect(violations(broken).length).toBeGreaterThan(0);
    });
  });
});
