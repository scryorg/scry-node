describe('lib/templates workflow generation', () => {
  test('generateMainWorkflow() includes fetch-depth and coverage flags', () => {
    const { generateMainWorkflow } = require('../lib/templates.js');

    const yml = generateMainWorkflow('p', 'https://api', 'pnpm', 'build-storybook');

    expect(yml).toContain('fetch-depth: 0');
    expect(yml).toContain('SCRY_COVERAGE_ENABLED');
    expect(yml).toContain('--coverage-fail-on-threshold');
    expect(yml).toContain('GITHUB_TOKEN');
  });

  test('generatePRWorkflow() skips drafts and has no github-script comment step', () => {
    const { generatePRWorkflow } = require('../lib/templates.js');

    const yml = generatePRWorkflow('p', 'https://api', 'pnpm', 'build-storybook');

    expect(yml).toContain('fetch-depth: 0');
    expect(yml).toContain('github.event.pull_request.draft');
    expect(yml).toContain('--coverage-fail-on-threshold');
    expect(yml).toContain('GITHUB_TOKEN');

    // Commenting is now handled by the CLI
    expect(yml).not.toContain('actions/github-script');
  });
});

describe('workflow template snapshots and reference copies (ISSUES.md #50)', () => {
  const { generateMainWorkflow, generatePRWorkflow } = require('../lib/templates.js');

  test.each(['npm', 'pnpm', 'yarn'])('main workflow for %s matches the snapshot', (pm) => {
    expect(generateMainWorkflow('', '', pm, 'build-storybook')).toMatchSnapshot();
  });

  test.each(['npm', 'pnpm', 'yarn'])('PR workflow for %s matches the snapshot', (pm) => {
    expect(generatePRWorkflow('', '', pm, 'build-storybook')).toMatchSnapshot();
  });

  // The copies in templates/workflows went stale once (no browser step, bare
  // npx) while the generator moved on. They are now generated; this fails
  // when they drift. Fix with: node scripts/regenerate-workflow-templates.js
  test('templates/workflows/*.yml match the generator', () => {
    const fs = require('fs');
    const path = require('path');
    const { files, dir } = require('../scripts/regenerate-workflow-templates.js');
    for (const [name, body] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(body);
    }
    const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).sort();
    expect(onDisk).toEqual(Object.keys(files).sort());
  });
});

