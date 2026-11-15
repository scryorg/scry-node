/**
 * `scry upload <dir|zip>`: stage an SCF bundle, apply the source-text opt-in, validate it with
 * the vendored validator, zip it and send it through the upload service's bundle route.
 *
 * Source text (guarantee G6): Scry never needs the customer's code. Without --include-source,
 * nothing under source/ and no capture.sourceText is ever packed — even when the input bundle
 * carries them. With it, each capture's code.componentFile is read from the repository root,
 * copied under source/, and the CLI says so.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    validateBundle,
    printValidation,
    sourceKeyOf,
    zipBundleDir,
    listFiles,
} = require('./scf.js');

const { checkCaptureRecord, sha256 } = require('./captureRecord.js');

const SOURCE_TEXT_MAX_BYTES = 1024 * 1024;
const UNZIP_HELPER = path.join(__dirname, 'scf-unzip.mjs');

class BundleRejectedError extends Error {
    constructor(message, result) {
        super(message);
        this.name = 'BundleRejectedError';
        this.result = result;
    }
}

/** Copy the input (dir or zip) into a fresh staging directory. */
function stageInput(input, stageDir) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
        for (const rel of listFiles(input)) {
            const dest = path.join(stageDir, ...rel.split('/'));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(input, ...rel.split('/')), dest);
        }
        return;
    }
    if (!/\.zip$/i.test(input)) {
        throw new Error(`Not a bundle directory or .zip: ${input}`);
    }
    const result = spawnSync(process.execPath, [UNZIP_HELPER, input, stageDir], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`Could not read ${input}: ${(result.stderr || result.stdout || '').trim()}`);
    }
}

