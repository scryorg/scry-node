/**
 * Can this project use `scry-deployer capture web`?
 *
 * Asked by `init --capture web` and `update-workflows --capture web` before they write anything.
 * It is the same detection a capture runs (Storybook 10, a Vite framework, the React renderer,
 * Vite), plus one thing only the generated workflow needs: Playwright in the project itself,
 * because the workflow installs Chromium with the project's Playwright.
 */
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
 * A capture run by hand can fall back to the deployer's own Playwright; a workflow cannot rely
 * on that, because it runs the project's `playwright install`.
 */
function requireProjectPlaywright(projectDir) {
    for (const name of ['playwright', '@playwright/test']) {
        if (findPackageJson(name, projectDir)) return name;
    }
    throw new CaptureWebError(`The capture workflow needs "playwright" installed in ${projectDir} (for example: npm install --save-dev playwright). The workflow installs Chromium with the project's own Playwright.`);
}

/** Resolves with what was found, or rejects with a CaptureWebError that says what is missing. */
async function checkCaptureWebProject({ projectDir, configDir }) {
    const sb = await loadStorybookProject({ projectDir, configDir });
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

function nodeIsOlderThanNeeded(version = process.versions.node) {
    const [major, minor] = String(version).split('.').map(Number);
    return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

/**
 * The same check in a child process, as `{ ok: true, info }` or `{ ok: false, reason }`.
 *
 * Loading a project's Storybook config changes the working directory and the environment, and
 * the project's presets may leave timers or watchers open. A child keeps all of that away from
 * a command that goes on to write files and run git.
 */
function checkCaptureWebProjectIsolated({ projectDir, configDir }) {
    const child = spawnSync(process.execPath, [__filename, projectDir, configDir], {
        cwd: projectDir,
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

module.exports = { checkCaptureWebProject, checkCaptureWebProjectIsolated, requireProjectPlaywright, nodeIsOlderThanNeeded };

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
