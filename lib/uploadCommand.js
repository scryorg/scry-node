/**
 * `scry upload <dir|zip>` — validate an SCF bundle locally, zip it and upload it through the
 * bundle route. Exit code 1 on a local or server-side rejection (every problem is printed).
 */
const fs = require('fs');
const { prepareBundle, BundleRejectedError } = require('./bundle.js');
const { getApiClient, uploadBundle } = require('./apiClient.js');
const { resolveBuildGitContext } = require('./gitContext.js');
const { printValidation, sourceKeyOf } = require('./scf.js');
const { createLogger } = require('./logger.js');

const SOURCE_KEY_RE = /^(?:[a-z][a-z0-9-]{0,63}|x-[a-z0-9][a-z0-9-]{0,61}):[a-z][a-z0-9-]{0,31}$/;

/** Checks argv before touching the filesystem; logs and returns null on any failure. */
function validateUploadInput(argv, logger) {
    const input = argv.path || argv.bundle;
    if (!input || !fs.existsSync(input)) {
        logger.error(`❌ No bundle at ${input || '(none given)'}: pass a bundle directory or .zip.`);
        return null;
    }
    if (argv.source && !SOURCE_KEY_RE.test(argv.source)) {
        logger.error(`❌ --source must look like "<kind>:<platform>" (e.g. storybook-rn:ios), got ${JSON.stringify(argv.source)}.`);
        return null;
    }
    return input;
}

/** prepareBundle(), or null (already logged) on a local or validator rejection. */
async function prepareOrFail(input, argv, logger) {
    try {
        return await prepareBundle(input, {
            includeSource: Boolean(argv.includeSource),
            repoRoot: argv.repoRoot,
            logger,
        });
    } catch (error) {
        if (error instanceof BundleRejectedError) return null;
        logger.error(`❌ ${error.message}`);
        return null;
    }
}

/** Send the validated, staged bundle through the upload service's bundle route. */
async function sendPreparedBundle(prepared, argv, deps, logger) {
    const apiClient = deps.getApiClient(argv.apiUrl, argv.apiKey);
    const gitContext = deps.resolveBuildGitContext();
    const upload = await deps.uploadBundle(
        apiClient,
        { project: argv.project, version: argv.version || `bundle-${Date.now()}` },
        prepared.zipPath,
        { sourceKey: prepared.sourceKey, gitContext, log: logger }
    );
    if (!upload.success) {
        const statusLabel = upload.status ? `HTTP ${upload.status}` : 'no status';
        logger.error(`\n❌ The upload service rejected the bundle (${statusLabel}): ${upload.error}`);
        if (upload.requestId) logger.error(`Ref: ${upload.requestId}`);
        if (upload.errors && upload.errors.length) printValidation({ errors: upload.errors, warnings: [] }, logger);
        return { exitCode: 1, prepared, upload };
    }
    const buildSuffix = upload.buildNumber !== undefined ? ` (build #${upload.buildNumber})` : '';
    logger.success(`✅ Bundle uploaded${buildSuffix}.`);
    if (upload.queued) {
        logger.info('⏳ Indexing has been queued, not finished. Components are searchable once the build shows processingStatus "completed".');
    } else {
        logger.error('❌ The bundle was stored but not queued for processing, so nothing will be indexed.');
        return { exitCode: 1, prepared, upload };
    }
    return { exitCode: 0, prepared, upload };
}

/**
 * @param {object} argv {path, project, version, apiUrl, apiKey, source?, includeSource?, repoRoot?, dryRun?, allowPartialBundle?, verbose?}
 * @param {{logger?:object, deps?:{uploadBundle?:Function, getApiClient?:Function, resolveBuildGitContext?:Function}}} [ctx]
 * @returns {Promise<{exitCode:number, upload?:object, prepared?:object}>}
 */
async function runUploadBundle(argv, ctx = {}) {
    const logger = ctx.logger || createLogger(argv);
    const deps = { uploadBundle, getApiClient, resolveBuildGitContext, ...(ctx.deps || {}) };
    const input = validateUploadInput(argv, logger);
    if (!input) return { exitCode: 1 };

    logger.info(`Validating ${input} ...`);
    const prepared = await prepareOrFail(input, argv, logger);
    if (!prepared) return { exitCode: 1 };

    // `capture web --stories / --changed-since` marks a bundle that holds only some stories.
    if (prepared.manifest && prepared.manifest['x-scry-partial'] === true && !argv.allowPartialBundle) {
        logger.error('❌ This bundle holds only some of the stories (scf.json says "x-scry-partial": true). Uploading it would make every other story look deleted. Capture all stories, then upload.');
        if (prepared.workDir) fs.rmSync(prepared.workDir, { recursive: true, force: true });
        return { exitCode: 1 };
    }

    try {
        const declared = sourceKeyOf(prepared.manifest);
        if (argv.source && !prepared.legacy && argv.source !== declared) {
            logger.error(`❌ --source ${argv.source} does not match the bundle's source (${declared}). Drop --source or fix scf.json.`);
            return { exitCode: 1, prepared };
        }
        const captures = Array.isArray(prepared.manifest.captures) ? prepared.manifest.captures.length : 'sidecar';
        logger.success(`✅ Bundle valid: ${captures} captures, source ${prepared.sourceKey}.`);

        if (argv.dryRun) {
            logger.info(`Dry run: not uploading. Bundle ZIP: ${prepared.zipPath}`);
            return { exitCode: 0, prepared };
        }
        if (!argv.project) {
            logger.error('❌ --project is required to upload.');
            return { exitCode: 1, prepared };
        }

        return await sendPreparedBundle(prepared, argv, deps, logger);
    } finally {
        if (!argv.dryRun && !argv.keepBundle && prepared && prepared.workDir) {
            fs.rmSync(prepared.workDir, { recursive: true, force: true });
        }
    }
}

module.exports = { runUploadBundle, SOURCE_KEY_RE };
