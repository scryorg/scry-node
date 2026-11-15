/**
 * Can this project use `scry-deployer capture web`?
 *
 * Asked by `init --capture web` and `update-workflows --capture web` before they write anything.
 * It is the same detection a capture runs (Storybook 10, a Vite framework, the React renderer,
 * Vite), plus one thing only the generated workflow needs: Playwright in the project itself,
 * because the workflow installs Chromium with the project's Playwright.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadStorybookProject, findPackageJson, CaptureWebError } = require('./storybook-config');
const { loadVite } = require('./vite-server');

/** Storybook 10 and Vite 7 need this Node; a failed check on an older one says so. */
const MIN_NODE = [20, 19];
const CHECK_TIMEOUT_MS = 120000;
const RESULT_MARK = 'SCRY_CAPTURE_WEB_CHECK=';

/**
 * The Playwright package the project's `playwright` command comes from.
 * `capture web` itself takes Playwright from the project when it has one (playwright,
 * @playwright/test or playwright-core) and otherwise falls back to the copy that comes with
 * scry-deployer's dependencies (lib/capture/web/driver.js, loadPlaywright). The generated
 * workflow cannot rely on that fallback: it installs Chromium with the project's
 * `playwright install`, so the project needs the package that has that command.
 */
function requireProjectPlaywright(projectDir) {
    for (const name of ['playwright', '@playwright/test']) {
        if (findPackageJson(name, projectDir)) return name;
    }
    throw new CaptureWebError(`The capture workflow needs "playwright" installed in ${projectDir} (for example: npm install --save-dev playwright). The workflow installs Chromium with the project's own Playwright.`);
}

/** True when the Storybook main file names this package as its framework. Read as text: the file could not be loaded. */
function mainFileNamesFramework(configDir, name) {
    try {
        const file = fs.readdirSync(configDir).find((entry) => /^main\.[cm]?[jt]sx?$/.test(entry));
        const text = fs.readFileSync(path.join(configDir, file), 'utf8');
        const at = text.search(/\bframework\b\s*:/);
        return at !== -1 && text.slice(at, at + 300).includes(name);
    } catch {
        return false;
    }
}

/**
 * Storybook's "failed to load the following preset" says a package the config names could not
 * be loaded. Most often the project is on a framework capture web does not work with, or its
 * dependencies are not installed. This turns that into the plain reason and keeps Storybook's
 * own error as the detail. Any other error is returned unchanged.
 */
function explainPresetFailure(error, { projectDir, configDir }) {
    const raw = String((error && error.message) || error);
    const match = /failed to load the following preset:\s*((?:@[^/\s]+\/)?[^/\s.]+)/.exec(raw);
    if (!match) return error;
    const name = match[1];
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const cause = lines.find((line) => /^\w*Error\b/.test(line));
    const detail = ['Detail from Storybook:', lines[0], cause].filter(Boolean).join(' ');
    const installed = Boolean(findPackageJson(name, projectDir));
    const isFramework = mainFileNamesFramework(configDir, name);
    const notInstalled = installed ? '' : ', which is also not installed in ' + projectDir;
    if (isFramework && !/-vite$/.test(name)) {
        return new CaptureWebError(`capture web needs a Vite-based Storybook framework (for example @storybook/react-vite); this project's Storybook config names "${name}"${notInstalled}. Build Storybook and use \`scry-deployer\` to deploy it instead.\n   ${detail}`);
    }
    if (!installed) {
        return new CaptureWebError(`The Storybook config names "${name}", which is not installed in ${projectDir}. Install the project's dependencies with its package manager, then run this again.\n   ${detail}`);
    }
    return new CaptureWebError(`Could not load the Storybook config: "${name}" is installed but did not load.\n   ${detail}`);
}

/** Resolves with what was found, or rejects with a CaptureWebError that says what is missing. */
async function checkCaptureWebProject({ projectDir, configDir }) {
    let sb;
    try {
        sb = await loadStorybookProject({ projectDir, configDir });
    } catch (error) {
        throw error instanceof CaptureWebError ? error : explainPresetFailure(error, { projectDir, configDir });
    }
    const vite = await loadVite(sb);
    const playwrightPackage = requireProjectPlaywright(projectDir);
    return {
        storybookVersion: sb.storybookVersion,
        frameworkName: sb.frameworkName,
        rendererName: sb.rendererName,
        viteVersion: vite.version,
        playwrightPackage,
    };
}

