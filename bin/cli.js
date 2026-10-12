#!/usr/bin/env node

const { initTelemetry, captureCliError, flushTelemetry, redactArgv } = require('../lib/telemetry.js');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { zipDirectory } = require('../lib/archive.js');
const { getApiClient, uploadBuild, sanitizeServerText } = require('../lib/apiClient.js');
const { removeDeltaBundle } = require('../lib/deltaUpload.js');
const { createLogger } = require('../lib/logger.js');
const { ApiError, UserInputError } = require('../lib/errors.js');
const { loadConfig } = require('../lib/config.js');
const { captureScreenshots } = require('../lib/screencap.js');
const { analyzeStorybook } = require('../lib/analysis.js');
const { runCoverageAnalysis, loadCoverageReport, extractCoverageSummary } = require('../lib/coverage.js');
const { postPRComment } = require('../lib/pr-comment.js');
const { runInit } = require('../lib/init.js');
const { runUpdateWorkflows } = require('../lib/update-workflows.js');
const { runQueueImageUpload } = require('../lib/imageUpload.js');
const { runLocalImageProcessing } = require('../lib/localImageProcessing.js');
const { resolveBuildGitContext } = require('../lib/gitContext.js');
const { countMetadataEntries, readSbcovManifest, droppedReasons } = require('../lib/metadataArchive.js');
const { checkForNewerVersion } = require('../lib/versionCheck.js');
const { version: DEPLOYER_VERSION } = require('../package.json');
const ciTimings = require('../lib/ciTimings.js');
const { runUploadBundle } = require('../lib/uploadCommand.js');
const { runImport } = require('../lib/importCommand.js');
const { writeAnalysisBundle } = require('../lib/analysisBundle.js');