describe('--capture web workflows (build-free capture for any qualifying project)', () => {
  const templates = require('../lib/templates.js');
  const { generateMainWorkflow, generatePRWorkflow } = templates;
  const capture = (pm = 'npm', options) => templates.generateCaptureWebWorkflow(pm, options);

  test.each(['npm', 'pnpm', 'yarn', 'bun'])('capture workflow for %s matches the snapshot', (pm) => {
    expect(capture(pm)).toMatchSnapshot();
  });

  test('installs the deployer from npm at the first release with the command, never from git', () => {
    const yml = capture();
    expect(templates.CAPTURE_WEB_DEPLOYER_RANGE).toBe('^0.14.0');
    expect(yml).toContain('--prefix "$RUNNER_TEMP/scry" @scrymore/scry-deployer@^0.14.0');
    expect(yml).not.toMatch(/github:|git\+|#[0-9a-f]{40}|SCRY_NODE_SHA/);
    // A stale cached packument on a persistent runner gave ETARGET with this flag.
    expect(yml).not.toMatch(/npm i [^\n]*--prefer-offline/);
    expect(yml).toContain('--ignore-scripts');
  });

  test('runs on ubuntu-24.04 with a bounded job and read-only permissions', () => {
    const yml = capture();
    expect(yml).toContain('runs-on: ubuntu-24.04');
    expect(yml).not.toContain('ubuntu-latest');
    expect(yml).toMatch(/timeout-minutes: \d+/);
    expect(yml).toContain("node-version: '20'");
    expect(yml).toMatch(/permissions:\n {6}contents: read\n/);
    expect(yml).not.toMatch(/: write/);
    expect(yml).toContain('persist-credentials: false');
  });

  test.each([
    ['npm', 'npx --no-install playwright install --with-deps chromium'],
    ['pnpm', 'pnpm exec playwright install --with-deps chromium'],
    ['yarn', 'yarn run playwright install --with-deps chromium'],
    ['bun', 'npx --no-install playwright install --with-deps chromium'],
  ])('%s: Chromium comes from the project\'s own Playwright', (pm, line) => {
    const yml = capture(pm);
    expect(yml).toContain(`run: ${line}\n`);
    // Not the deployer's Playwright: capture web resolves playwright from the project.
    expect(yml).not.toContain('working-directory: ${{ runner.temp }}/scry');
    expect(yml).not.toContain('chromium-headless-shell');
  });

  test('captures, then uploads with the same secret and variable names as the deploy workflows', () => {
    const yml = capture();
    const at = (text) => {
      expect(yml).toContain(text);
      return yml.indexOf(text);
    };
    const captureAt = at('scry-deployer" capture web');
    const uploadAt = at('scry-deployer" upload "$RUNNER_TEMP/capture" --deploy-version "${GITHUB_SHA::12}"');
    expect(captureAt).toBeLessThan(uploadAt);
    expect(yml).toContain('--out "$RUNNER_TEMP/capture"');
    expect(yml).toContain('--max-dropped "${SCRY_MAX_DROPPED:-0}"');
    expect(yml).toContain('SCRY_MAX_DROPPED: ${{ vars.SCRY_MAX_DROPPED }}');
    expect(yml).toContain('STORYBOOK_DEPLOYER_API_URL: ${{ vars.SCRY_API_URL }}');
    expect(yml).toContain('STORYBOOK_DEPLOYER_PROJECT: ${{ vars.SCRY_PROJECT_ID }}');
    expect(yml).toContain('STORYBOOK_DEPLOYER_API_KEY: ${{ secrets.SCRY_API_KEY }}');
    // The key is given to the upload step only, never to the step that runs the project's stories.
    expect(yml.split('secrets.SCRY_API_KEY')).toHaveLength(2);
    expect(yml.indexOf('secrets.SCRY_API_KEY')).toBeGreaterThan(uploadAt);
    // Never a changed-only or subset run: that is a partial bundle.
    expect(yml).not.toMatch(/--changed-since|--stories|--allow-partial-bundle/);
  });

  test('uploads on a push; a manual run on another branch only validates', () => {
    const yml = capture();
    expect(yml).toMatch(/on:\n {2}push:\n {4}branches: \[main, master\]\n {2}workflow_dispatch:\n/);
    expect(yml).toContain("if: ${{ github.event_name == 'push' || github.ref_name == github.event.repository.default_branch }}");
    expect(yml).toContain("if: ${{ github.event_name != 'push' && github.ref_name != github.event.repository.default_branch }}");
    expect(yml).toContain('--dry-run');
    expect(yml).toContain('cancel-in-progress: false');
  });

  test('a config directory other than .storybook is passed through; an unsafe one is refused', () => {
    expect(capture('npm')).not.toContain('--config-dir');
    expect(capture('npm', { configDir: '.storybook' })).toBe(capture('npm'));
    expect(capture('npm', { configDir: './.storybook/' })).toBe(capture('npm'));
    expect(capture('npm', { configDir: 'apps/web/.storybook-vitest' })).toContain("--config-dir 'apps/web/.storybook-vitest' \\\n");
    for (const bad of ['a b', '$(id)', "x'y", '../up', '/abs', '-rf', 'a;b', 'a\nb']) {
      expect(() => capture('npm', { configDir: bad })).toThrow(/config-dir/);
    }
  });

  test('pnpm: not the deploy workflows\' pnpm 8 pin', () => {
    // No packageManager field known: pnpm 10, which reads a version 9 lockfile.
    expect(capture('pnpm')).toMatch(/uses: pnpm\/action-setup@v4\n {8}with:\n {10}# .*\n {10}version: 10\n/);
    expect(capture('pnpm', { pnpm: { version: '8' } })).toMatch(/^ {10}version: 8$/m);
    // Only digits reach the file.
    expect(capture('pnpm', { pnpm: { version: '9; rm -rf /' } })).toMatch(/^ {10}version: 10$/m);
    // "packageManager" in package.json: the action reads it, so no version is written.
    const pinned = capture('pnpm', { pnpm: { fromPackageJson: true } });
    expect(pinned).toContain('uses: pnpm/action-setup@v4\n      - name: Setup Node.js');
    expect(pinned).not.toMatch(/^ {10}version:/m);
    for (const yml of [capture('pnpm'), pinned]) {
      expect(yml).toContain("cache: 'pnpm'");
      expect(yml).toContain('run: CI=false pnpm install');
      expect(yml).toContain('run: pnpm exec playwright install --with-deps chromium');
      expect(yml).not.toContain('action-setup@v2');
    }
  });

  test('yarn and bun install with the project\'s own package manager', () => {
    const yarn = capture('yarn');
    expect(yarn).toContain("cache: 'yarn'");
    expect(yarn).toContain('run: yarn install');
    expect(yarn).toContain('run: yarn run playwright install --with-deps chromium');
    expect(yarn).not.toContain('corepack');
    // Yarn 2+ named in "packageManager": Corepack, before setup-node.
    const berry = capture('yarn', { corepack: true });
    expect(berry.indexOf('run: corepack enable')).toBeGreaterThan(0);
    expect(berry.indexOf('run: corepack enable')).toBeLessThan(berry.indexOf('uses: actions/setup-node@v4'));

    const bun = capture('bun');
    expect(bun).toContain('uses: oven-sh/setup-bun@v2');
    expect(bun).toContain('run: bun install');
    // setup-node caches npm, yarn and pnpm only; any other value stops the step.
    expect(bun).not.toMatch(/^ {10}cache:/m);
  });

  test('main workflow with capture web hosts and measures coverage but does not capture again', () => {
    const plain = generateMainWorkflow('', '', 'npm', 'build-storybook');
    const yml = generateMainWorkflow('', '', 'npm', 'build-storybook', { capture: 'web' });
    expect(plain).toContain('--with-analysis');
    expect(yml).not.toContain('--with-analysis');
    expect(yml).toContain('            --no-analysis \\\n');
    // Hosting, coverage and its settings stay exactly as they were.
    for (const kept of ['--dir ./storybook-static', 'SCRY_COVERAGE_ENABLED', '--coverage-execute', '--coverage-fail-on-threshold', '--coverage-base', 'npm run build-storybook', 'fetch-depth: 0']) {
      expect(yml).toContain(kept);
    }
    // Regenerating must not silently bring the second capture back.
    expect(yml).toContain('Regenerate with: npx -y @scrymore/scry-deployer@^0.14.0 update-workflows --capture web');
    expect(yml).toContain('scry-capture-web.yml');
  });

  test('without the option both existing workflows are byte-for-byte what they were', () => {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
      const main = generateMainWorkflow('', '', pm, 'build-storybook');
      expect(generateMainWorkflow('', '', pm, 'build-storybook', {})).toBe(main);
      expect(generateMainWorkflow('', '', pm, 'build-storybook', { capture: undefined })).toBe(main);
      expect(main).toContain(`@scrymore/scry-deployer@${templates.DEPLOYER_RANGE} update-workflows\n`);
      expect(main).not.toMatch(/capture web|no-analysis/);
    }
    expect(templates.DEPLOYER_RANGE).toBe('^0.12.1');
  });

  test('the PR preview workflow is the same with and without capture web', () => {
    // PR previews keep --with-analysis: capture web only runs on the default branch.
    expect(generatePRWorkflow('', '', 'npm', 'build-storybook', { capture: 'web' })).toBe(generatePRWorkflow('', '', 'npm', 'build-storybook'));
  });
});
