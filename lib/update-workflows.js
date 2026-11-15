const { createLogger } = require('./logger');
const {
  generateMainWorkflow,
  generatePRWorkflow,
  generateCaptureWebWorkflow,
  normalizeCaptureConfigDir,
  DEPLOYER_RANGE,
  CAPTURE_WEB_DEPLOYER_RANGE,
  CAPTURE_WEB_WORKFLOW_FILE,
} = require('./templates');
const { UserInputError } = require('./errors');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

/**
 * Upgrade-only workflow generator.
 *
 * Goal: allow users to refresh .github/workflows/* to the latest templates
 * WITHOUT needing the Scry API key.
 *
 * This intentionally does NOT:
 * - validate credentials
 * - touch .storybook-deployer.json
 * - set GitHub variables/secrets
 */
async function runUpdateWorkflows(argv, deps = {}) {
  const logger = createLogger({ verbose: Boolean(argv.verbose) });

  logger.info('🛠️  Updating Scry GitHub Actions workflows...');

  const envInfo = await checkEnvironment();
  if (!envInfo.isGit) {
    throw new Error('Not a git repository. Please run this from a git repo.');
  }

  // --capture web: the project is checked before the first write. One that cannot use the
  // build-free capture stops here with nothing changed.
  const captureWeb = resolveCaptureWeb(argv, deps);

  const workflowsDir = '.github/workflows';
  fs.mkdirSync(workflowsDir, { recursive: true });

  const buildCmd = envInfo.storybookBuildCmd || 'build-storybook';

  const mainWorkflow = generateMainWorkflow('', '', envInfo.packageManager, buildCmd, captureWeb ? { capture: 'web' } : {});
  const prWorkflow = generatePRWorkflow('', '', envInfo.packageManager, buildCmd);

  const mainWorkflowPath = path.join(workflowsDir, 'deploy-storybook.yml');
  const prWorkflowPath = path.join(workflowsDir, 'deploy-pr-preview.yml');
  const captureWorkflowPath = path.join(workflowsDir, CAPTURE_WEB_WORKFLOW_FILE);

  fs.writeFileSync(mainWorkflowPath, mainWorkflow, 'utf8');
  fs.writeFileSync(prWorkflowPath, prWorkflow, 'utf8');
  if (captureWeb) {
    fs.writeFileSync(captureWorkflowPath, generateCaptureWebWorkflow(...captureWebWorkflowArgs(envInfo.packageManager, captureWeb.configDir)), 'utf8');
  }

  logger.success(`✅ Updated ${mainWorkflowPath}`);
  logger.success(`✅ Updated ${prWorkflowPath}`);
  if (captureWeb) logger.success(`✅ Updated ${captureWorkflowPath}`);
  logger.info(`   Package manager: ${envInfo.packageManager}; Storybook build script: ${buildCmd}${envInfo.storybookBuildCmd ? '' : ' (not found in package.json; the default name was used, check it)'}`);
  logger.info(`   The deployer is installed at @scrymore/scry-deployer@${DEPLOYER_RANGE} in its own folder with its own Playwright browser.`);
  if (captureWeb) {
    for (const line of captureWebSummaryLines(captureWeb.info)) logger.info(line);
  } else if (isGeneratedCaptureWorkflow(captureWorkflowPath)) {
    logger.error(`⚠️  ${captureWorkflowPath} is still in this repository, and deploy-storybook.yml now runs with --with-analysis again.
   Every push will have its screenshots taken twice and will send two builds to search.
   To keep the build-free capture: run update-workflows --capture web.
   To go back to the Storybook-build path: delete ${captureWorkflowPath}.`);
  }

  if (argv.commit) {
    gitAdd(captureWeb ? [mainWorkflowPath, prWorkflowPath, captureWorkflowPath] : [mainWorkflowPath, prWorkflowPath], logger);
    gitCommit(argv.commitMessage || 'chore: update Scry workflows', logger);
  }

  logger.success('✅ Workflow update complete');
}

