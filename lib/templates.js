/**
 * Generate GitHub Actions workflow templates
 */

/**
 * Get package manager setup action
 */
function getPackageManagerSetup(packageManager) {
    switch (packageManager) {
        case 'pnpm':
            return `      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
`;
        case 'yarn':
            return ''; // Yarn is supported by default in setup-node
        case 'bun':
            return `      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
`;
        default:
            return '';
    }
}

/**
 * Get install command for package manager
 * All commands handle missing lockfiles gracefully
 */
function getInstallCommand(packageManager) {
    switch (packageManager) {
        case 'npm':
            // Use npm install which works with or without package-lock.json
            return 'npm install';
        case 'pnpm':
            // Just use pnpm install - it works with or without lockfile
            // We set CI=false to prevent pnpm from auto-enabling frozen-lockfile
            return 'CI=false pnpm install';
        case 'yarn':
            return 'yarn install';
        case 'bun':
            return 'bun install';
        default:
            return 'npm install';
    }
}

/**
 * Get cache value for package manager
 */
function getCacheValue(packageManager) {
    if (packageManager === 'npm') {
        return '';
    }
    return `          cache: '${packageManager}'`;
}

/**
 * The deployer version range every generated workflow installs.
 *
 * A floor, not a pin and not @latest: every 0.x fix, never a version without
 * the "nothing will be indexed" guards (0.7.0), never a surprise major. The
 * repo's own package.json cannot lower it, because the deployer is installed
 * into its own folder (ISSUES.md #50: a repo pinned to 0.2.2 ran it for seven
 * weeks through a bare `npx @scrymore/scry-deployer`). 0.9.0: CI timings and
 * the execute budget warning (ISSUES.md #54). 0.12.1: Storybook tags reach
 * Scry (scry-sbcov ^0.8.0); on 0.x a caret on 0.9.0 stops below 0.10, so the
 * floor has to be raised by hand for customers to get a newer deployer.
 */
const DEPLOYER_RANGE = '^0.12.1';

/**
 * Where the deployer is installed on the runner: outside the checkout, so
 * `npm i` never touches a pnpm or yarn node_modules and the repo's lockfile
 * or pin cannot choose the version. Shell form for `run:`, expression form
 * for `working-directory:`.
 */
const TOOLS_DIR_SHELL = '"$RUNNER_TEMP/scry"';
const TOOLS_DIR_EXPR = '${{ runner.temp }}/scry';
const DEPLOYER_BIN = '"$RUNNER_TEMP/scry/node_modules/.bin/scry-deployer"';

/**
 * Steps that install the deployer, then the browser its analyzer drives.
 *
 * Order matters. The browser is installed by the Playwright inside the
 * deployer's own dependency tree (the one scry-sbcov loads), after the
 * deployer exists. A floating `npx playwright install` before it resolved
 * whatever Playwright was newest (or the repo's own) and could fetch a
 * browser build the analyzer does not look for; every story then failed, no
 * metadata was written and nothing was indexed (scry-link #44).
 *
 * Package-manager independent on purpose: npm ships with setup-node, and the
 * install goes to a separate prefix, so pnpm, yarn and bun repos get the same
 * steps.
 */