/**
 * The environment the check's child process gets.
 *
 * The check loads the project's Storybook main file, its presets and its Vite config: project
 * code runs, as it does when Storybook starts. That code has no use for credentials, so they
 * are removed first:
 *   - GITHUB_TOKEN, GH_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, NPM_TOKEN,
 *     NODE_AUTH_TOKEN, and npm's own auth settings (npm_config_*auth*);
 *   - every SCRY_* and STORYBOOK_DEPLOYER_* variable whose name says it is a key, token,
 *     secret or password (for example SCRY_API_KEY, STORYBOOK_DEPLOYER_API_KEY).
 * Everything else is passed through: a project's config may read its own variables.
 */
const REMOVED_ENV_NAMES = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']);
function isCredentialName(name) {
    const upper = String(name).toUpperCase();
    if (REMOVED_ENV_NAMES.has(upper)) return true;
    if (upper.startsWith('NPM_CONFIG_') && upper.includes('AUTH')) return true;
    const ours = upper.startsWith('SCRY_') || upper.startsWith('STORYBOOK_DEPLOYER_');
    return ours && ['KEY', 'TOKEN', 'SECRET', 'PASSWORD'].some((word) => upper.includes(word));
}
function checkEnvironment(env = process.env) {
    const out = {};
    for (const [name, value] of Object.entries(env)) {
        if (!isCredentialName(name)) out[name] = value;
    }
    return out;
}

function nodeIsOlderThanNeeded(version = process.versions.node) {
    const [major, minor] = String(version).split('.').map(Number);
    return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

/**
 * The same check in a child process, as `{ ok: true, info }` or `{ ok: false, reason }`.
 *
 * Loading a project's Storybook config changes the working directory and the environment, and
 * the project's presets may leave timers or watchers open. A child keeps all of that away from
 * a command that goes on to write files and run git. The child runs project code, so it gets
 * an environment without credentials (checkEnvironment above).
 */
function checkCaptureWebProjectIsolated({ projectDir, configDir }, deps = {}) {
    const child = (deps.spawnSync || spawnSync)(process.execPath, [__filename, projectDir, configDir], {
        cwd: projectDir,
        env: checkEnvironment(deps.env || process.env),
        encoding: 'utf8',
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
    });
    const line = String(child.stdout || '').split('\n').reverse().find((text) => text.startsWith(RESULT_MARK));
    let result = null;
    if (line) {
        try {
            result = JSON.parse(line.slice(RESULT_MARK.length));
        } catch {
            result = null;
        }
    }
    if (!result) {
        const why = child.error && child.error.code === 'ETIMEDOUT'
            ? `the Storybook config did not finish loading in ${CHECK_TIMEOUT_MS / 1000} s`
            : (String(child.stderr || '').trim().split('\n').pop() || (child.error && child.error.message) || `the check exited with code ${child.status}`);
        result = { ok: false, reason: `Could not check the project: ${why}` };
    }
    // Only for a failure to load: a clear refusal (wrong Storybook, no Vite) needs no second guess.
    if (!result.ok && /^Could not (load|check)/.test(result.reason) && nodeIsOlderThanNeeded()) {
        result.reason += ` (This check ran on Node ${process.versions.node}; Storybook 10 and capture web need Node ${MIN_NODE.join('.')} or newer.)`;
    }
    return result;
}

module.exports = { checkCaptureWebProject, checkCaptureWebProjectIsolated, checkEnvironment, explainPresetFailure, requireProjectPlaywright, nodeIsOlderThanNeeded };

if (require.main === module) {
    const [projectDir, configDir] = process.argv.slice(2);
    const finish = (result) => {
        process.stdout.write(`\n${RESULT_MARK}${JSON.stringify(result)}\n`, () => process.exit(0));
    };
    const reasonOf = (error) => {
        if (error instanceof CaptureWebError) return error.message;
        return `Could not check the project: ${error && error.message ? error.message : error}`;
    };
    checkCaptureWebProject({ projectDir: path.resolve(projectDir), configDir: path.resolve(configDir) })
        .then((info) => finish({ ok: true, info }))
        .catch((error) => finish({ ok: false, reason: reasonOf(error) }));
}
