/* eslint-disable sonarjs/no-os-command-from-path -- a test, git is found on PATH */
/**
 * `init --capture web` and `update-workflows --capture web`: the build-free capture workflow for
 * any qualifying project. No browser and no real Storybook: the projects here are the shapes
 * the check must refuse, plus an injected "qualifies" answer for the files that get written.
 */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const templates = require('../lib/templates.js');
const { checkCaptureWebProject, checkCaptureWebProjectIsolated, checkEnvironment, explainPresetFailure } = require('../lib/capture/web/qualify.js');

const MAIN = '.github/workflows/deploy-storybook.yml';
const PR = '.github/workflows/deploy-pr-preview.yml';
const CAPTURE = '.github/workflows/scry-capture-web.yml';
const STALE = 'run: npx @scrymore/scry-deployer --dir ./storybook-static\n';
const QUALIFIES = { storybookVersion: '10.0.7', frameworkName: '@storybook/react-vite', rendererName: '@storybook/react', viteVersion: '7.1.0', playwrightPackage: 'playwright' };

let dir;
let cwd;
beforeEach(() => {
  cwd = process.cwd();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scry-cw-onboard-')));
  execSync('git init -q . && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'build-storybook': 'storybook build' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, MAIN), STALE);
  execSync('git add -A && git commit -qm seed', { cwd: dir, stdio: 'pipe' });
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(dir, rel));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const status = () => execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' });
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, SCRY_TELEMETRY: '0' },
});
/** A Storybook of the given version that is only a package.json: enough for the version check. */
const fakeStorybook = (version) => {
  write('.storybook/main.js', 'export default {};\n');
  write('node_modules/storybook/package.json', JSON.stringify({ name: 'storybook', version }));
  write('.gitignore', 'node_modules\n');
  execSync('git add -A && git commit -qm storybook', { cwd: dir, stdio: 'pipe' });
};