function isWithin(child, root) {
    const rel = path.relative(root, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Real-path confinement (ledger F44): `isWithin()` above is a lexical check on the *pre-resolved*
 * path, and `fs.lstatSync` on the leaf only refuses to follow a symlink at the final path
 * component — neither catches a symlinked *intermediate* directory under the repo root (e.g.
 * `vendor/evilsymlink -> /etc`, with `vendor/evilsymlink/passwd.txt` requested). The OS always
 * resolves intermediate symlinks transparently regardless of lstat vs stat, so the only way to
 * know where a path really lands is to resolve both sides with `fs.realpathSync` and compare.
 * Returns the real path when it is confined, or null when it escapes (or does not exist).
 */
function realpathWithin(abs, root) {
    let realRoot;
    try {
        realRoot = fs.realpathSync(root);
    } catch {
        return null; // the repo root itself does not exist
    }
    let realAbs;
    try {
        realAbs = fs.realpathSync(abs);
    } catch {
        return null; // dangling symlink / does not exist
    }
    return isWithin(realAbs, realRoot) ? realAbs : null;
}

/** Plain UTF-8 text: no NUL byte and a lossless decode. */
function isUtf8Text(buf) {
    if (buf.includes(0)) return false;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return true;
    } catch {
        return false;
    }
}

/**
 * Apply the --include-source decision to a staged SCF bundle, in place.
 *
 * @returns {{included:number, stripped:number, skipped:Array<{file:string, reason:string}>}}
 */
// Start from nothing either way: text left in the input bundle from another run is never
// re-uploaded (the spec's re-packaging case), and the opt-in flag is set only by this run.
function stripExistingSourceText(stageDir, manifest, captures) {
    let stripped = 0;
    for (const capture of captures) {
        if (capture && capture.sourceText) {
            stripped++;
            delete capture.sourceText;
        }
    }
    if (manifest.optIn) {
        delete manifest.optIn.sourceText;
        if (Object.keys(manifest.optIn).length === 0) delete manifest.optIn;
    }
    const sourceDir = path.join(stageDir, 'source');
    if (fs.existsSync(sourceDir)) fs.rmSync(sourceDir, { recursive: true, force: true });
    return stripped;
}

/** Copy each capture's componentFile into source/, mutating captures with the opt-in result. */
function collectSourceText(captures, root, stageDir) {
    const byFile = new Map(); // componentFile -> bundle path, or null when unusable
    const skipped = [];
    for (const capture of captures) {
        const file = capture && capture.code && capture.code.componentFile;
        if (typeof file !== 'string' || file === '') continue;
        if (!byFile.has(file)) {
            byFile.set(file, copySourceFile(file, root, stageDir, skipped));
        }
        const bundlePath = byFile.get(file);
        if (bundlePath) capture.sourceText = { file: bundlePath, path: file };
    }
    const included = [...byFile.values()].filter(Boolean).length;
    return { included, skipped };
}

function applySourceOptIn(stageDir, manifest, { includeSource, repoRoot }) {
    const captures = Array.isArray(manifest.captures) ? manifest.captures : [];
    const stripped = stripExistingSourceText(stageDir, manifest, captures);

    if (!includeSource) return { included: 0, stripped, skipped: [] };

    const root = path.resolve(repoRoot || process.cwd());
    const { included, skipped } = collectSourceText(captures, root, stageDir);
    if (included > 0) manifest.optIn = { ...(manifest.optIn || {}), sourceText: true };
    return { included, stripped, skipped };
}

function copySourceFile(file, root, stageDir, skipped) {
    const abs = path.resolve(root, file);
    if (!isWithin(abs, root)) {
        skipped.push({ file, reason: 'outside the repository root' });
        return null;
    }
    let buf;
    try {
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()) {
            skipped.push({ file, reason: 'not a regular file' });
            return null;
        }
        // F44: the lexical isWithin() above and this lstat only ever inspect the leaf segment;
        // a symlinked directory anywhere ABOVE the leaf (e.g. vendor/evilsymlink -> /etc) is
        // followed transparently by the OS regardless, so real paths must be compared too.
        if (!realpathWithin(abs, root)) {
            skipped.push({ file, reason: 'outside the repository root' });
            return null;
        }
        if (stat.size > SOURCE_TEXT_MAX_BYTES) {
            skipped.push({ file, reason: 'over 1 MB' });
            return null;
        }
        buf = fs.readFileSync(abs);
    } catch {
        skipped.push({ file, reason: 'not found' });
        return null;
    }
    if (!isUtf8Text(buf)) {
        skipped.push({ file, reason: 'not UTF-8 text' });
        return null;
    }
    const posix = path.relative(root, abs).split(path.sep).join('/');
    const bundlePath = `source/${posix}.src.txt`;
    const dest = path.join(stageDir, ...bundlePath.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return bundlePath;
}

/**
 * Validate the staged bundle, unless `capture web` already validated this exact folder: the input
 * is a directory, it matches the record capture left (same files, sizes, times, deployer and
 * validator), and staging left scf.json byte for byte as it was. Anything else, or `--validate`,
 * runs the full validation. Logs which path was taken.
 */
function validateOrSkip(input, stageDir, opts) {
    const { logger } = opts;
    let why = 'forced by --validate';
    if (!opts.validate && opts.includeSource) why = '--include-source adds files';
    else if (!opts.validate) {
        why = 'input is not a folder';
        if (fs.statSync(input).isDirectory()) {
            const check = checkCaptureRecord(input);
            why = check.reason;
            if (check.match) {
                let staged = null;
                try {
                    staged = sha256(fs.readFileSync(path.join(stageDir, 'scf.json')));
                } catch {
                    staged = null;
                }
                if (staged === check.manifestSha256) {
                    logger.info('Validation skipped: capture web validated this exact folder and nothing changed (pass --validate to run it again).');
                    return { ok: true, errors: [], warnings: [], manifest: null, skipped: true };
                }
                why = 'staging changed scf.json';
            }
        }
    }
    logger.info(`Running the full validation (${why}).`);
    return validateBundle(stageDir);
}

/**
 * Stage, opt-in, validate and zip a bundle. Throws BundleRejectedError (after printing every
 * problem) when the validator rejects it.
 *
 * @param {string} input bundle dir or .zip
 * @param {{includeSource?:boolean, repoRoot?:string, source?:string, logger:object, workDir?:string}} opts
 * @returns {Promise<{zipPath:string, stageDir:string, sourceKey:string, manifest:object, legacy:boolean, validation:object, sourceText:{included:number, stripped:number}}>}
 */
/** JSON.parse scf.json, or null on invalid JSON (the validator reports SCF_JSON_INVALID below). */
function readManifestIfValidJson(scfPath) {
    try {
        return JSON.parse(fs.readFileSync(scfPath, 'utf8'));
    } catch {
        return null;
    }
}

/** Apply the --include-source decision to `manifest`, write scf.json back, and log the result. */
function applyAndLogSourceOptIn(stageDir, scfPath, manifest, opts) {
    const { logger } = opts;
    const res = applySourceOptIn(stageDir, manifest, opts);
    fs.writeFileSync(scfPath, JSON.stringify(manifest, null, 2) + '\n');
    for (const s of res.skipped) {
        logger.warn(`Source text not included for ${s.file}: ${s.reason}.`);
    }
    if (opts.includeSource) {
        logger.info(`Uploading source text for ${res.included} components (--include-source)`);
    } else if (res.stripped > 0) {
        logger.info(`Not uploading source text for ${res.stripped} captures that carried it (pass --include-source to include it).`);
    }
    return res;
}

/** A legacy sbcov archive (metadata.json + sbcov-manifest.json) has no source text to add. */
function handleLegacySourceDir(stageDir, opts) {
    const sourceDir = path.join(stageDir, 'source');
    if (fs.existsSync(sourceDir)) fs.rmSync(sourceDir, { recursive: true, force: true });
    if (opts.includeSource) {
        opts.logger.warn('--include-source is ignored for a legacy sbcov archive (metadata.json); it carries no source text.');
    }
}

/**
 * Read scf.json (if present), apply the --include-source decision and write it back; for a
 * legacy sbcov archive (no scf.json), just drop any leftover source/ and warn if asked for it.
 * @returns {{legacy:boolean, sourceText:object, manifest:object|null}}
 */
function stageManifestAndSourceText(stageDir, opts) {
    const scfPath = path.join(stageDir, 'scf.json');
    const legacy = !fs.existsSync(scfPath) && fs.existsSync(path.join(stageDir, 'metadata.json'));
    let sourceText = { included: 0, stripped: 0 };
    let manifest = null;

    if (fs.existsSync(scfPath)) {
        manifest = readManifestIfValidJson(scfPath);
        if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
            sourceText = applyAndLogSourceOptIn(stageDir, scfPath, manifest, opts);
        }
    } else if (legacy) {
        handleLegacySourceDir(stageDir, opts);
    }
    return { legacy, sourceText, manifest };
}

