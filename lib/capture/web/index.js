/**
 * `scry-deployer capture web`: capture a project's Storybook stories into an SCF 1.0 bundle
 * without building Storybook.
 *
 * Phases: read the Storybook config -> list stories (Storybook's own index) -> start the
 * project's Vite dev server with a harness page -> render every story in headless Chromium ->
 * write images, structure trees, scf.json and a run report.
 */
const fs = require('fs');
const path = require('path');
const { parseCaptureWebOptions } = require('./options.js');
const { coresSeen, defaultWorkers } = require('./cores.js');
const { buildDeclared } = require('./csf-meta.js');
const { loadStorybookProject, CaptureWebError } = require('./storybook-config.js');
const { loadVite, loadEsbuild, startServer, resolveAliases } = require('./vite-server.js');
const { captureStories, loadPlaywright } = require('./driver.js');
const { changedFiles, selectAffected, buildGraph, toProjectRelative } = require('./affected.js');
const { captureEntry, buildManifest, writeManifest, resetOutDir, fileStem, skippedEntry } = require('./scf-writer.js');
const { validateBundle, printValidation } = require('../../scf.js');

const toPosix = (p) => p.split(path.sep).join('/');

/** A logger whose every line goes to stderr: list modes keep stdout for the list alone. */
function stderrLogger(verbose) {
    const write = (message) => process.stderr.write(`${message}\n`);
    return { info: write, warn: write, error: write, success: write, debug: (message) => verbose && write(message) };
}

async function timed(timings, key, fn) {
    const started = Date.now();
    try {
        return await fn();
    } finally {
        timings[key] = (timings[key] || 0) + (Date.now() - started);
    }
}

/** Which story files a `--changed-since` run touches. */
async function affectedSelection({ sb, vite, options, storyFiles }) {
    const realProject = fs.realpathSync(sb.projectDir);
    const { repoRoot, files } = changedFiles(options.changedSince, { cwd: realProject });
    const changed = files.map((file) => toProjectRelative(file, repoRoot, realProject));
    const alias = await resolveAliases({ sb, vite: vite.vite, storyFiles });
    const { graph, previewInputs } = await buildGraph({
        projectDir: sb.projectDir,
        entries: storyFiles,
        previewFile: sb.previewFile,
        alias,
        esbuild: loadEsbuild(vite.packageJson, sb.projectDir),
    });
    const configDirRel = toPosix(path.relative(sb.projectDir, sb.configDir));
    const picked = selectAffected({ graph, previewInputs, changedFiles: changed, configDirRel });
    const toRepo = (file) => toPosix(path.relative(repoRoot, path.join(realProject, file)));
    return {
        ref: options.changedSince,
        global: picked.global,
        ...(picked.reason ? { reason: picked.reason } : {}),
        projectFiles: picked.files,
        files: picked.files.map(toRepo),
    };
}

/** The stories this run is about: all of them, the `--stories` ids, or those affected since `--changed-since`. */
async function selectStories({ declaredAll, storyFilesAll, options, sb, logger, timingsMs }) {
    let selected = declaredAll;
    if (options.stories) {
        const known = new Set(declaredAll.map((d) => d.id));
        const unknown = options.stories.filter((id) => !known.has(id));
        if (unknown.length) {
            const names = unknown.map((id) => JSON.stringify(id)).join(', ');
            throw new CaptureWebError(`--stories: no story with id ${names} in this Storybook (${declaredAll.length} stories; list them with \`capture web --list\`).`);
        }
        const wanted = new Set(options.stories);
        selected = selected.filter((d) => wanted.has(d.id));
    }
    let vite = null;
    let changedSince = null;
    if (options.changedSince) {
        vite = await loadVite(sb);
        changedSince = await timed(timingsMs, 'affected', () => affectedSelection({ sb, vite, options, storyFiles: storyFilesAll }));
        const files = new Set(changedSince.projectFiles);
        selected = selected.filter((d) => files.has(d.file));
        if (changedSince.global) logger.info(`Every story is affected: ${changedSince.reason}.`);
    }
    return { selected, vite, changedSince };
}