function getDeployerSetupSteps() {
    return `      - name: Install the Scry deployer
        id: scry
        # Its own folder and a floor of ${DEPLOYER_RANGE}: the repo's own pin cannot pick an older deployer.
        # --ignore-scripts: nothing in its tree needs an install script, and none runs next to the checkout's token.
        run: |
          set -o pipefail
          mkdir -p ${TOOLS_DIR_SHELL}
          npm i --no-save --no-audit --no-fund --ignore-scripts --prefix ${TOOLS_DIR_SHELL} @scrymore/scry-deployer@${DEPLOYER_RANGE}
          cd ${TOOLS_DIR_SHELL}
          echo "version=$(node -p "require('@scrymore/scry-deployer/package.json').version")" >> "$GITHUB_OUTPUT"
          PW="$(npx --no-install playwright --version | awk '{print $2}')"
          [ -n "$PW" ] || { echo "::error::the deployer's Playwright was not found in $RUNNER_TEMP/scry"; exit 1; }
          echo "playwright=$PW" >> "$GITHUB_OUTPUT"

      - name: Cache the deployer's Playwright browser
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: scry-pw-\${{ runner.os }}-\${{ steps.scry.outputs.playwright }}

      - name: Install the deployer's Playwright browser
        # The deployer's own Playwright, so the browser build is the one its
        # analyzer launches. Without it every story fails and nothing is indexed.
        working-directory: ${TOOLS_DIR_EXPR}
        run: npx --no-install playwright install --with-deps chromium-headless-shell
`;
}

/**
 * Job limits shared by both workflows (ISSUES.md #54).
 *
 * timeout-minutes: a Storybook run once took 21 minutes and nothing bounded it;
 * GitHub's default is 6 hours. 20 still lets today's slowest run finish.
 * permissions: actions: read lets the deployer read its own job's start time
 * from the Actions API (whole-job CI time). A permissions block drops every
 * scope it does not list, so contents: read (checkout) is listed too.
 */
const JOB_TIMEOUT_MINUTES = 20;

/** Deployer flags shared by both workflows. */
const COMMON_FLAGS = `            \${{ vars.SCRY_COVERAGE_ENABLED == 'false' && '--no-coverage' || '' }} \\
            \${{ vars.SCRY_COVERAGE_FAIL_ON_THRESHOLD == 'true' && '--coverage-fail-on-threshold' || '' }} \\
            \${{ vars.SCRY_COVERAGE_EXECUTE == 'false' && '' || '--coverage-execute' }} \\
            --with-analysis \\`;

/**
 * Generate main deployment workflow
 */