/**
 * The `--capture web` option of `init` and `update-workflows`.
 *
 * Returns null without the option, or `{ configDir, info }` for a project that qualifies.
 * Throws (and so stops the command before it writes) when the option is misused or the
 * project cannot use `capture web`.
 *
 * @param {{capture?: string, configDir?: string}} argv
 * @param {{checkCaptureWebProject?: Function}} [deps] the check, replaceable in tests
 */
function resolveCaptureWeb(argv, deps = {}) {
  const hasConfigDir = argv.configDir !== undefined && argv.configDir !== null && argv.configDir !== '';
  if (!argv.capture) {
    if (hasConfigDir) throw new UserInputError('--config-dir is only used with --capture web.');
    return null;
  }
  if (argv.capture !== 'web') {
    throw new UserInputError(`--capture ${argv.capture} is not supported here; the only value is "web".`);
  }
  let configDir;
  try {
    configDir = normalizeCaptureConfigDir(hasConfigDir ? argv.configDir : undefined);
  } catch (error) {
    throw new UserInputError(error.message);
  }

  const projectDir = process.cwd();
  // The workflow runs at the repository root, and .github/workflows only works there. From a
  // subfolder the check would pass for that folder and the files would land where GitHub
  // never reads them. Checked before any project code is loaded.
  const repoRoot = (deps.gitTopLevel || gitTopLevel)();
  if (!repoRoot) {
    throw new UserInputError('--capture web: not a git repository. Run it from the root of the project\'s repository. Nothing was written.');
  }
  if (repoRoot !== fs.realpathSync(projectDir)) {
    const logger = deps.logger || createLogger({});
    logger.error(`--capture web: run it from the repository root.
   This folder:      ${projectDir}
   Repository root:  ${repoRoot}
   In this version the Storybook project must be at the repository root: the generated workflow
   runs there. For a project in a subfolder (a monorepo), copy the workflow by hand and add
   working-directory; see docs/capture-web.md, "Set it up in CI".`);
    throw new UserInputError('--capture web stopped: the Storybook project is not at the repository root. Nothing was written.');
  }
  // Required here, not at the top: only this option needs the capture code.
  const check = deps.checkCaptureWebProject || require('./capture/web/qualify').checkCaptureWebProjectIsolated;
  const result = check({ projectDir, configDir: path.resolve(projectDir, configDir || '.storybook') });
  if (!result || !result.ok) {
    // Printed here, line by line: the CLI's error handler shortens a thrown message to one line.
    const logger = deps.logger || createLogger({});
    logger.error(`--capture web: this project cannot use the build-free capture.
   ${(result && result.reason) || 'The project could not be checked.'}
   It needs Storybook 10 on a Vite framework (for example @storybook/react-vite) with the React
   renderer, and Playwright installed in the project. The project must be at the repository root.
   Run the command again without --capture web for the Storybook-build workflows.`);
    throw new UserInputError('--capture web stopped: the project does not qualify. Nothing was written.');
  }
  return { configDir, info: result.info || {} };
}