/** Sort the driver's results into captures[] entries, skips and blank suspects, in declared order. */
function collectOutcomes(selected, results) {
    const captures = [];
    const skipped = [];
    const blankSuspect = [];
    for (const d of selected) {
        const outcome = results.get(d.id);
        if (outcome && outcome.status === 'captured') {
            captures.push(captureEntry(d, outcome.result));
            if (outcome.result.blankSuspect) blankSuspect.push(d.id);
        } else {
            const skip = outcome || { reason: 'error', detail: 'the story was never reached' };
            skipped.push(skippedEntry({ id: d.id, reason: skip.reason, detail: skip.detail }));
        }
    }
    return { captures, skipped, blankSuspect };
}

/** The lines a finished run prints; returns how many stories failed (skips that were not asked for). */
function logSummary({ logger, options, captures, skipped, blankSuspect, declared, totalMs }) {
    const dropped = skipped.filter((s) => s.reason !== 'filtered');
    for (const s of skipped) {
        const detail = s.detail ? ` (${String(s.detail).split('\n')[0].slice(0, 200)})` : '';
        logger.warn(`  skipped ${s.id}: ${s.reason}${detail}`);
    }
    if (blankSuspect.length) logger.warn(`  ${blankSuspect.length} capture(s) look blank: ${blankSuspect.slice(0, 10).join(', ')}${blankSuspect.length > 10 ? ', ...' : ''}`);
    logger.info(`\n${captures.length} of ${declared} stories captured, ${skipped.length} skipped (${dropped.length} failed, ${skipped.length - dropped.length} filtered) in ${(totalMs / 1000).toFixed(1)} s.`);
    if (options.writeBundle) logger.info(`Bundle: ${options.outDir}`);
    else logger.info(`Images: ${path.join(options.outDir, 'images')} (changed stories only: no scf.json, this is not an upload bundle)`);
    logger.info(`Report: ${options.report}`);
    return dropped.length;
}

/** The part of the run report that is known before any story is rendered. */
function reportHead({ deps, sb, options, declaredAll, workers, cores, partial, changedSince }) {
    return {
        tool: { name: 'scry-deployer capture web', version: deps.toolVersion },
        storybook: { version: sb.storybookVersion, framework: sb.frameworkName, configDir: toPosix(path.relative(options.projectDir, options.configDir)) },
        partial,
        declaredTotal: declaredAll.length,
        workers,
        cores,
        viewport: options.viewport,
        scale: options.scale,
        fixedTime: options.fixedTime,
        ...(changedSince ? { changedSince: { ref: changedSince.ref, global: changedSince.global, ...(changedSince.reason ? { reason: changedSince.reason } : {}), files: changedSince.files } } : {}),
    };
}

function writeReport(file, report) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * @param {object} argv yargs output
 * @param {{logger: object, toolVersion: string, gitContext?: object, cwd?: string, stdout?: (text: string) => void}} deps
 * @returns {Promise<{exitCode: number, report?: object}>}
 */