function generateMainWorkflow(projectId, apiUrl, packageManager, buildCmd, options = {}) {
    const pmSetup = getPackageManagerSetup(packageManager);
    const installCmd = getInstallCommand(packageManager);
    const cache = getCacheValue(packageManager);
    const runCmd = packageManager === 'npm' ? `npm run ${buildCmd}` : `${packageManager} run ${buildCmd}`;
    // With --capture web, ${CAPTURE_WEB_WORKFLOW_FILE} takes the screenshots and feeds search.
    // This workflow keeps what a capture bundle does not carry: the hosted Storybook, the
    // coverage report and the CI time. --no-analysis is the existing "host it, take no
    // screenshots, index nothing" mode, so the screenshots are not taken a second time.
    // Coverage with --coverage-execute still renders the stories to run them.
    const captureWeb = options.capture === 'web';
    const flags = captureWeb ? COMMON_FLAGS.replace('--with-analysis', '--no-analysis') : COMMON_FLAGS;
    const regenerate = captureWeb
        ? `# Regenerate with: npx -y @scrymore/scry-deployer@${CAPTURE_WEB_DEPLOYER_RANGE} update-workflows --capture web
# Screenshots for search come from ${CAPTURE_WEB_WORKFLOW_FILE} (build-free capture). This workflow hosts
# Storybook and reports coverage; --no-analysis below keeps it from taking the screenshots a second time.
# (Coverage with --coverage-execute still renders the stories to run them.)`
        : `# Regenerate with: npx -y @scrymore/scry-deployer@${DEPLOYER_RANGE} update-workflows`;

    return `# Auto-generated by Scry Storybook Deployer
# Deploy Storybook to production on push to main branch
${regenerate}

name: Deploy Storybook

on:
  push:
    branches: [main, master]

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: ${JOB_TIMEOUT_MINUTES}

    permissions:
      contents: read
      actions: read
      # Listed because a permissions block drops every scope it does not name
      # (GitHub Packages installs need it).
      packages: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for coverage new-code analysis

${pmSetup}      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
${cache}

      - name: Install dependencies
        run: ${installCmd}

      - name: Build Storybook
        run: ${runCmd}

${getDeployerSetupSteps()}
      - name: Deploy to Scry
        # Exits 1 when the build was asked to index and nothing will be indexed.
        run: |
          ${DEPLOYER_BIN} \\
            --dir ./storybook-static \\
${flags}
            --coverage-base \${{ vars.SCRY_COVERAGE_BASE || github.event.before }}
        env:
          STORYBOOK_DEPLOYER_API_URL: \${{ vars.SCRY_API_URL }}
          STORYBOOK_DEPLOYER_PROJECT: \${{ vars.SCRY_PROJECT_ID }}
          STORYBOOK_DEPLOYER_API_KEY: \${{ secrets.SCRY_API_KEY }}
          # Optional: stories allowed to fail capture before the deploy ends red (default 0).
          SCRY_MAX_DROPPED: \${{ vars.SCRY_MAX_DROPPED }}
          # Optional: stories rendered at once (default 4) and how long one may take to show something (ms, default 5000).
          SCRY_CONCURRENCY: \${{ vars.SCRY_CONCURRENCY }}
          SCRY_RENDER_TIMEOUT_MS: \${{ vars.SCRY_RENDER_TIMEOUT_MS }}
          # Optional: story execution budget = base + per story × stories (default 120 s + 0.5 s); over it = a warning.
          SCRY_EXECUTE_BUDGET_BASE_S: \${{ vars.SCRY_EXECUTE_BUDGET_BASE_S }}
          SCRY_EXECUTE_BUDGET_PER_STORY_S: \${{ vars.SCRY_EXECUTE_BUDGET_PER_STORY_S }}
          # Also lets the deployer read this job's start time (needs actions: read above).
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

/**
 * Build-free capture (`scry-deployer capture web`), written by `--capture web`.
 *
 * 0.14.0 is the first published deployer with the command. Until then only a git install had
 * it, and a customer workflow never installs from git.
 */
const CAPTURE_WEB_DEPLOYER_RANGE = '^0.14.0';
const CAPTURE_WEB_WORKFLOW_FILE = 'scry-capture-web.yml';

/**
 * Measured on the Scry dashboard (1,734 stories): about 10 minutes of capture on a 2-core
 * GitHub-hosted ubuntu-24.04 runner, then about 1.5 minutes to upload 87.5 MB. Add the project
 * install, the deployer install and the browser download. 30 leaves room for a Storybook about
 * twice that size; GitHub's own default is 6 hours.
 */
const CAPTURE_WEB_TIMEOUT_MINUTES = 30;

/** Chromium is installed by the project's own Playwright: that is the one capture web drives. */
function getProjectPlaywrightCommand(packageManager) {
    switch (packageManager) {
        case 'pnpm':
            return 'pnpm exec playwright';
        case 'yarn':
            return 'yarn run playwright';
        default:
            // npm and bun: --no-install so a missing Playwright fails here instead of fetching the newest one.
            return 'npx --no-install playwright';
    }
}

/**
 * Package manager setup for the capture workflow only. The two deploy workflows keep their
 * own setup step. The project is installed with its own package manager and its own lockfile.
 *
 * pnpm. capture web needs Storybook 10, and such a project is normally on pnpm 9 or 10 with a
 * version 9 lockfile. pnpm 8 cannot read that lockfile and would resolve fresh versions.
 *   - package.json has "packageManager": "pnpm@x": no version here, so pnpm/action-setup
 *     installs exactly that one (it stops when both are given and differ).
 *   - otherwise the version comes from the lockfile's format: 10 for a version 9 lockfile
 *     (pnpm 9 and 10 both write it; 10 is the one the measured runs used), 8 for an older one.
 *
 * yarn. The runner has Yarn 1. A project that names a newer Yarn in "packageManager" gets it
 * through Corepack, turned on before setup-node so its cache step already runs that Yarn.
 *
 * bun. setup-bun, and no "cache" on setup-node: setup-node caches npm, yarn and pnpm only and
 * stops on any other value.
 */
const CAPTURE_WEB_PNPM_DEFAULT_VERSION = '10';
function getCaptureWebPackageManagerSetup(packageManager, options = {}) {
    const pnpm = options.pnpm || {};
    if (packageManager === 'bun') {
        return `      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
`;
    }
    if (packageManager === 'yarn') {
        if (!options.corepack) return '';
        return `      - name: Enable Corepack
        # The Yarn version comes from "packageManager" in package.json.
        run: corepack enable
`;
    }
    if (packageManager !== 'pnpm') return '';
    if (pnpm.fromPackageJson) {
        return `      - name: Setup pnpm
        # The version comes from "packageManager" in package.json.
        uses: pnpm/action-setup@v4
`;
    }
    const version = /^\d{1,3}$/.test(String(pnpm.version || '')) ? String(pnpm.version) : CAPTURE_WEB_PNPM_DEFAULT_VERSION;
    return `      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          # No "packageManager" in package.json, so the version follows the lockfile's format.
          version: ${version}
`;
}

/** setup-node's dependency cache for the capture workflow: npm keeps the existing "none", bun has none. */
function getCaptureWebCacheValue(packageManager) {
    return packageManager === 'bun' ? '' : getCacheValue(packageManager);
}

/**
 * The Storybook config directory as it is written into the workflow, or null for the default.
 * It lands in a shell command, so only a plain relative path is accepted.
 */
function normalizeCaptureConfigDir(configDir) {
    if (configDir === undefined || configDir === null || configDir === '') return null;
    let value = String(configDir);
    while (value.startsWith('./')) value = value.slice(2);
    while (value.endsWith('/')) value = value.slice(0, -1);
    const plain = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/.test(value);
    if (!plain || value.startsWith('-') || value.split('/').some((part) => part === '..' || part === '')) {
        throw new Error(`--config-dir must be a plain relative path inside the repository (letters, digits, ".", "_", "-", "@", "+", "/"); got ${JSON.stringify(String(configDir))}.`);
    }
    return value === '.storybook' ? null : value;
}

/**
 * Generate the build-free capture workflow: capture every story with the project's own
 * Storybook 10, Vite and Playwright, then upload the bundle to Scry.
 */
function generateCaptureWebWorkflow(packageManager, options = {}) {
    const pmSetup = getCaptureWebPackageManagerSetup(packageManager, options);
    const installCmd = getInstallCommand(packageManager);
    const cache = getCaptureWebCacheValue(packageManager);
    const playwright = getProjectPlaywrightCommand(packageManager);
    const configDir = normalizeCaptureConfigDir(options.configDir);
    const configDirFlag = configDir ? `            --config-dir '${configDir}' \\\n` : '';
    const regenerateFlags = configDir ? ` --config-dir ${configDir}` : '';

    return `# Auto-generated by Scry Storybook Deployer
# Capture every Storybook story without building Storybook, then upload the screenshots to Scry
# Regenerate with: npx -y @scrymore/scry-deployer@${CAPTURE_WEB_DEPLOYER_RANGE} update-workflows --capture web${regenerateFlags}
#
# Needs Storybook 10 on a Vite framework with the React renderer, and Playwright in the project.
# deploy-storybook.yml still builds and hosts Storybook and reports coverage; it runs with
# --no-analysis so the screenshots are taken once, here.
#
# It runs on a push to main or master. If the default branch has another name, change
# "branches" below. The Storybook project must be at the repository root.

name: Scry Capture (web)

on:
  push:
    branches: [main, master]
  workflow_dispatch:

# Runs for one branch queue up instead of cancelling: a cancelled capture uploads nothing.
concurrency:
  group: scry-capture-web-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  capture:
    # A fixed Ubuntu, not the floating "latest" label: that one moves to a new Ubuntu before
    # the project's Playwright has a Chromium build for it, and the browser install then fails.
    runs-on: ubuntu-24.04
    timeout-minutes: ${CAPTURE_WEB_TIMEOUT_MINUTES}

    permissions:
      contents: read
      # Listed because a permissions block drops every scope it does not name
      # (GitHub Packages installs need it).
      packages: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          # Project code runs on this checkout; the token is not left in .git/config.
          persist-credentials: false

${pmSetup}      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          # capture web needs Node 20.19 or newer; '20' resolves to the newest 20.x.
          node-version: '20'
${cache}

      - name: Install dependencies
        run: ${installCmd}

      - name: Install the Scry deployer
        id: scry
        # Its own folder and a floor of ${CAPTURE_WEB_DEPLOYER_RANGE} (the first release with capture web): the
        # repo's own pin cannot pick an older deployer.
        # --ignore-scripts: nothing in its tree needs an install script.
        run: |
          set -o pipefail
          mkdir -p ${TOOLS_DIR_SHELL}
          npm i --no-save --no-audit --no-fund --ignore-scripts --prefix ${TOOLS_DIR_SHELL} @scrymore/scry-deployer@${CAPTURE_WEB_DEPLOYER_RANGE}
          echo "version=$(node -p "require('$RUNNER_TEMP/scry/node_modules/@scrymore/scry-deployer/package.json').version")" >> "$GITHUB_OUTPUT"

      - name: Install Chromium with the project's Playwright
        # The project's own Playwright, run from the checkout: capture web drives that one, so
        # the browser build has to match it.
        run: ${playwright} install --with-deps chromium

      - name: Capture the stories
        # Exits 1 when more stories fail to capture than SCRY_MAX_DROPPED allows (default 0).
        # Each failed story is retried once first. A red run uploads nothing, so Scry keeps
        # the last complete capture instead of one with stories missing.
        run: |
          ${DEPLOYER_BIN} capture web \\
${configDirFlag}            --out "$RUNNER_TEMP/capture" \\
            --report "$RUNNER_TEMP/capture-report.json" \\
            --max-dropped "\${SCRY_MAX_DROPPED:-0}"
        env:
          # Optional: stories allowed to fail capture before the run ends red (default 0).
          SCRY_MAX_DROPPED: \${{ vars.SCRY_MAX_DROPPED }}

      - name: Keep the capture report
        if: \${{ always() }}
        uses: actions/upload-artifact@v4
        with:
          name: scry-capture-web-report
          path: \${{ runner.temp }}/capture-report.json
          retention-days: 7
          if-no-files-found: ignore

      - name: Validate the bundle (manual run on another branch)
        # A manual run on a branch that is not the default one checks the bundle and sends nothing.
        if: \${{ github.event_name != 'push' && github.ref_name != github.event.repository.default_branch }}
        run: |
          ${DEPLOYER_BIN} upload "$RUNNER_TEMP/capture" --dry-run
        env:
          TMPDIR: \${{ runner.temp }}

      - name: Upload the bundle to Scry
        if: \${{ github.event_name == 'push' || github.ref_name == github.event.repository.default_branch }}
        run: |
          ${DEPLOYER_BIN} upload "$RUNNER_TEMP/capture" --deploy-version "\${GITHUB_SHA::12}"
        env:
          STORYBOOK_DEPLOYER_API_URL: \${{ vars.SCRY_API_URL }}
          STORYBOOK_DEPLOYER_PROJECT: \${{ vars.SCRY_PROJECT_ID }}
          STORYBOOK_DEPLOYER_API_KEY: \${{ secrets.SCRY_API_KEY }}
`;
}

/**
 * Generate PR preview workflow
 */
function generatePRWorkflow(projectId, apiUrl, packageManager, buildCmd) {
    const pmSetup = getPackageManagerSetup(packageManager);
    const installCmd = getInstallCommand(packageManager);
    const cache = getCacheValue(packageManager);
    const runCmd = packageManager === 'npm' ? `npm run ${buildCmd}` : `${packageManager} run ${buildCmd}`;

    return `# Auto-generated by Scry Storybook Deployer
# Deploy Storybook preview for pull requests
# Regenerate with: npx -y @scrymore/scry-deployer@${DEPLOYER_RANGE} update-workflows

name: Deploy Storybook PR Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

# One preview per PR: a new push cancels the run it replaces.
concurrency:
  group: storybook-pr-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  deploy-preview:
    # Drafts are skipped; marking the PR ready for review deploys it.
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: ${JOB_TIMEOUT_MINUTES}

    permissions:
      contents: read
      pull-requests: write
      actions: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for coverage new-code analysis

${pmSetup}      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
${cache}

      - name: Install dependencies
        run: ${installCmd}

      - name: Build Storybook
        run: ${runCmd}

${getDeployerSetupSteps()}
      - name: Deploy Preview
        id: deploy
        # Exits 1 when the build was asked to index and nothing will be indexed.
        run: |
          ${DEPLOYER_BIN} \\
            --dir ./storybook-static \\
            --version pr-\${{ github.event.pull_request.number }} \\
${COMMON_FLAGS}
            --coverage-base \${{ vars.SCRY_COVERAGE_BASE || format('origin/{0}', github.base_ref) }}

          # Construct deployment URL using VIEW_URL (where users access the deployed Storybook)
          # Defaults to https://view.scrymore.com if SCRY_VIEW_URL is not set
          PROJECT_ID="\${{ vars.SCRY_PROJECT_ID }}"
          VIEW_URL="\${{ vars.SCRY_VIEW_URL || 'https://view.scrymore.com' }}"
          DEPLOY_URL="\${VIEW_URL}/\${PROJECT_ID}/pr-\${{ github.event.pull_request.number }}/"
          echo "deployment_url=\$DEPLOY_URL" >> $GITHUB_OUTPUT
        env:
          STORYBOOK_DEPLOYER_API_URL: \${{ vars.SCRY_API_URL }}
          STORYBOOK_DEPLOYER_PROJECT: \${{ vars.SCRY_PROJECT_ID }}
          STORYBOOK_DEPLOYER_API_KEY: \${{ secrets.SCRY_API_KEY }}
          # Optional: stories allowed to fail capture before the deploy ends red (default 0).
          SCRY_MAX_DROPPED: \${{ vars.SCRY_MAX_DROPPED }}
          # Optional: stories rendered at once (default 4) and how long one may take to show something (ms, default 5000).
          SCRY_CONCURRENCY: \${{ vars.SCRY_CONCURRENCY }}
          SCRY_RENDER_TIMEOUT_MS: \${{ vars.SCRY_RENDER_TIMEOUT_MS }}
          # Optional: story execution budget = base + per story × stories (default 120 s + 0.5 s); over it = a warning.
          SCRY_EXECUTE_BUDGET_BASE_S: \${{ vars.SCRY_EXECUTE_BUDGET_BASE_S }}
          SCRY_EXECUTE_BUDGET_PER_STORY_S: \${{ vars.SCRY_EXECUTE_BUDGET_PER_STORY_S }}
          # Also lets the deployer read this job's start time (needs actions: read above).
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}

module.exports = {
    generateMainWorkflow,
    generatePRWorkflow,
    generateCaptureWebWorkflow,
    normalizeCaptureConfigDir,
    DEPLOYER_RANGE,
    CAPTURE_WEB_DEPLOYER_RANGE,
    CAPTURE_WEB_WORKFLOW_FILE,
    CAPTURE_WEB_TIMEOUT_MINUTES,
    JOB_TIMEOUT_MINUTES,
};