describe('the qualify check (lib/capture/web/qualify.js)', () => {
  test('no Storybook config directory', async () => {
    await expect(checkCaptureWebProject({ projectDir: dir, configDir: path.join(dir, '.storybook') })).rejects.toThrow(/No Storybook config directory/);
  });

  test('Storybook not installed', async () => {
    write('.storybook/main.js', 'export default {};\n');
    await expect(checkCaptureWebProject({ projectDir: dir, configDir: path.join(dir, '.storybook') })).rejects.toThrow(/needs "storybook" installed/);
  });

  test.each(['8.6.14', '9.1.2', '11.0.0'])('Storybook %s', async (version) => {
    fakeStorybook(version);
    await expect(checkCaptureWebProject({ projectDir: dir, configDir: path.join(dir, '.storybook') })).rejects.toThrow(/works with Storybook 10/);
  });

  test('the isolated form reports the same reason and leaves this process alone', () => {
    fakeStorybook('9.1.2');
    const env = { ...process.env };
    const result = checkCaptureWebProjectIsolated({ projectDir: dir, configDir: path.join(dir, '.storybook') });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Storybook 9\.1\.2 is not supported by capture web/);
    expect(process.cwd()).toBe(cwd);
    expect(process.env.NODE_ENV).toBe(env.NODE_ENV);
    expect(process.env.STORYBOOK_DISABLE_TELEMETRY).toBe(env.STORYBOOK_DISABLE_TELEMETRY);
  });

  test('the check\'s child process gets no credentials', () => {
    const env = {
      PATH: '/usr/bin', HOME: '/home/x', NODE_ENV: 'test', MY_PROJECT_TOKEN: 'kept: the project\'s own',
      SCRY_PROJECT_ID: 'proj', SCRY_API_URL: 'https://api', STORYBOOK_DEPLOYER_PROJECT: 'proj', SCRY_TELEMETRY: '0',
      SCRY_API_KEY: 'x', STORYBOOK_DEPLOYER_API_KEY: 'x', SCRY_UPLOAD_TOKEN: 'x', STORYBOOK_DEPLOYER_SECRET: 'x', scry_password: 'x',
      GITHUB_TOKEN: 'x', GH_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x', NPM_TOKEN: 'x', NODE_AUTH_TOKEN: 'x',
      npm_config__authToken: 'x', 'NPM_CONFIG_//registry.npmjs.org/:_authToken': 'x',
    };
    const kept = ['PATH', 'HOME', 'NODE_ENV', 'MY_PROJECT_TOKEN', 'SCRY_PROJECT_ID', 'SCRY_API_URL', 'STORYBOOK_DEPLOYER_PROJECT', 'SCRY_TELEMETRY'];
    expect(Object.keys(checkEnvironment(env)).sort()).toEqual([...kept].sort());

    // And that is the environment the child is started with.
    let seen;
    const fakeSpawn = (_node, _args, options) => {
      seen = options;
      return { stdout: '\nSCRY_CAPTURE_WEB_CHECK={"ok":true,"info":{}}\n', stderr: '', status: 0 };
    };
    const result = checkCaptureWebProjectIsolated({ projectDir: dir, configDir: path.join(dir, '.storybook') }, { spawnSync: fakeSpawn, env });
    expect(result.ok).toBe(true);
    expect(Object.keys(seen.env).sort()).toEqual([...kept].sort());
    expect(seen.cwd).toBe(dir);
  });

  test('a real child does not see the credentials of the process that started it', () => {
    write('.storybook/main.js', 'export default {};\n');
    write('node_modules/storybook/package.json', JSON.stringify({ name: 'storybook', version: '10.0.0', exports: { './internal/core-server': './leak.js', './internal/common': './leak.js' } }));
    // Stands in for project code: it reports what it can read from the environment.
    write('node_modules/storybook/leak.js', 'throw new Error("env:" + ["SCRY_API_KEY", "STORYBOOK_DEPLOYER_API_KEY", "GITHUB_TOKEN", "NPM_TOKEN", "SCRY_PROJECT_ID"].map((n) => n + "=" + (process.env[n] || "unset")).join(","));\n');
    const env = { ...process.env, SCRY_API_KEY: 'leak-1', STORYBOOK_DEPLOYER_API_KEY: 'leak-2', GITHUB_TOKEN: 'leak-3', NPM_TOKEN: 'leak-4', SCRY_PROJECT_ID: 'proj-visible' };
    const result = checkCaptureWebProjectIsolated({ projectDir: dir, configDir: path.join(dir, '.storybook') }, { env });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SCRY_API_KEY=unset,STORYBOOK_DEPLOYER_API_KEY=unset,GITHUB_TOKEN=unset,NPM_TOKEN=unset,SCRY_PROJECT_ID=proj-visible');
    expect(result.reason).not.toMatch(/leak-\d/);
  });

  describe('Storybook\'s "failed to load preset" becomes the plain reason', () => {
    const raw = (name) => new Error(`Storybook failed to load the following preset: ${name}/preset.\n\nPlease check whether your setup is correct.\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '${name}' imported from /x/chunk.js\n    at packageResolve (node:internal)\n`);
    const explain = (name) => explainPresetFailure(raw(name), { projectDir: dir, configDir: path.join(dir, '.storybook') }).message;

    test('a webpack framework that is not installed: needs a Vite framework', () => {
      write('.storybook/main.ts', "export default { stories: [], framework: { name: '@storybook/react-webpack5', options: {} } };\n");
      const message = explain('@storybook/react-webpack5');
      expect(message).toMatch(/^capture web needs a Vite-based Storybook framework \(for example @storybook\/react-vite\); this project's Storybook config names "@storybook\/react-webpack5", which is also not installed in /);
      // Storybook's own error is kept as the detail, without the stack.
      expect(message).toContain('Detail from Storybook: Storybook failed to load the following preset: @storybook/react-webpack5/preset. Error [ERR_MODULE_NOT_FOUND]: Cannot find package');
      expect(message).not.toContain('packageResolve');
    });

    test('a Vite framework that is not installed: install the dependencies', () => {
      write('.storybook/main.js', "export default { framework: '@storybook/react-vite' };\n");
      const message = explain('@storybook/react-vite');
      expect(message).toMatch(/^The Storybook config names "@storybook\/react-vite", which is not installed in /);
      expect(message).not.toMatch(/needs a Vite-based/);
    });

    test('an addon that is not installed is not called a framework problem', () => {
      write('.storybook/main.js', "export default { addons: ['@storybook/addon-docs'], framework: '@storybook/react-vite' };\n");
      expect(explain('@storybook/addon-docs')).toMatch(/^The Storybook config names "@storybook\/addon-docs", which is not installed in /);
    });

    test('any other error is returned as it is', () => {
      const other = new Error('boom');
      expect(explainPresetFailure(other, { projectDir: dir, configDir: dir })).toBe(other);
    });
  });

  test('a Storybook 10 project with no Playwright of its own does not qualify for the CI workflow', async () => {
    const { requireProjectPlaywright } = require('../lib/capture/web/qualify.js');
    expect(() => requireProjectPlaywright(dir)).toThrow(/needs "playwright" installed in/);
    write('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', version: '1.55.0' }));
    expect(requireProjectPlaywright(dir)).toBe('@playwright/test');
    write('node_modules/playwright/package.json', JSON.stringify({ name: 'playwright', version: '1.55.0' }));
    expect(requireProjectPlaywright(dir)).toBe('playwright');
  });
});