async function runCaptureWeb(argv, deps) {
    const options = parseCaptureWebOptions(argv, { cwd: deps.cwd });
    const logger = options.list ? stderrLogger(options.verbose) : deps.logger;
    const print = deps.stdout || ((text) => process.stdout.write(text));
    const timingsMs = {};
    const startedAt = Date.now();
    let viteServer = null;

    // Storybook and Vite print to stdout while they load; in list modes stdout carries the list only.
    const realStdoutWrite = process.stdout.write;
    if (options.list) process.stdout.write = (...args) => process.stderr.write(...args);
    const emit = (text) => (options.list && !deps.stdout ? realStdoutWrite.call(process.stdout, text) : print(text));

    try {
        const sb = await timed(timingsMs, 'loadConfig', () => loadStorybookProject({ projectDir: options.projectDir, configDir: options.configDir }));
        const index = await timed(timingsMs, 'index', () => sb.buildIndex());
        const declaredAll = buildDeclared(index.entries, { projectDir: options.projectDir });
        const storyFilesAll = [...new Set(declaredAll.map((d) => d.file))].sort();

        const picked = await selectStories({ declaredAll, storyFilesAll, options, sb, logger, timingsMs });
        const { selected, changedSince } = picked;
        let { vite } = picked;

        if (options.list) {
            const lines = options.changedSince && !options.listIds ? changedSince.files : selected.map((d) => d.id);
            emit(lines.map((line) => `${line}\n`).join(''));
            return { exitCode: 0 };
        }

        const cores = coresSeen();
        const workers = options.workers || defaultWorkers(cores.cores);
        const partial = Boolean(options.changedSince || options.stories);
        const baseReport = reportHead({ deps, sb, options, declaredAll, workers, cores, partial, changedSince });

        if (!declaredAll.length) throw new CaptureWebError(`This Storybook declares no stories (config: ${options.configDir}).`);
        if (!selected.length) {
            timingsMs.total = Date.now() - startedAt;
            writeReport(options.report, { ...baseReport, bundle: null, declared: 0, captured: 0, skipped: [], retried: [], blankSuspect: [], consoleErrors: [], timingsMs });
            logger.info(`No story is affected by the changes since ${options.changedSince}; nothing to capture. Report: ${options.report}`);
            return { exitCode: 0 };
        }

        resetOutDir(options.outDir);
        const used = new Set();
        const stories = selected.map((d) => ({ id: d.id, file: d.file, exportName: d.exportName, title: d.title, stem: fileStem(d.id, used) }));
        const storyFiles = [...new Set(stories.map((s) => s.file))].sort();

        const playwright = loadPlaywright(options.projectDir);
        vite = vite || (await loadVite(sb));
        logger.info(`Capturing ${stories.length} of ${declaredAll.length} stories (Storybook ${sb.storybookVersion}, ${sb.frameworkName}, Vite ${vite.version}) with ${workers} worker${workers === 1 ? '' : 's'} ...`);
        viteServer = await timed(timingsMs, 'viteStart', () => startServer({ sb, vite: vite.vite, storyFiles, verbose: options.verbose }));

        const run = await captureStories({ url: viteServer.url, stories, options, outDir: options.outDir, workers, playwright, logger });
        Object.assign(timingsMs, run.timingsMs);

        const writeStarted = Date.now();
        const { captures, skipped, blankSuspect } = collectOutcomes(selected, run.results);

        let exitCode = 0;
        if (options.writeBundle) {
            const manifest = buildManifest({ captures, declared: selected.length, skipped, toolVersion: deps.toolVersion, framework: sb.framework, gitContext: deps.gitContext });
            writeManifest(options.outDir, manifest);
            const validation = validateBundle(options.outDir);
            if (!validation.ok) {
                logger.error(`The bundle at ${options.outDir} did not pass SCF validation:`);
                printValidation(validation, logger);
                exitCode = 1;
            }
        }
        timingsMs.write = Date.now() - writeStarted;
        timingsMs.total = Date.now() - startedAt;

        const report = {
            ...baseReport,
            bundle: options.writeBundle ? options.outDir : null,
            declared: selected.length,
            captured: captures.length,
            skipped,
            retried: run.retried,
            blankSuspect,
            browserRelaunches: run.relaunches,
            consoleErrors: run.consoleErrors,
            timingsMs,
        };
        writeReport(options.report, report);

        const dropped = logSummary({ logger, options, captures, skipped, blankSuspect, declared: selected.length, totalMs: timingsMs.total });
        if (dropped > options.maxDropped) {
            logger.error(`${dropped} stories failed to capture, more than --max-dropped ${options.maxDropped}.`);
            exitCode = 1;
        }
        return { exitCode, report };
    } finally {
        process.stdout.write = realStdoutWrite;
        if (viteServer) await viteServer.close().catch(() => {});
    }
}

module.exports = { runCaptureWeb, CaptureWebError };