async function runAnalysis(argv) {
    const logger = createLogger(argv);
    logger.info('📊 Starting Storybook analysis...');
    // Credentials masked: this line is also a Sentry breadcrumb.
    logger.debug(`Received arguments: ${JSON.stringify(redactArgv(argv))}`);

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storybook-analysis-'));

    try {
        // 1. Capture screenshots if storybook URL provided
        if (argv.storybookUrl) {
            logger.info(`1/4: Capturing screenshots from '${argv.storybookUrl}'...`);
            await captureScreenshots(argv.storybookUrl, argv.storycapOptions || {});
            logger.success('✅ Screenshots captured');
        } else {
            logger.info('1/4: Skipping screenshot capture (no Storybook URL provided)');
        }

        // 2. Analyze stories and map screenshots
        logger.info('2/4: Analyzing stories and mapping screenshots...');
        const analysisResults = analyzeStorybook({
            storiesDir: argv.storiesDir,
            screenshotsDir: argv.screenshotsDir,
            project: argv.project,
            version: argv.version
        });
        logger.success(`✅ Found ${analysisResults.summary.totalStories} stories (${analysisResults.summary.withScreenshots} with screenshots)`);
        logger.debug(`Analysis complete: ${JSON.stringify(analysisResults.summary)}`);

        // 3-4. Write an SCF bundle and send it through the bundle route. The old master ZIP
        // went to the presigned storybook.zip route, which creates a build and never queues
        // it, so no analyze build was ever indexed (capture-sources ledger F3).
        logger.info('3/4: Writing the capture bundle (scf.json + images)...');
        const bundleDir = path.join(workDir, 'bundle');
        const gitContext = resolveBuildGitContext();
        const written = writeAnalysisBundle(analysisResults, bundleDir, { toolVersion: DEPLOYER_VERSION, gitContext });
        logger.success(`✅ Bundle written: ${written.captured} captures, ${written.skipped} stories without a screenshot`);

        logger.info('4/4: Validating and uploading the bundle...');
        const outcome = await runUploadBundle({
            path: bundleDir,
            project: argv.project,
            version: argv.version,
            apiUrl: argv.apiUrl,
            apiKey: argv.apiKey,
        }, { logger });
        if (outcome.exitCode !== 0) {
            process.exitCode = 1;
            return;
        }

        logger.success('\n🎉 Analysis complete! 🎉');

    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

/**
 * Decide whether this deploy runs analysis (screenshots + metadata for search).
 *
 * On by default since 0.7.0: an unset flag used to mean "off", and a workflow
 * that forgot --with-analysis uploaded, printed success and indexed nothing
 * (ISSUES.md #50). Opting out is explicit, and the caller says so in the log.
 *
 * @param {any} argv
 * @returns {{enabled:boolean, optOut:string|null}}
 */
function resolveAnalysis(argv) {
    if (argv.analysis === false) {
        return { enabled: false, optOut: '--no-analysis' };
    }
    if (argv.withAnalysis === false) {
        return { enabled: false, optOut: 'withAnalysis is false in .storybook-deployer.json or SCRY_WITH_ANALYSIS' };
    }
    if (argv.withAnalysis === true || argv.analysis === true) {
        return { enabled: true, optOut: null };
    }
    // Analysis runs inside the coverage tool, so --no-coverage without an
    // explicit analysis flag is an opt-out of both. With --with-analysis it is
    // not, and ends red below (analysis asked for, nothing produced).
    if (argv.coverage === false) {
        return { enabled: false, optOut: '--no-coverage (analysis runs inside coverage)' };
    }
    // A supplied report skips the coverage run, and with it the capture.
    if (argv.coverageReport) {
        return { enabled: false, optOut: '--coverage-report (a supplied report has no screenshots)' };
    }
    return { enabled: true, optOut: null };
}

/**
 * Stories the coverage report says exist, and the first capture error, for
 * the "captured 0 of N" line. Both optional: the report shape is sbcov's.
 */
function describeCapture(report) {
    const total = report?.summary?.totalStories ?? report?.execution?.summary?.total ?? null;
    const f = report?.execution?.failures?.[0];
    const firstError = f ? `${f.storyId || f.storyName || 'a story'}: ${String(f.message || f.failureType || '').split('\n')[0]}` : null;
    return { total: typeof total === 'number' ? total : null, firstError };
}

/**
 * The installed scry-sbcov's version, when the deployer runs its own copy.
 * Unknown (undefined) under SCRY_SBCOV_CMD or when it cannot be resolved.
 */
function installedSbcovVersion() {
    if (process.env.SCRY_SBCOV_CMD) return undefined;
    try {
        return require('@scrymore/scry-sbcov/package.json').version;
    } catch {
        return undefined;
    }
}

/**
 * The pre-upload part of the CI timings record (storybook-preview-ci-runtime,
 * ISSUES.md #54): phases measured so far, story counts, versions, runner, run
 * ids and the execute budget. Anything not measured is left out, never 0.
 */
function buildPreUploadTimings({ coverage, manifest, archiveMs, env = process.env }) {
    // sbcov 0.7 writes its execution block into the manifest (in the metadata
    // archive) as `execution`, and into the report at `execution.timing`; the
    // report is the fallback when there is no archive (execution without screenshots).
    const fromReport = coverage.coverageReport?.execution?.timing;
    const execution = manifest?.execution
        || (fromReport && typeof fromReport === 'object' && !Array.isArray(fromReport) ? fromReport : null);
    // No report = sbcov crashed or never ran: its wall time is neither an
    // analysis nor an execute time, so neither is recorded.
    const executedTimes = !coverage.coverageReport ? {} : ciTimings.splitSbcovTime({
        sbcovWallMs: coverage.sbcovWallMs ?? null,
        manifestExecution: execution,
        report: coverage.coverageReport,
        executed: Boolean(coverage.executed),
    });
    const stories = coverage.executed
        ? ciTimings.storyCounts({ manifest, manifestExecution: execution, report: coverage.coverageReport })
        : undefined;
    const timeLostMs = ciTimings.timeLost(execution);
    const share = typeof execution?.failedTimeShare === 'number' && execution.failedTimeShare >= 0 && execution.failedTimeShare <= 1
        ? execution.failedTimeShare
        : undefined;
    const concurrency = Number.isInteger(execution?.concurrency) && execution.concurrency > 0 ? execution.concurrency : undefined;

    let budget = null;
    if (executedTimes.executeMs !== undefined) {
        budget = ciTimings.resolveBudget({ declared: stories?.declared ?? null, env });
    }
    const overBudget = budget && budget.budgetMs !== null ? executedTimes.executeMs > budget.budgetMs : undefined;

    const record = ciTimings.compact({
        ...executedTimes,
        archiveMs,
        stories,
        timeLostMs,
        failedTimeShare: share,
        concurrency,
        sbcovVersion: typeof manifest?.sbcovVersion === 'string' ? manifest.sbcovVersion.slice(0, 40) : installedSbcovVersion(),
        deployerVersion: DEPLOYER_VERSION,
        runner: ciTimings.detectRunner(env),
        ci: ciTimings.readCiContext(env) || undefined,
        budgetMs: budget?.budgetMs ?? undefined,
        overBudget,
    });
    return { record, budget };
}

/** The budget-exceeded warning (workflow annotation on GitHub Actions, plus a log line). */
function reportOverBudget(record, budget, n, stories, fmt, lost, logger, env) {
    const formula = `${budget.baseS} s + ${budget.perStoryS} s × ${typeof n === 'number' ? n : '?'} stories`;
    const detail = `Executing ${stories} took ${fmt(record.executeMs)}, over the ${fmt(record.budgetMs)} budget (${formula})` +
        (lost ? `. Time lost: ${lost}` : '') +
        '. Set SCRY_EXECUTE_BUDGET_BASE_S / SCRY_EXECUTE_BUDGET_PER_STORY_S to change the budget.';
    if (env.GITHUB_ACTIONS === 'true') {
        // A workflow command must start the line, on stdout.
        process.stdout.write(`::warning title=Scry story execution over budget::${detail.replace(/\r?\n/g, ' ')}\n`);
    }
    logger.warn(`⚠️  Story execution took ${fmt(record.executeMs)}, over its ${fmt(record.budgetMs)} budget (${formula}).`);
}

/**
 * The duration line, and the budget warning when story execution took longer
 * than its budget (G6). A warning, never a failure: a slow run is information.
 */
function reportExecutionTime(record, budget, logger, env = process.env) {
    if (budget) {
        for (const w of budget.warnings) logger.warn(`⚠️  ${w}.`);
    }
    if (record.executeMs === undefined) return;
    const fmt = ciTimings.formatDuration;
    const n = record.stories?.declared;
    const storiesWord = n === 1 ? 'story' : 'stories';
    const stories = typeof n === 'number' ? `${n} ${storiesWord}` : 'stories';
    const workerWord = record.concurrency === 1 ? 'worker' : 'workers';
    const workers = record.concurrency ? ` (${record.concurrency} ${workerWord})` : '';
    const source = record.executeSource === 'deployer-wall' ? ' [sbcov run wall time; this scry-sbcov does not report execution time]' : '';
    const budgetText = record.budgetMs !== undefined ? `, budget ${fmt(record.budgetMs)}` : ', no budget (story count unknown)';
    const lost = ciTimings.describeTimeLost(record.timeLostMs);
    const lostSuffix = lost ? `; time lost: ${lost}` : '';
    logger.info(`Story execution: ${stories} in ${fmt(record.executeMs)}${workers}${budgetText}${lostSuffix}${source}.`);

    if (record.overBudget) reportOverBudget(record, budget, n, stories, fmt, lost, logger, env);
}

/** Log why the ci-timings upload wasn't stored, based on `sent.reason`. */
function warnNotStoredReason(sent, logger) {
    if (sent.reason === 'not-supported') {
        logger.warn('⚠️  CI timings: the upload service does not record CI timings yet; not stored.');
    } else if (sent.reason === 'rejected') {
        logger.warn(`⚠️  CI timings: the upload service rejected the CI timings (${sent.detail}); not stored.`);
    } else if (sent.reason === 'build-not-found') {
        logger.warn(`⚠️  CI timings: the upload service has the CI-timings route but did not find this build (${sent.detail}); not stored.`);
    } else if (sent.reason === 'no-build-id') {
        logger.warn('⚠️  CI timings: the upload service returned no build id, so the final record could not be sent; not stored.');
    } else {
        logger.warn(`⚠️  CI timings: could not reach the upload service (${sent.detail}); not stored.`);
    }
}

/**
 * Finish the record (upload, total, whole-job time) and send it to the
 * ci-timings route. Never throws and never changes the exit code; every way it
 * can fall short is said once, and counted in the summary line.
 */
async function recordCiTimings({ apiClient, argv, preUpload, uploadMs, totalTimer, uploadResult, logger }) {
    const summary = { notStored: 0 };
    try {
        const job = await ciTimings.fetchJobElapsed();
        const record = ciTimings.compact({
            ...preUpload,
            uploadMs,
            ...job,
            deployerTotalMs: totalTimer.stop(),
        });
        // The build this deploy created, from the presigned-URL response.
        const buildId = uploadResult?.zipUpload?.buildId;
        const sent = await ciTimings.sendCiTimings(apiClient, { project: argv.project, version: argv.version }, buildId, record);
        if (sent.stored && sent.dropped) {
            summary.droppedFields = sent.dropped.length;
            logger.warn(`⚠️  CI timings: stored, but the upload service dropped ${sent.dropped.length} field(s) it would not accept: ${sent.dropped.join(', ')}.`);
        }
        if (!sent.stored) {
            summary.notStored += 1;
            warnNotStoredReason(sent, logger);
        }
        const fmt = ciTimings.formatDuration;
        // "recorded" only when the service kept it; otherwise it was measured and printed here.
        const verb = sent.stored ? 'CI time recorded' : 'CI time measured (not stored)';
        if (record.jobTimeSource === 'actions-api') {
            logger.info(`${verb}: deployer ${fmt(record.deployerTotalMs)}, job ${fmt(record.jobElapsedMs)} so far (Actions API).`);
        } else {
            logger.info(`${verb}: deployer time only (job start unknown: ${record.jobTimeReason}). Deployer ${fmt(record.deployerTotalMs)}.`);
        }
    } catch (err) {
        // Nothing in here may fail a deploy; say what did not happen.
        summary.notStored += 1;
        logger.warn(`⚠️  CI timings: not recorded (${err.message}).`);
    }
    let finalLine;
    if (summary.notStored) {
        finalLine = `CI timings: final record not stored (${summary.notStored}); the build's time is incomplete, the deploy is not affected.`;
    } else if (summary.droppedFields) {
        finalLine = `CI timings: stored with the build, ${summary.droppedFields} field(s) dropped by the service.`;
    } else {
        finalLine = 'CI timings: stored with the build.';
    }
    logger.info(finalLine);
    return summary;
}

/**
 * Count what the metadata archive holds and warn about drops, before deciding whether to
 * upload it. An archive whose metadata.json is [] is what sbcov writes when every story failed
 * after the browser launched; queuing it produced a build marked `completed` with nothing in
 * it, and a green run (ISSUES.md #50). Hosting still goes ahead (the preview link stays
 * useful); the archive is not sent and the run ends red (reportIndexingOutcome).
 * @returns {{metadataToSend:string|null, emptyArchive:object|null, dropped:object|null, sbcovManifest:object|null}}
 */
/** sbcov 0.5.2+ lists every story it could not capture in the archive; read it whatever sbcov's
 * exit code (a sbcov that ignored --max-dropped still names its drops, and the allowance is
 * applied here). */
function readDroppedFromManifest(metadataZipPath, coverage, logger) {
    const { manifest, error: manifestError } = readSbcovManifest(metadataZipPath);
    if (manifestError) {
        logger.warn(`⚠️  ${manifestError}; dropped stories cannot be counted for this build.`);
        return { sbcovManifest: null, dropped: null };
    }
    if (!manifest) return { sbcovManifest: null, dropped: null };
    const allowed = coverage.effectiveMaxDropped ?? 0;
    const n = manifest.dropped.length;
    const reasons = n ? ` (${droppedReasons(manifest.dropped)})` : '';
    logger.info(`scry-sbcov: ${manifest.captured ?? '?'}/${manifest.declared ?? '?'} stories captured, ${n} not captured${reasons}.`);
    return { sbcovManifest: manifest, dropped: { n, allowed, reasons, declared: manifest.declared, captured: manifest.captured } };
}

/** Count what the metadata archive holds; an archive with 0 entries must not be uploaded
 * (queuing it produced a build marked `completed` with nothing in it — ISSUES.md #50). */
function checkEmptyArchive(metadataZipPath, coverageReport, logger) {
    const counted = countMetadataEntries(metadataZipPath);
    if (counted.count === 0) {
        return { emptyArchive: { ...describeCapture(coverageReport), note: counted.error }, metadataToSend: null };
    }
    if (counted.count === null) {
        // Could not read it. Send it anyway (the service decides) but say
        // so: this is not a count of zero.
        logger.warn(`⚠️  Could not count the stories in the analysis archive (${counted.error}); uploading it anyway.`);
    } else {
        logger.info(`Analysis archive holds ${counted.count} captured ${counted.count === 1 ? 'story' : 'stories'}.`);
    }
    return { emptyArchive: null, metadataToSend: metadataZipPath };
}

function analyzeMetadataArchive(coverage, metadataZipPath, coverageReport, logger) {
    if (coverage.executionUnsupported && coverage.executionUnsupported.length) {
        logger.warn(
            `⚠️  The installed scry-sbcov does not support ${coverage.executionUnsupported.join(' / ')}, so SCRY_CONCURRENCY /\n` +
            '   SCRY_RENDER_TIMEOUT_MS were not applied. Upgrade @scrymore/scry-sbcov to 0.7 or later.'
        );
    }
    if (coverage.maxDroppedUnsupported) {
        logger.warn(
            '⚠️  The installed scry-sbcov does not support --max-dropped, so stories that fail to\n' +
            '   capture are not counted by it. Upgrade @scrymore/scry-sbcov to 0.5.2 or later.'
        );
    }
    let sbcovManifest = null;
    let dropped = null;
    let emptyArchive = null;
    let metadataToSend = metadataZipPath;
    if (metadataZipPath) {
        ({ sbcovManifest, dropped } = readDroppedFromManifest(metadataZipPath, coverage, logger));
    }
    if (metadataZipPath) {
        ({ emptyArchive, metadataToSend } = checkEmptyArchive(metadataZipPath, coverageReport, logger));
    }
    return { metadataToSend, emptyArchive, dropped, sbcovManifest };
}

/** Upload the archive + coverage + metadata ZIP; returns everything the rest of the deploy needs. */
async function uploadDeployment(argv, outPath, coverageReport, metadataToSend, sbcovManifest, coverage, archiveMs, logger) {
    logger.info('2/3: Uploading to deployment service...');
    const apiClient = getApiClient(argv.apiUrl, argv.apiKey);
    // CI timings, pre-upload part: sent with the request that creates the build.
    const { record: preUpload, budget } = buildPreUploadTimings({ coverage, manifest: sbcovManifest, archiveMs });
    reportExecutionTime(preUpload, budget, logger);
    // Which commit this build is of. `version` is a PR number, a branch, a
    // tag or a short SHA depending on the CI event, so it identifies a
    // deploy but never a commit — without this a search result cannot say
    // which code it reflects (P13a).
    const gitContext = resolveBuildGitContext();
    if (gitContext.commitSha) {
        const branchSuffix = gitContext.branch ? ` on ${gitContext.branch}` : '';
        logger.debug(`Build provenance: ${gitContext.commitSha}${branchSuffix}`);
    } else {
        logger.debug('No git context available; build will record no commit SHA');
    }
    const uploadTimer = ciTimings.startTimer();
    const uploadResult = await uploadBuild(
        apiClient,
        {
            project: argv.project,
            version: argv.version,
        },
        {
            zipPath: outPath,
            coverageReport,
            metadataZipPath: metadataToSend,
            gitContext,
            ciTimings: preUpload,
        }
    );
    const uploadMs = uploadTimer.stop();
    // A metadata upload that failed is the essential part of this deploy
    // failing: no success line may follow it (RCA 2: the log printed
    // "Archive uploaded" and "Upload complete" after the timeout).
    const metadataFailed = uploadResult?.metadataUpload?.success === false;
    if (metadataFailed) {
        logger.info('Storybook ZIP uploaded; the metadata upload failed (see above and below).');
    } else {
        logger.success('✅ Archive uploaded.');
    }
    logger.debug(`Upload result: ${JSON.stringify(uploadResult)}`);
    return { apiClient, preUpload, uploadResult, uploadMs, metadataFailed };
}

async function runDeployment(argv) {
    const totalTimer = ciTimings.startTimer();
    const logger = createLogger(argv);
    logger.info('🚀 Starting deployment...');
    // Credentials masked: this line is also a Sentry breadcrumb.
    logger.debug(`Received arguments: ${JSON.stringify(redactArgv(argv))}`);

    const analysis = resolveAnalysis(argv);
    argv = { ...argv, withAnalysis: analysis.enabled };

    const outPath = path.join(os.tmpdir(), `storybook-deployment-${Date.now()}.zip`);
    let metadataZipPath = null;

    try {
        const coverage = await resolveCoverage(argv, logger);
        const coverageReport = coverage.coverageReport;
        const coverageSummary = coverage.coverageSummary;
        const sbcovFailure = coverage.sbcovFailure || null;
        metadataZipPath = coverage.metadataZipPath;

        if (argv.withAnalysis) {
            logger.info('Running deployment with analysis...');
        }

        const { metadataToSend, emptyArchive, dropped, sbcovManifest } =
            analyzeMetadataArchive(coverage, metadataZipPath, coverageReport, logger);

        // 1. Archive only the static Storybook files.
        logger.info(`1/3: Zipping directory '${argv.dir}'...`);
        const archiveTimer = ciTimings.startTimer();
        await zipDirectory(argv.dir, outPath);
        const archiveMs = archiveTimer.stop();
        logger.success(`✅ Archive created: ${outPath}`);
        logger.debug(`Archive size: ${fs.statSync(outPath).size} bytes`);

        // 2. Upload Storybook ZIP + coverage + metadata ZIP (if present).
        const { apiClient, preUpload, uploadResult, uploadMs, metadataFailed } =
            await uploadDeployment(argv, outPath, coverageReport, metadataToSend, sbcovManifest, coverage, archiveMs, logger);

        await postPRComment(buildDeployResult(argv, coverageSummary, uploadResult), coverageSummary);

        // CI timings, final record. Never fails the deploy (G7).
        await recordCiTimings({ apiClient, argv, preUpload, uploadMs, totalTimer, uploadResult, logger });

        // Report only what actually completed. Uploading is synchronous;
        // indexing is not. A build can fail in the queue seconds after this
        // point — during one run the pipeline died 7s later on a revoked
        // credential — and this command previously printed
        // "Deployment successful" over it, sending people looking for the
        // cause three steps downstream (ISSUES.md #4).
        if (!metadataFailed) logger.success('\n✅ Upload complete.');
        logUploadLinks(argv, coverageSummary, uploadResult, logger, { indexed: !metadataFailed });

        reportIndexingOutcome({ argv, analysis, uploadResult, emptyArchive, sbcovFailure, dropped, logger });

    } finally {
        // 4. Clean up the local archive
        if (fs.existsSync(outPath)) {
            fs.unlinkSync(outPath);
            logger.info(`🧹 Cleaned up temporary file: ${outPath}`);
        }
        if (metadataZipPath && fs.existsSync(metadataZipPath)) {
            fs.unlinkSync(metadataZipPath);
            logger.info(`🧹 Cleaned up temporary file: ${metadataZipPath}`);
        }
        // sbcov 0.8+ writes a Scry Capture Format bundle next to the metadata ZIP; this deploy
        // uploads the metadata ZIP (legacy path, unchanged keys), so the sibling is only removed.
        const scfSibling = metadataZipPath ? metadataZipPath.replace(/\.zip$/i, '') + '.scf.zip' : null;
        if (scfSibling && fs.existsSync(scfSibling)) fs.unlinkSync(scfSibling);
        // The delta bundle (manifest + picture copies) sbcov wrote for the manifest-first upload.
        if (metadataZipPath) {
            removeDeltaBundle(metadataZipPath);
            // The ZIP lives in a private directory of its own (see runCoverage); drop it once empty.
            const zipDir = path.dirname(metadataZipPath);
            if (path.basename(zipDir).startsWith('scry-metadata-')) {
                try { fs.rmdirSync(zipDir); } catch { /* not empty or already gone */ }
            }
        }
    }
}

const HOSTED_NOT_SEARCHABLE =
    '   The Storybook is hosted and browsable, but no component will be\n' +
    '   searchable from this build.';

/** No analysis was requested: hosted but not searchable. */
function reportAnalysisSkipped(analysis, sbcovFailure, logger) {
    logger.info(`\nℹ️  Analysis skipped (${analysis.optOut || 'not requested'}): this build is hosted but NOT searchable.`);
    if (sbcovFailure) {
        // Coverage is optional here; the report is what failed.
        logger.warn(`⚠️  Coverage report not produced: ${sbcovFailure.reason}.`);
    }
}

/** Checked first: the archive was not sent, so whatever the upload result says about metadata
 * is not about this build's stories. */
function reportEmptyArchive(emptyArchive, sbcovFailure, logger) {
    process.exitCode = 1;
    const of = emptyArchive.total !== null ? ` of ${emptyArchive.total}` : '';
    logger.error(
        `\n❌ Analysis captured 0${of} stories, so NOTHING WILL BE INDEXED.\n` +
        (emptyArchive.firstError ? `   First capture error: ${emptyArchive.firstError}\n` : '') +
        (emptyArchive.note ? `   The archive: ${emptyArchive.note}.\n` : '') +
        (sbcovFailure ? `   ${sbcovFailure.reason}.\n` : '') +
        '   The empty archive was not uploaded and no build was queued.\n' +
        HOSTED_NOT_SEARCHABLE
    );
}

/** apiClient turns a rejected upload into {success:false}; the old check tested only that the
 * object existed, printed "uploaded but not queued" and exited 0. */
function reportMetadataUploadFailed(metadataUpload, uploadResult, logger) {
    process.exitCode = 1;
    const zip = uploadResult?.zipUpload || {};
    const buildNumberSuffix = zip.buildNumber !== undefined ? ` (#${zip.buildNumber})` : '';
    const build = zip.buildId ? `Build ${zip.buildId}${buildNumberSuffix}` : 'The build';
    let outcome;
    if (metadataUpload.markedFailed) {
        outcome = `   ${build} is marked failed on the upload service. Re-run this job to index it.`;
    } else if (metadataUpload.markFailedUnsupported) {
        outcome = `   ${build} is left pending: the upload service has no way to mark it failed,\n` +
            '   so it will not show as failed. Re-run this job to index it.';
    } else {
        outcome = `   ${build} is left pending: it could not be marked failed (see the warning above),\n` +
            '   so it will not show as failed. Re-run this job to index it.';
    }
    logger.error(
        `\n❌ The metadata upload failed (${metadataUpload.error || 'no reason given'}), so NOTHING WILL BE INDEXED.\n` +
        (metadataUpload.requestId ? `Ref: ${metadataUpload.requestId}\n` : '') +
        HOSTED_NOT_SEARCHABLE + '\n' +
        outcome
    );
}

function reportMetadataQueued(sbcovFailure, dropped, logger) {
    logger.info(
        '\n⏳ Indexing has been queued, not finished.\n' +
        '   This command cannot confirm it succeeded. Components will not be\n' +
        '   searchable until processing completes, and a failed build reports\n' +
        '   nothing here. Before relying on search, confirm the build shows\n' +
        "   processingStatus 'completed' rather than 'failed'."
    );
    const droppedLine = dropped && dropped.n
        ? `   ${dropped.n} of ${dropped.declared ?? '?'} stories were not captured${dropped.reasons}; see sbcov-manifest.json in the archive.\n`
        : '';
    if (sbcovFailure) {
        // The contract with scry-sbcov (#51): exit 3 = stories were dropped
        // above --max-dropped, and the archive of the ones that captured
        // was written. Those are queued above; the run still ends red.
        process.exitCode = 1;
        logger.error(
            `\n❌ ${sbcovFailure.reason}. The stories that were captured are queued for\n` +
            '   indexing, but this build is incomplete: some components will be\n' +
            '   missing from search. See the scry-sbcov output above.\n' +
            droppedLine
        );
    } else if (dropped && dropped.n > dropped.allowed) {
        // sbcov exited 0 but its manifest lists more drops than allowed: an
        // sbcov that ignored --max-dropped, or one run without it. The
        // allowance is enforced here too, so any dropped story still ends
        // the deploy red (after the rest were queued) unless --max-dropped
        // says otherwise.
        process.exitCode = 1;
        logger.error(
            `\n❌ ${dropped.n} of ${dropped.declared ?? '?'} stories were not captured${dropped.reasons}, more than\n` +
            `   --max-dropped ${dropped.allowed} allows. The ${dropped.captured ?? 'other'} captured stories are queued; the rest\n` +
            '   will not be searchable. See sbcov-manifest.json in the archive, or raise\n' +
            '   --max-dropped (SCRY_MAX_DROPPED) to accept them.'
        );
    }
}

function reportMetadataNotQueued(logger) {
    process.exitCode = 1;
    logger.error(
        '\n❌ Metadata was uploaded but not queued for processing, so NOTHING WILL BE INDEXED.\n' +
        HOSTED_NOT_SEARCHABLE
    );
}

/** The gap between the branches above, and the most damaging state: analysis was asked for,
 * produced nothing, and this command used to say "Upload successful" and stop (ISSUES.md #24). */
function reportNoMetadataProduced(sbcovFailure, logger) {
    process.exitCode = 1;
    logger.error(
        '\n❌ Analysis produced no metadata, so NOTHING WILL BE INDEXED.\n' +
        HOSTED_NOT_SEARCHABLE + '\n\n' +
        (sbcovFailure
            ? `   Cause: ${sbcovFailure.reason}. See the scry-sbcov output above.\n\n`
            : '   The cause is in the coverage output above — commonly a missing Playwright\n' +
              "   browser (install it with the deployer's own Playwright; see the README's\n" +
              '   CI setup) or a TypeScript resolution error in the analyzer.\n\n') +
        '   Exiting non-zero deliberately: a green build here would mean search\n' +
        '   silently returns nothing. Pass --no-analysis to host without indexing.'
    );
}

/**
 * Say what happened to indexing, and set the exit code from it.
 *
 * The rule (ISSUES.md #24, #50): a deploy that was asked to index and will
 * index nothing ends with exit code 1. The Storybook is hosted either way.
 */
function reportIndexingOutcome({ argv, analysis, uploadResult, emptyArchive, sbcovFailure, dropped = null, logger }) {
    const metadataUpload = uploadResult?.metadataUpload || null;

    if (!argv.withAnalysis) return reportAnalysisSkipped(analysis, sbcovFailure, logger);
    // Checked before the metadata-upload branches: the archive was not sent, so whatever the
    // upload result says about metadata is not about this build's stories.
    if (emptyArchive) return reportEmptyArchive(emptyArchive, sbcovFailure, logger);
    if (metadataUpload && metadataUpload.success === false) return reportMetadataUploadFailed(metadataUpload, uploadResult, logger);
    if (metadataUpload?.queued) return reportMetadataQueued(sbcovFailure, dropped, logger);
    if (metadataUpload) return reportMetadataNotQueued(logger);
    return reportNoMetadataProduced(sbcovFailure, logger);
}

/** The parsed argv of the running command (set by middleware); handleError reads --verbose from it. */
let currentArgv = {};

/**
 * The one place every CLI failure ends. Prints a one-line human message, the
 * `Ref: <id>` of the failing response (when it had one) and a suggestion;
 * reports to Sentry (tagged with the request id) and flushes before exiting
 * non-zero. The stack is printed only with --verbose.
 */
async function handleError(error, argv) {
    const logger = createLogger(argv || {});
    const err = error instanceof Error ? error : new Error(String(error));
    // Strip server-provided control sequences, and never echo the API key.
    let message = sanitizeServerText(err.message || 'Unknown error', 400);
    const key = argv && (argv.apiKey || argv['api-key']);
    if (typeof key === 'string' && key.length >= 4) message = message.split(key).join('<redacted>');
    logger.error(`\n\u274c Error: ${message}`);

    if (err instanceof ApiError) {
        if (err.requestId) logger.error(`Ref: ${sanitizeServerText(err.requestId, 64)}`);
        if (err.statusCode === 401) {
            logger.error('Suggestion: Check that your API key is correct and has not expired.');
        } else if (err.statusCode >= 500) {
            logger.error('Suggestion: This seems to be a server-side issue. Please try again later or contact support.');
        }
    }

    if (argv && argv.verbose && err.stack) {
        logger.debug(err.stack);
    }

    // A user's own mistake (wrong folder, no images, missing env var) is printed above with
    // how to fix it and exits 1; it is not a defect, so it is not reported (it only spent
    // error-reporting quota). Everything else is reported.
    if (!(err instanceof UserInputError)) {
        // Report with an allowlisted subset of argv. Sending argv wholesale shipped
        // the customer's --api-key to Sentry on every error.
        captureCliError(err, argv);
        // Ensure the event is sent before the process exits
        try { await flushTelemetry(2000); } catch { /* telemetry must never mask the real error */ }
    }

    process.exit(1);
}

async function main() {
    // Error reporting. Opt out with SCRY_TELEMETRY=0 or DO_NOT_TRACK=1.
    // Configuration and scrubbing live in lib/telemetry.js.
    initTelemetry();

    try {
        // The command handlers registered below do all the work; the parsed argv itself
        // (yargs' .parse() resolution) is never needed here.
        await yargs(hideBin(process.argv))
            // Every failure surfaces as a rejection of parseAsync (below), handled by handleError;
            // yargs must not print usage + a raw error and exit on its own. Usage errors (no Error
            // object, e.g. a bad option) keep yargs' help output.
            .exitProcess(false)
            .fail((msg, err, y) => {
                if (err) throw err;
                y.showHelp('error');
                console.error(`\n${msg}`);
                process.exit(1);
            })
            .middleware((a) => { currentArgv = a; })
            .command('$0', 'Deploy Storybook static build', (yargs) => {
                return yargs
                    .option('dir', {
                        describe: 'Path to the built Storybook directory (e.g., storybook-static)',
                        type: 'string',
                    })
                    .option('api-key', {
                        describe: 'API key for the deployment service',
                        type: 'string',
                    })
                    .option('api-url', {
                        describe: 'Base URL for the deployment service API',
                        type: 'string',
                    })
                    .option('project', {
                        describe: 'Project name/identifier',
                        type: 'string',
                    })
                    .option('deploy-version', {
                        alias: ['v', 'version'],
                        describe: 'Version identifier for the deployment',
                        type: 'string',
                    })
                    // Coverage options (enabled by default)
                    .option('coverage', {
                        describe: 'Run coverage analysis and upload report',
                        type: 'boolean',
                        default: true,
                    })
                    .option('coverage-report', {
                        describe: 'Path to coverage report JSON file (skip analysis and upload this report)',
                        type: 'string',
                    })
                    .option('coverage-fail-on-threshold', {
                        describe: 'Fail if coverage thresholds are not met',
                        type: 'boolean',
                        default: false,
                    })
                    .option('coverage-base', {
                        describe: 'Base branch for new code analysis',
                        type: 'string',
                        default: 'main',
                    })
                    .option('coverage-execute', {
                        describe: 'Execute stories during coverage analysis',
                        type: 'boolean',
                        default: false,
                    })
                    .option('capture-mode', {
                        describe: 'Screenshot framing forwarded to scry-sbcov: root or viewport (unset: sbcov default)',
                        type: 'string',
                        choices: ['root', 'viewport'],
                    })
                    .option('capture-scale', {
                        describe: 'Screenshot device scale factor forwarded to scry-sbcov, 0 < n <= 4 (unset: sbcov default)',
                        type: 'string',
                    })
                    .option('capture-viewport', {
                        describe: 'Browser viewport WIDTHxHEIGHT forwarded to scry-sbcov (unset: sbcov default)',
                        type: 'string',
                    })
                    .option('with-analysis', {
                        describe: 'Capture screenshots and metadata so components are searchable (the default since 0.7.0)',
                        type: 'boolean',
                    })
                    .option('analysis', {
                        describe: 'Pass --no-analysis to host the Storybook without indexing it (nothing will be searchable)',
                        type: 'boolean',
                    })
                    .option('max-dropped', {
                        describe: 'End red (after uploading the rest) when more than this many stories fail to capture. Default 0: any dropped story ends the deploy red. Forwarded to scry-sbcov',
                        type: 'string',
                    })
                    .option('storybook-url', {
                        describe: 'URL of the Storybook for screenshot capture',
                        type: 'string',
                    })
                    .option('stories-dir', {
                        describe: 'Directory containing story files',
                        type: 'string',
                    })
                    .option('screenshots-dir', {
                        describe: 'Directory for screenshots',
                        type: 'string',
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                    });
            }, async (argv) => {
                // Load and merge configuration
                const config = loadConfig(argv);

                // Validate required fields
                if (!config.dir) {
                    throw new UserInputError('--dir is required. You can provide it via CLI arguments, config file, or environment variables.');
                }

                // Validate directory exists and is valid
                if (!fs.existsSync(config.dir)) {
                    throw new UserInputError(`Directory not found at path: ${config.dir}`);
                }
                if (!fs.lstatSync(config.dir).isDirectory()) {
                    throw new UserInputError(`Path is not a directory: ${config.dir}`);
                }

                // Advisory, bounded to 2 s, never fails the deploy.
                await checkForNewerVersion({ currentVersion: DEPLOYER_VERSION, logger: createLogger(config) });

                await runDeployment(config);
            })
            .command('analyze', 'Analyze Storybook stories and generate metadata', (yargs) => {
                return yargs
                    .option('project', {
                        describe: 'Project name/identifier',
                        type: 'string',
                        demandOption: true,
                    })
                    .option('deploy-version', {
                        alias: 'v',
                        describe: 'Version identifier',
                        type: 'string',
                        demandOption: true,
                    })
                    .option('api-key', {
                        describe: 'API key for the deployment service',
                        type: 'string',
                    })
                    .option('api-url', {
                        describe: 'Base URL for the deployment service API',
                        type: 'string',
                    })
                    .option('storybook-url', {
                        describe: 'URL of the Storybook for screenshot capture',
                        type: 'string',
                    })
                    .option('stories-dir', {
                        describe: 'Directory containing story files',
                        type: 'string',
                    })
                    .option('screenshots-dir', {
                        describe: 'Directory for screenshots',
                        type: 'string',
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                    });
            }, async (argv) => {
                // Load and merge configuration
                const config = loadConfig(argv);

                await runAnalysis(config);
            })
            
            .command('import <folder>', 'Import a folder exported from Adobe Bridge (beta): converts, keeps keywords and ratings, uploads', (yargs) => {
                return yargs
                    .positional('folder', { describe: 'The folder exported from Adobe Bridge (only this folder is read)', type: 'string' })
                    .option('project', { describe: 'Project ID', type: 'string' })
                    .option('deploy-version', { alias: 'v', describe: 'Version identifier (default: bundle-<timestamp>)', type: 'string' })
                    .option('api-key', { describe: 'Project API key', type: 'string' })
                    .option('api-url', { describe: 'Upload service URL', type: 'string' })
                    .option('yes', { alias: 'y', describe: 'Confirm that the images may be sent to OpenAI, Gemini and Jina for AI processing (required when not interactive)', type: 'boolean', default: false })
                    .option('dry-run', { describe: 'Build and validate the bundle only; nothing is sent', type: 'boolean', default: false })
                    .option('verbose', { describe: 'Enable verbose logging', type: 'boolean' });
            }, async (argv) => {
                const config = loadConfig(argv);
                const outcome = await runImport({ ...config, folder: argv.folder, yes: argv.yes, dryRun: argv.dryRun });
                process.exitCode = outcome.exitCode;
            })

            .command('upload <path>', 'Validate a Scry Capture Format bundle (dir or .zip) and upload it', (yargs) => {
                return yargs
                    .positional('path', { describe: 'Bundle directory (scf.json + images) or .zip', type: 'string' })
                    .option('project', { describe: 'Project ID', type: 'string' })
                    .option('deploy-version', { alias: 'v', describe: 'Version identifier (default: bundle-<timestamp>)', type: 'string' })
                    .option('api-key', { describe: 'Project API key', type: 'string' })
                    .option('api-url', { describe: 'Upload service URL', type: 'string' })
                    .option('source', { describe: 'Source key "<kind>:<platform>" (default: from scf.json)', type: 'string' })
                    .option('include-source', { describe: "Also upload each capture's component source text (code.componentFile). Off by default: Scry never needs your code", type: 'boolean', default: false })
                    .option('repo-root', { describe: 'Repository root that code.componentFile paths are relative to (default: cwd)', type: 'string' })
                    .option('dry-run', { describe: 'Validate and zip only; print where the ZIP is', type: 'boolean', default: false })
                    .option('verbose', { describe: 'Enable verbose logging', type: 'boolean' });
            }, async (argv) => {
                const config = loadConfig(argv);
                const outcome = await runUploadBundle({ ...config, path: argv.path, includeSource: argv.includeSource, repoRoot: argv.repoRoot, source: argv.source, dryRun: argv.dryRun });
                process.exitCode = outcome.exitCode;
            })
            .command('capture <adapter>', 'Capture stories into a Scry Capture Format bundle (adapters: rn)', (yargs) => {
                return yargs
                    .positional('adapter', { describe: 'Capture adapter', choices: ['rn'] })
                    .option('platform', { describe: 'ios (Simulator, macOS) or android (emulator)', choices: ['ios', 'android'], demandOption: true })
                    .option('device', { describe: 'Simulator name (e.g. "iPhone 16") or AVD name / adb serial', type: 'string' })
                    .option('app', { describe: 'Built app to install first (.app for iOS, .apk for Android)', type: 'string' })
                    .option('app-id', { describe: 'Bundle id / package (default: from app.json)', type: 'string' })
                    .option('open-url', { describe: 'Deep link to open after launch, e.g. exp://127.0.0.1:8081 for Expo Go (with --app-id host.exp.Exponent) or a dev client URL', type: 'string' })
                    .option('build', { describe: 'Build and install the app with `expo run:<platform>` when it is not installed', type: 'boolean', default: false })
                    .option('project-dir', { describe: 'React Native project directory (default: cwd)', type: 'string' })
                    .option('out', { describe: 'Bundle output directory (default: <project>/.scry/capture)', type: 'string' })
                    .option('stories', { describe: 'Comma-separated story ids to capture (default: all)', type: 'string' })
                    .option('metro', { describe: 'Start Metro with STORYBOOK_ENABLED=true when the Storybook channel is not already up', type: 'boolean', default: true })
                    .option('ws-port', { describe: 'Storybook channel port', type: 'number', default: 7007 })
                    .option('settle-timeout', { describe: 'Per-story budget in ms to render and settle (two identical frames)', type: 'number', default: 10000 })
                    .option('safe-area-inset', { describe: 'iOS: top unsafe-area height in points used to flag captures whose story root starts inside it (default: from the simulator model). Flagged captures get x-scry.captureWarnings ["overlaps_top_unsafe_area"]; wrap your stories in a SafeAreaView decorator', type: 'number' })
                    .option('structure', { describe: 'Write an rn-fiber structure tree per story when the app exposes one', type: 'boolean', default: true })
                    .option('verbose', { describe: 'Enable verbose logging', type: 'boolean' });
            }, async (argv) => {
                const { runCaptureRn } = require('../lib/capture/rn.js');
                const logger = createLogger(argv);
                try {
                    const outcome = await runCaptureRn(argv, { logger, toolVersion: DEPLOYER_VERSION, gitContext: resolveBuildGitContext() });
                    process.exitCode = outcome.exitCode;
                } catch (error) {
                    logger.error(`❌ capture rn failed: ${error.message}`);
                    process.exitCode = 1;
                }
            })
            .command('coverage', 'Run only Storybook coverage analysis and write the report to disk', (yargs) => {
                return yargs
                    .option('dir', {
                        describe: 'Path to the built Storybook directory (e.g., storybook-static)',
                        type: 'string',
                        demandOption: true,
                    })
                    .option('coverage-base', {
                        describe: 'Base ref/branch for new code analysis (supports SHAs, origin/main, HEAD~1)',
                        type: 'string',
                        default: 'main',
                        alias: 'coverageBase'
                    })
                    .option('coverage-fail-on-threshold', {
                        describe: 'Fail (exit 1) if coverage thresholds are not met',
                        type: 'boolean',
                        default: false,
                        alias: 'coverageFailOnThreshold'
                    })
                    .option('coverage-execute', {
                        describe: 'Execute stories during coverage analysis (requires playwright in the project)',
                        type: 'boolean',
                        default: false,
                        alias: 'coverageExecute'
                    })
                    .option('capture-mode', {
                        describe: 'Screenshot framing forwarded to scry-sbcov: root or viewport (unset: sbcov default)',
                        type: 'string',
                        choices: ['root', 'viewport'],
                    })
                    .option('capture-scale', {
                        describe: 'Screenshot device scale factor forwarded to scry-sbcov, 0 < n <= 4 (unset: sbcov default)',
                        type: 'string',
                    })
                    .option('capture-viewport', {
                        describe: 'Browser viewport WIDTHxHEIGHT forwarded to scry-sbcov (unset: sbcov default)',
                        type: 'string',
                    })
                    .option('max-dropped', {
                        describe: 'Forwarded to scry-sbcov: fail when more than this many stories fail to capture',
                        type: 'string',
                    })
                    .option('output', {
                        describe: 'Where to write the JSON coverage report',
                        type: 'string',
                        default: './scry-sbcov-report.json'
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                        default: false,
                    });
            }, async (argv) => {
                const logger = createLogger(argv);

                // Capture settings: CLI flag > env > .storybook-deployer.json; unset = sbcov decides.
                const { captureMode, captureScale, captureViewport, maxDropped, concurrency, renderTimeoutMs } = loadConfig(argv);
                const result = await runCoverageAnalysis({
                    storybookDir: argv.dir,
                    baseBranch: argv.coverageBase || 'main',
                    failOnThreshold: Boolean(argv.coverageFailOnThreshold),
                    execute: Boolean(argv.coverageExecute),
                    outputPath: argv.output,
                    keepReport: true,
                    captureMode,
                    captureScale,
                    captureViewport,
                    concurrency,
                    renderTimeoutMs,
                    maxDropped,
                });
                const report = result.report;
                if (result.executionUnsupported && result.executionUnsupported.length) {
                    logger.warn(`⚠️  The installed scry-sbcov does not support ${result.executionUnsupported.join(' / ')}; SCRY_CONCURRENCY / SCRY_RENDER_TIMEOUT_MS not applied.`);
                }

                if (result.sbcovFailure) {
                    const reportSuffix = report ? ` (report written to ${argv.output})` : '';
                    logger.error(`Coverage: ${result.sbcovFailure.reason}${reportSuffix}`);
                    process.exit(1);
                }
                if (!report) {
                    logger.error('Coverage: no report generated (tool failed or returned null)');
                    process.exit(1);
                }

                logger.success(`✅ Coverage report written to ${argv.output}`);
            })

.command('init', 'Setup GitHub Actions workflows for automatic deployment', (yargs) => {
                return yargs
                    .option('project-id', {
                        describe: 'Project ID from Scry dashboard',
                        type: 'string',
                        demandOption: true,
                        alias: 'projectId'
                    })
                    .option('api-key', {
                        describe: 'API key from Scry dashboard',
                        type: 'string',
                        demandOption: true,
                        alias: 'apiKey'
                    })
                    .option('api-url', {
                        describe: 'Scry API URL',
                        type: 'string',
                        default: 'https://storybook-deployment-service.epinnock.workers.dev',
                        alias: 'apiUrl'
                    })
                    .option('skip-gh-setup', {
                        describe: 'Skip GitHub CLI variable setup',
                        type: 'boolean',
                        default: false,
                        alias: 'skipGhSetup'
                    })
                    .option('commit-api-key', {
                        describe: 'Write the API key into the committed config file (not recommended)',
                        type: 'boolean',
                        // False by default. The description has always said "not
                        // recommended" while the default said otherwise, and the
                        // default won: every `init` wrote a customer's key into a
                        // file it then committed.
                        default: false,
                        alias: 'commitApiKey'
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                        default: false
                    });
            }, async (argv) => {
                // Map projectId/apiKey to project/apiKey for consistency
                const initConfig = {
                    project: argv.projectId,
                    apiKey: argv.apiKey,
                    apiUrl: argv.apiUrl,
                    skipGhSetup: argv.skipGhSetup,
                    commitApiKey: argv.commitApiKey,
                    verbose: argv.verbose
                };

                await runInit(initConfig);
            })
            .command('update-workflows', 'Regenerate the Scry GitHub Actions workflows in .github/workflows from this version\'s templates (no API key needed)', (yargs) => {
                return yargs
                    .option('commit', {
                        describe: 'git add and commit the regenerated workflow files',
                        type: 'boolean',
                        default: false,
                    })
                    .option('commit-message', {
                        describe: 'Commit message used with --commit',
                        type: 'string',
                        default: 'chore: update Scry workflows',
                        alias: 'commitMessage',
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                        default: false,
                    });
            }, async (argv) => {
                await runUpdateWorkflows(argv);
            })
            .command('upload-images', 'Upload a folder of images for search indexing', (yargs) => {
                return yargs
                    .option('dir', {
                        describe: 'Path to the image directory',
                        type: 'string',
                        demandOption: true,
                    })
                    .option('project', {
                        describe: 'Project name/identifier',
                        type: 'string',
                        demandOption: true,
                    })
                    .option('local', {
                        describe: 'Process images locally instead of uploading to the queue',
                        type: 'boolean',
                        default: false,
                    })
                    .option('openai-api-key', {
                        describe: 'OpenAI API key (for --local mode)',
                        type: 'string',
                    })
                    .option('gemini-api-key', {
                        describe: 'Gemini API key (for --local mode; or GEMINI_API_KEY). Writes 1024-dim vectors to a g2 collection',
                        type: 'string',
                    })
                    .option('jina-api-key', {
                        describe: 'DEPRECATED: use --gemini-api-key. Jina API key (for --local mode)',
                        type: 'string',
                    })
                    .option('milvus-address', {
                        describe: 'Milvus/Zilliz endpoint (for --local mode)',
                        type: 'string',
                    })
                    .option('milvus-token', {
                        describe: 'Milvus/Zilliz auth token (for --local mode)',
                        type: 'string',
                    })
                    .option('milvus-collection', {
                        alias: 'collection',
                        describe: 'Milvus collection name (for --local mode). With --gemini-api-key it must be a g2 collection (or set MILVUS_COLLECTION_G2)',
                        type: 'string',
                    })
                    .option('api-key', {
                        describe: 'API key for the deployment service (queue mode)',
                        type: 'string',
                    })
                    .option('api-url', {
                        describe: 'Base URL for the deployment service API (queue mode)',
                        type: 'string',
                    })
                    .option('verbose', {
                        describe: 'Enable verbose logging',
                        type: 'boolean',
                    });
            }, async (argv) => {
                const config = loadConfig(argv);

                if (!config.dir) {
                    throw new UserInputError('--dir is required. Provide a path to the image directory.');
                }

                if (!fs.existsSync(config.dir)) {
                    throw new UserInputError(`Directory not found: ${config.dir}`);
                }
                if (!fs.lstatSync(config.dir).isDirectory()) {
                    throw new UserInputError(`Path is not a directory: ${config.dir}`);
                }

                if (config.local) {
                    // Local mode: process images directly via LLM + embeddings + Milvus
                    const resolved = resolveLocalProcessingKeys(config);

                    await runLocalImageProcessing({
                        dir: config.dir,
                        project: config.project,
                        ...resolved,
                        verbose: config.verbose,
                    });
                } else {
                    await runQueueImageUpload(config);
                }
            })
            .command('debug-sentry', 'Test Sentry integration by throwing an error', () => {}, () => {
                throw new Error('Sentry debug error from scry-node CLI');
            })
            .env('STORYBOOK_DEPLOYER')
            .help()
            .alias('help', 'h')
            .version(false)  // Disable built-in version since we use -v for deploy-version
            .parseAsync();

    } catch (error) {
        await handleError(error, currentArgv);
    }
}

/**
 * Resolve the keys `upload-images --local` needs. A Gemini key selects Gemini Embedding 2
 * (1024 dims, g2 collection); otherwise the deprecated Jina key is used, with one warning.
 * Gemini runs read MILVUS_COLLECTION_G2 so a Jina collection env can never leak in (G1).
 *
 * @param {any} config
 */
function resolveLocalProcessingKeys(config) {
    const useGemini = Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY);
    const embedKey = useGemini
        ? { geminiApiKey: { flag: '--gemini-api-key', env: 'GEMINI_API_KEY' } }
        : { jinaApiKey: { flag: '--gemini-api-key', env: 'GEMINI_API_KEY (or the deprecated --jina-api-key / JINA_API_KEY)' } };
    const required = {
        openaiApiKey: { flag: '--openai-api-key', env: 'OPENAI_API_KEY' },
        ...embedKey,
        milvusAddress: { flag: '--milvus-address', env: 'MILVUS_ADDRESS' },
        milvusToken: { flag: '--milvus-token', env: 'MILVUS_TOKEN' },
        milvusCollection: { flag: '--milvus-collection', env: useGemini ? 'MILVUS_COLLECTION_G2' : 'MILVUS_COLLECTION' },
    };

    const resolved = {};
    for (const [key, { flag, env }] of Object.entries(required)) {
        const envName = env.split(' ')[0];
        resolved[key] = config[key] || process.env[envName] || (key === 'jinaApiKey' ? process.env.JINA_API_KEY : undefined);
        if (!resolved[key]) {
            throw new UserInputError(`${flag} or ${env} env var is required for local mode`);
        }
    }

    if (!useGemini) {
        console.warn('[deprecated] --jina-api-key / JINA_API_KEY is deprecated and will be removed; use --gemini-api-key / GEMINI_API_KEY (Gemini Embedding 2, 1024-dim g2 collection).');
    }
    return resolved;
}

/**
 * Resolve coverage settings into a report and a summary.
 *
 * @param {any} argv
 * @param {{info:Function,debug:Function,success:Function,error:Function}} logger
 */
async function resolveCoverage(argv, logger) {
    const enabled = argv.coverage !== false;
    if (!enabled) {
        logger.info('Coverage: disabled (--no-coverage)');
        return { coverageReport: null, coverageSummary: null, metadataZipPath: null, sbcovFailure: null, effectiveMaxDropped: null, maxDroppedUnsupported: false, sbcovWallMs: null, executed: false, executionUnsupported: [] };
    }

    try {
        let report = null;
        let metadataZipPath = null;
        let sbcovFailure = null;
        let effectiveMaxDropped = null;
        let maxDroppedUnsupported = false;
        let sbcovWallMs = null;
        let executed = false;
        let executionUnsupported = [];

        if (argv.coverageReport) {
            logger.info(`Coverage: using existing report at ${argv.coverageReport}`);
            report = loadCoverageReport(argv.coverageReport);
        } else {
            const needsScreenshots = Boolean(argv.withAnalysis);
            const outputZipPath = needsScreenshots
                ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scry-metadata-')), 'metadata.zip')
                : null;

            const result = await runCoverageAnalysis({
                storybookDir: argv.dir,
                baseBranch: argv.coverageBase || 'main',
                failOnThreshold: Boolean(argv.coverageFailOnThreshold),
                execute: Boolean(argv.coverageExecute) || needsScreenshots,
                screenshots: needsScreenshots,
                outputZipPath,
                captureMode: argv.captureMode,
                captureScale: argv.captureScale,
                captureViewport: argv.captureViewport,
                concurrency: argv.concurrency,
                renderTimeoutMs: argv.renderTimeoutMs,
                maxDropped: argv.maxDropped,
            });
            report = result.report;
            sbcovWallMs = result.sbcovWallMs ?? null;
            executed = Boolean(result.executed);
            executionUnsupported = result.executionUnsupported || [];
            metadataZipPath = result.metadataZipPath;
            sbcovFailure = result.sbcovFailure || null;
            effectiveMaxDropped = result.effectiveMaxDropped ?? null;
            maxDroppedUnsupported = Boolean(result.maxDroppedUnsupported);
        }

        const summary = extractCoverageSummary(report);
        if (summary) {
            logger.success('✅ Coverage report ready');
            logger.debug(`Coverage summary: ${JSON.stringify(summary.summary)}`);
        } else {
            logger.info('Coverage: no report generated (tool failed or report shape unexpected)');
        }

        return { coverageReport: report, coverageSummary: summary, metadataZipPath, sbcovFailure, effectiveMaxDropped, maxDroppedUnsupported, sbcovWallMs, executed, executionUnsupported };
    } catch (err) {
        logger.error(`Coverage: failed (${err.message})`);
        throw err;
    }
}

/**
 * Construct public URLs for view and coverage assets.
 *
 * @param {any} argv
 * @param {any|null} coverageSummary
 */
function buildDeployResult(argv, coverageSummary, uploadResult) {
    const project = argv.project || 'main';
    const version = argv.version || 'latest';
    const viewBaseUrl = process.env.SCRY_VIEW_URL || 'https://view.scrymore.com';

    const viewUrl = `${viewBaseUrl.replace(/\/$/, '')}/${project}/${version}/`;

    const coverageUrl = coverageSummary
        ? `${viewBaseUrl.replace(/\/$/, '')}/${project}/${version}/coverage-report.json`
        : null;

    return {
        project,
        version,
        viewUrl,
        coverageUrl,
        coveragePageUrl: coverageUrl,
        visibility: uploadResult?.zipUpload?.visibility,
    };
}

function logUploadLinks(argv, coverageSummary, uploadResult, logger, { indexed = true } = {}) {
    const deployResult = buildDeployResult(argv, coverageSummary, uploadResult);

    if (indexed) {
        logger.success('\n✅ Storybook hosted.\n');
    } else {
        logger.info('\nStorybook hosted (browsable, NOT indexed):\n');
    }
    logger.info(`📖 Storybook: ${deployResult.viewUrl}`);
    if (deployResult.coverageUrl) {
        logger.info(`📊 Coverage:  ${deployResult.coverageUrl}`);
    }

    if (deployResult.visibility === 'private') {
        logger.info('\n🔒 This project is private. Viewers must be logged in to access.');
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    main,
    runDeployment,
    runAnalysis,
    resolveCoverage,
    resolveAnalysis,
    buildPreUploadTimings,
    reportExecutionTime,
    recordCiTimings,
    reportIndexingOutcome,
    buildDeployResult,
    logUploadLinks,
};