async function prepareBundle(input, opts) {
    const { logger } = opts;
    // F45: this staging dir is scry-node's own local disk footprint of whatever was handed to
    // `scry upload`/`scry analyze` (including, with --include-source, copied repository source
    // text). It must never outlive this call on ANY exit path — a validator reject, a thrown
    // error from stageInput()/applySourceOptIn(), or success (success's caller, uploadCommand.js,
    // owns cleanup from there via the returned workDir). ownsWorkDir is false only when a caller
    // supplied its own workDir, in which case cleanup is that caller's responsibility, not ours.
    const ownsWorkDir = !opts.workDir;
    const workDir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'scry-bundle-'));
    try {
        const stageDir = path.join(workDir, 'bundle');
        fs.mkdirSync(stageDir, { recursive: true });
        stageInput(input, stageDir);

        const { legacy, sourceText, manifest } = stageManifestAndSourceText(stageDir, opts);

        const validation = validateOrSkip(input, stageDir, opts);
        if (!validation.ok) {
            logger.error(`\n❌ The bundle was rejected by the Scry Capture Format validator. Nothing was uploaded.`);
            printValidation(validation, logger);
            throw new BundleRejectedError(`Bundle rejected: ${validation.errors.length} error(s)`, validation);
        }
        if ((validation.warnings || []).length > 0) printValidation(validation, logger);

        const effective = validation.manifest || manifest || {};
        const sourceKey = opts.source || sourceKeyOf(effective);
        const zipPath = path.join(workDir, 'bundle.zip');
        await zipBundleDir(stageDir, zipPath);
        return { zipPath, stageDir, workDir, sourceKey, manifest: effective, legacy, validation, sourceText };
    } catch (error) {
        if (ownsWorkDir) fs.rmSync(workDir, { recursive: true, force: true });
        throw error;
    }
}

module.exports = {
    prepareBundle,
    applySourceOptIn,
    BundleRejectedError,
    SOURCE_TEXT_MAX_BYTES,
};