/** The repository root (real path), or null outside a git repository. */
function gitTopLevel() {
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is found on PATH, as everywhere in this file
    return fs.realpathSync(execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

/**
 * Which pnpm the capture workflow sets up: the project's own `packageManager` pin when there
 * is one, else a version that reads the project's lockfile (see lib/templates.js).
 */
function detectPnpm(dir = '.') {
  try {
    const pinned = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager;
    if (typeof pinned === 'string' && pinned.startsWith('pnpm@')) return { fromPackageJson: true };
  } catch {
    // no package.json, or not JSON: fall through to the lockfile
  }
  try {
    const head = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8').slice(0, 200);
    const match = /lockfileVersion:\s*['"]?(\d+)/.exec(head);
    if (match && Number(match[1]) < 9) return { version: '8' };
  } catch {
    // no lockfile: the default
  }
  return {};
}

/**
 * The package manager and setup details the capture workflow is generated with.
 *
 * The deploy workflows keep the package manager detectEnvironment found. Two things are read
 * here for the capture workflow only: Bun's text lockfile (bun.lock, Bun 1.2 and newer), which
 * that detection does not know, and a Yarn 2+ named in "packageManager", which needs Corepack.
 */
function captureWebWorkflowArgs(packageManager, configDir, dir = '.') {
  const has = (name) => fs.existsSync(path.join(dir, name));
  let manager = packageManager;
  if (manager === 'npm' && !has('package-lock.json') && has('bun.lock')) manager = 'bun';
  let pinned = '';
  try {
    pinned = String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager || '');
  } catch {
    // no package.json, or not JSON: no pin
  }
  const yarnMajor = /^yarn@(\d+)\./.exec(pinned);
  const corepack = manager === 'yarn' && Boolean(yarnMajor) && Number(yarnMajor[1]) >= 2;
  return [manager, { configDir, pnpm: detectPnpm(dir), corepack }];
}

/** What `--capture web` changed, in the words the two commands print after writing. */
function captureWebSummaryLines(info = {}) {
  const found = [
    info.storybookVersion && `Storybook ${info.storybookVersion}`,
    info.frameworkName,
    info.viteVersion && `Vite ${info.viteVersion}`,
    info.playwrightPackage,
  ].filter(Boolean).join(', ');
  const foundText = found ? ` (found: ${found})` : '';
  return [
    `   Build-free capture: ${CAPTURE_WEB_WORKFLOW_FILE} captures every story on a push to main or master and uploads the bundle${foundText}.`,
    `   It installs @scrymore/scry-deployer@${CAPTURE_WEB_DEPLOYER_RANGE} from npm and Chromium with the project's Playwright, on ubuntu-24.04.`,
    '   deploy-storybook.yml now runs with --no-analysis: it still builds and hosts Storybook and reports coverage, and no longer takes the screenshots a second time.',
    '   The capture workflow runs on a push to main or master; edit "branches" in it if the default branch has another name.',
    '   deploy-pr-preview.yml is unchanged: pull requests keep their preview, comment and screenshots.',
    `   To go back: run update-workflows without --capture web and delete .github/workflows/${CAPTURE_WEB_WORKFLOW_FILE}.`,
  ];
}

/** True for a capture workflow one of our commands wrote; a hand-written one is left alone. */
function isGeneratedCaptureWorkflow(file) {
  try {
    return fs.readFileSync(file, 'utf8').startsWith('# Auto-generated by Scry Storybook Deployer');
  } catch {
    return false;
  }
}

async function checkEnvironment() {
  const envInfo = {
    isGit: false,
    packageManager: 'npm',
    storybookBuildCmd: null,
  };

  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    envInfo.isGit = true;
  } catch {
    envInfo.isGit = false;
  }

  if (fs.existsSync('pnpm-lock.yaml')) {
    envInfo.packageManager = 'pnpm';
  } else if (fs.existsSync('yarn.lock')) {
    envInfo.packageManager = 'yarn';
  } else if (fs.existsSync('bun.lockb')) {
    envInfo.packageManager = 'bun';
  }

  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts) {
      if (pkg.scripts['build-storybook']) envInfo.storybookBuildCmd = 'build-storybook';
      else if (pkg.scripts['storybook:build']) envInfo.storybookBuildCmd = 'storybook:build';
      else if (pkg.scripts['build:storybook']) envInfo.storybookBuildCmd = 'build:storybook';
    }
  } catch {
    // ignore
  }

  return envInfo;
}

function gitAdd(files, logger) {
  for (const file of files) {
    if (fs.existsSync(file)) {
      execFileSync('git', ['add', '--', file], { stdio: 'pipe' });
      logger.debug(`   ✓ Added ${file}`);
    }
  }
}

function gitCommit(message, logger) {
  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (!status.trim()) {
    logger.info('No changes to commit.');
    return;
  }

  // execFile, not a shell string: the message is user input.
  execFileSync('git', ['commit', '-m', String(message)], { stdio: 'pipe' });
  const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  logger.success(`✅ Committed workflow update: ${sha}`);
}

module.exports = { runUpdateWorkflows, checkEnvironment, resolveCaptureWeb, captureWebSummaryLines, detectPnpm, captureWebWorkflowArgs };