describe('scry-deployer update-workflows --capture web', () => {
  test('a project that does not qualify stops with the reason and writes nothing', () => {
    fakeStorybook('9.1.2');
    const r = cli('update-workflows', '--capture', 'web', '--commit');
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('--capture web: this project cannot use the build-free capture.');
    expect(out).toContain('Storybook 9.1.2 is not supported by capture web, which works with Storybook 10');
    expect(out).toContain('Nothing was written.');
    expect(read(MAIN)).toBe(STALE);
    expect(exists(PR)).toBe(false);
    expect(exists(CAPTURE)).toBe(false);
    expect(status()).toBe('');
    expect(execSync('git log -1 --format=%s', { cwd: dir, encoding: 'utf8' }).trim()).toBe('storybook');
  });

  test('no Storybook at all: same stop, and no .github folder is created', () => {
    fs.rmSync(path.join(dir, '.github'), { recursive: true });
    const r = cli('update-workflows', '--capture', 'web');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('No Storybook config directory');
    expect(exists('.github')).toBe(false);
  });

  test('only "web" is accepted', () => {
    const r = cli('update-workflows', '--capture', 'rn');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/capture/);
    expect(read(MAIN)).toBe(STALE);
    expect(exists(CAPTURE)).toBe(false);
  });

  test('--config-dir needs --capture web', () => {
    const r = cli('update-workflows', '--config-dir', '.storybook-vitest');
    expect(r.status).not.toBe(0);
    expect(read(MAIN)).toBe(STALE);
  });

  test('is listed in the command help', () => {
    for (const command of ['update-workflows', 'init']) {
      const r = cli(command, '--help');
      expect(r.stdout).toContain('--capture');
      expect(r.stdout).toContain('scry-capture-web.yml');
      expect(r.stdout).toContain('--config-dir');
      // The check runs project code: the help says so. (yargs wraps the text.)
      expect(r.stdout.replace(/\s+/g, ' ')).toContain('run it only in a repository you trust');
    }
  });

  test('from a subfolder it stops, names the repository-root limit and writes nothing', () => {
    write('apps/web/package.json', '{}');
    write('apps/web/.storybook/main.js', 'export default {};\n');
    execSync('git add -A && git commit -qm sub', { cwd: dir, stdio: 'pipe' });
    for (const args of [['update-workflows', '--capture', 'web'], ['init', '--project-id', 'p', '--api-key', 'test-key-placeholder-not-a-credential', '--skip-gh-setup', '--capture', 'web']]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: path.join(dir, 'apps/web'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, SCRY_TELEMETRY: '0' } });
      expect(r.status).toBe(1);
      const out = r.stdout + r.stderr;
      expect(out).toContain('run it from the repository root');
      expect(out).toContain(`Repository root:  ${dir}`);
      expect(out).toContain('the Storybook project must be at the repository root');
      expect(out).toContain('Nothing was written.');
      expect(exists('apps/web/.github')).toBe(false);
      expect(exists('apps/web/.storybook-deployer.json')).toBe(false);
      expect(read(MAIN)).toBe(STALE);
      expect(status()).toBe('');
    }
  });

  test('the repository-root check comes before any project code is loaded', async () => {
    const { resolveCaptureWeb } = require('../lib/update-workflows.js');
    process.chdir(dir);
    const calls = [];
    const check = (input) => { calls.push(input); return { ok: true, info: QUALIFIES }; };
    const logger = { error() {}, info() {}, success() {}, debug() {} };
    expect(() => resolveCaptureWeb({ capture: 'web' }, { checkCaptureWebProject: check, logger, gitTopLevel: () => path.dirname(dir) })).toThrow(/not at the repository root/);
    expect(() => resolveCaptureWeb({ capture: 'web' }, { checkCaptureWebProject: check, logger, gitTopLevel: () => null })).toThrow(/not a git repository/);
    expect(calls).toEqual([]);
  });

  describe('on a project that qualifies', () => {
    const { runUpdateWorkflows } = require('../lib/update-workflows.js');
    let lines;
    let spy;
    beforeEach(() => {
      process.chdir(dir);
      lines = [];
      spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
      jest.spyOn(console, 'error').mockImplementation((...a) => lines.push(a.join(' ')));
    });
    afterEach(() => {
      spy.mockRestore();
      jest.restoreAllMocks();
    });
    const qualifies = (calls = []) => (input) => {
      calls.push(input);
      return { ok: true, info: QUALIFIES };
    };

    test('writes the capture workflow and stops the deploy workflow capturing a second time', async () => {
      const calls = [];
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies(calls) });
      expect(calls).toEqual([{ projectDir: dir, configDir: path.join(dir, '.storybook') }]);
      expect(read(CAPTURE)).toBe(templates.generateCaptureWebWorkflow('pnpm'));
      expect(read(MAIN)).toBe(templates.generateMainWorkflow('', '', 'pnpm', 'build-storybook', { capture: 'web' }));
      expect(read(MAIN)).toContain('--no-analysis');
      // PR previews are untouched by the option.
      expect(read(PR)).toBe(templates.generatePRWorkflow('', '', 'pnpm', 'build-storybook'));
      const out = lines.join('\n');
      expect(out).toContain(`Updated ${CAPTURE}`);
      expect(out).toContain('Storybook 10.0.7');
      expect(out).toContain('--no-analysis');
      expect(out).toContain('@scrymore/scry-deployer@^0.14.0');
    });

    test('pnpm comes from "packageManager" when the project names one, else from the lockfile format', async () => {
      // Seeded project: version 9 lockfile, no packageManager field.
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies() });
      expect(read(CAPTURE)).toMatch(/uses: pnpm\/action-setup@v4\n {8}with:\n.*\n {10}version: 10\n/);
      // The deploy workflows keep their own pnpm step.
      expect(read(MAIN)).toMatch(/uses: pnpm\/action-setup@v2\n {8}with:\n {10}version: 8\n/);

      write('package.json', JSON.stringify({ packageManager: 'pnpm@9.15.4', scripts: { 'build-storybook': 'storybook build' } }));
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies() });
      expect(read(CAPTURE)).toContain('uses: pnpm/action-setup@v4\n      - name: Setup Node.js');
      expect(read(CAPTURE)).not.toMatch(/^ {10}version:/m);

      write('package.json', JSON.stringify({ scripts: {} }));
      write('pnpm-lock.yaml', "lockfileVersion: '6.0'\n");
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies() });
      expect(read(CAPTURE)).toMatch(/^ {10}version: 8$/m);
    });

    test('yarn and bun projects install with their own package manager', async () => {
      const { captureWebWorkflowArgs } = require('../lib/update-workflows.js');
      fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
      write('yarn.lock', '');
      write('package.json', JSON.stringify({ packageManager: 'yarn@4.5.0' }));
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies() });
      expect(read(CAPTURE)).toBe(templates.generateCaptureWebWorkflow('yarn', { corepack: true }));
      expect(read(CAPTURE)).toContain('run: corepack enable');
      expect(read(CAPTURE)).toContain('run: yarn install');
      expect(captureWebWorkflowArgs('yarn', undefined, dir)[1].corepack).toBe(true);
      write('package.json', JSON.stringify({ packageManager: 'yarn@1.22.22' }));
      expect(captureWebWorkflowArgs('yarn', undefined, dir)[1].corepack).toBe(false);

      // Bun's text lockfile (Bun 1.2+): the deploy workflows' detection does not know it.
      fs.rmSync(path.join(dir, 'yarn.lock'));
      write('bun.lock', '{}');
      write('package.json', JSON.stringify({}));
      expect(captureWebWorkflowArgs('npm', undefined, dir)[0]).toBe('bun');
      write('package-lock.json', '{}');
      expect(captureWebWorkflowArgs('npm', undefined, dir)[0]).toBe('npm');
    });

    test('--config-dir is checked and written into the workflow', async () => {
      const calls = [];
      await runUpdateWorkflows({ capture: 'web', configDir: '.storybook-vitest' }, { checkCaptureWebProject: qualifies(calls) });
      expect(calls[0].configDir).toBe(path.join(dir, '.storybook-vitest'));
      expect(read(CAPTURE)).toContain("--config-dir '.storybook-vitest'");
    });

    test('an unsafe --config-dir stops before the check and before any write', async () => {
      const calls = [];
      await expect(runUpdateWorkflows({ capture: 'web', configDir: '$(touch pwned)' }, { checkCaptureWebProject: qualifies(calls) })).rejects.toThrow(/config-dir/);
      expect(calls).toEqual([]);
      expect(read(MAIN)).toBe(STALE);
      expect(exists(CAPTURE)).toBe(false);
    });

    test('--commit commits all three files', async () => {
      await runUpdateWorkflows({ capture: 'web', commit: true }, { checkCaptureWebProject: qualifies() });
      const files = execSync('git show --name-only --format= HEAD', { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
      expect(files).toEqual([PR, MAIN, CAPTURE].sort());
    });

    test('without the option nothing about capture is checked or written', async () => {
      const calls = [];
      await runUpdateWorkflows({}, { checkCaptureWebProject: qualifies(calls) });
      expect(calls).toEqual([]);
      expect(exists(CAPTURE)).toBe(false);
      expect(read(MAIN)).toBe(templates.generateMainWorkflow('', '', 'pnpm', 'build-storybook'));
      expect(lines.join('\n')).not.toMatch(/capture web/);
    });

    test('going back: a plain update restores --with-analysis and says the capture workflow is still there', async () => {
      await runUpdateWorkflows({ capture: 'web' }, { checkCaptureWebProject: qualifies() });
      lines.length = 0;
      await runUpdateWorkflows({}, {});
      expect(read(MAIN)).toContain('--with-analysis');
      expect(exists(CAPTURE)).toBe(true);
      const out = lines.join('\n');
      expect(out).toContain(CAPTURE);
      expect(out).toMatch(/screenshots taken twice/);
    });

    test('a hand-written scry-capture-web.yml is not Scry\'s to warn about', async () => {
      write(CAPTURE, 'name: my own capture\n');
      await runUpdateWorkflows({}, {});
      expect(lines.join('\n')).not.toMatch(/twice/);
      expect(read(CAPTURE)).toBe('name: my own capture\n');
    });
  });
});

describe('scry-deployer init --capture web', () => {
  const init = require('../lib/init.js');

  test('a project that does not qualify stops before the config file and the workflows', () => {
    fakeStorybook('9.1.2');
    const r = cli('init', '--project-id', 'proj-123', '--api-key', 'test-key-placeholder-not-a-credential', '--skip-gh-setup', '--capture', 'web');
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('--capture web: this project cannot use the build-free capture.');
    expect(out).toContain('Storybook 9.1.2 is not supported');
    expect(out).toContain('Nothing was written.');
    expect(exists('.storybook-deployer.json')).toBe(false);
    expect(read(MAIN)).toBe(STALE);
    expect(exists(PR)).toBe(false);
    expect(exists(CAPTURE)).toBe(false);
    expect(status()).toBe('');
  });

  test('the project is checked before the credentials: a project that does not qualify hears that first', async () => {
    process.chdir(dir);
    const lines = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...a) => lines.push(a.join(' ')));
    try {
      // No project id and no key: the credentials step would refuse, but it is not reached.
      jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
      await expect(init.runInit({ capture: 'web' }, { checkCaptureWebProject: () => ({ ok: false, reason: 'Storybook 9.1.2 is not supported' }) })).rejects.toThrow('exit 1');
    } finally {
      jest.restoreAllMocks();
    }
    const out = lines.join('\n');
    expect(out).toContain('Storybook 9.1.2 is not supported');
    expect(out).not.toMatch(/Validating credentials/);
    expect(exists('.storybook-deployer.json')).toBe(false);
    expect(status()).toBe('');
  });

  test('generateWorkflows writes the third file only when asked', () => {
    process.chdir(dir);
    const env = { packageManager: 'pnpm', storybookBuildCmd: 'build-storybook' };
    expect(init.generateWorkflows('p', 'https://api', env)).toEqual([MAIN, PR]);
    expect(exists(CAPTURE)).toBe(false);
    expect(read(MAIN)).toBe(templates.generateMainWorkflow('p', 'https://api', 'pnpm', 'build-storybook'));

    expect(init.generateWorkflows('p', 'https://api', env, { capture: 'web', configDir: '.storybook' })).toEqual([MAIN, PR, CAPTURE]);
    expect(read(CAPTURE)).toBe(templates.generateCaptureWebWorkflow('pnpm'));
    expect(read(MAIN)).toContain('--no-analysis');
    expect(read(PR)).toContain('--with-analysis');
  });

  test('the commit takes the capture workflow only when init wrote it', () => {
    process.chdir(dir);
    const logger = { debug() {}, info() {}, error() {}, success() {} };
    write(CAPTURE, 'name: my own capture\n');
    write(PR, 'name: pr\n');
    expect(init.gitCommit(logger).success).toBe(true);
    expect(status()).toContain(CAPTURE);
    expect(init.gitCommit(logger, [CAPTURE]).success).toBe(true);
    expect(status()).toBe('');
  });
});
