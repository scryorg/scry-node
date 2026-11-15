/**
 * Scry Capture Format (SCF 1.0) helpers for the CLI.
 *
 * The validator is the vendored @scrymore/scf (lib/vendor/scf, source commit in VERSION),
 * the same code the upload service runs (capture-sources contract §2, guarantee G7). It is
 * ESM and this package is CommonJS, so it runs as a child process through its own CLI
 * (`scf validate <dir|zip> --json`): one code path for dirs and zips, and the exact output
 * a customer gets from `npx @scrymore/scf validate`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const archiver = require('archiver');

const VENDOR_DIR = path.join(__dirname, 'vendor', 'scf');
const VALIDATOR_CLI = path.join(VENDOR_DIR, 'cli.js');
const SCF_SCHEMA_URL = 'https://scrymore.com/schemas/scf/1.0.json';

/** The vendored validator's source commit (lib/vendor/scf/VERSION). */
function vendoredScfVersion() {
    try {
        return fs.readFileSync(path.join(VENDOR_DIR, 'VERSION'), 'utf8').trim();
    } catch {
        return 'unknown';
    }
}

/**
 * Validate a bundle directory or .zip with the vendored validator.
 *
 * @param {string} target bundle directory or .zip
 * @returns {{ok:boolean, errors:Array<{code:string,id?:string,path?:string,message:string}>, warnings:Array<object>, manifest:object|null}}
 */
function validateBundle(target) {
    const result = spawnSync(process.execPath, [VALIDATOR_CLI, 'validate', target, '--json'], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    const out = (result.stdout || '').trim();
    try {
        return JSON.parse(out);
    } catch {
        // The validator prints JSON for every bundle it can read; anything else is an
        // unreadable input (missing path, corrupt zip) — report it as a rejection.
        const reason = (result.stderr || out || `exit ${result.status}`).trim();
        return {
            ok: false,
            errors: [{ code: 'BUNDLE_UNREADABLE', message: `The validator could not read ${target}: ${reason}` }],
            warnings: [],
            manifest: null,
        };
    }
}

/** One line per issue, the same layout as `scf validate`. */
function formatIssue(prefix, issue) {
    let loc = '';
    if (issue.id) {
        loc = ` [${issue.id}]`;
    } else if (issue.path) {
        loc = ` [${issue.path}]`;
    }
    return `  ${prefix} ${issue.code}${loc}: ${issue.message}`;
}

/**
 * Print every problem the validator found. Returns the printed lines (tests read them).
 *
 * @param {{errors:Array<object>, warnings:Array<object>}} result
 * @param {{info:Function, error:Function, warn:Function}} logger
 */
function printValidation(result, logger) {
    const lines = [];
    for (const e of result.errors || []) {
        const line = formatIssue('error', e);
        lines.push(line);
        logger.error(line);
    }
    for (const w of result.warnings || []) {
        const line = formatIssue('warn ', w);
        lines.push(line);
        logger.warn(line);
    }
    const summary = `${(result.errors || []).length} error(s), ${(result.warnings || []).length} warning(s).`;
    lines.push(summary);
    logger.info(summary);
    return lines;
}

/** `"<kind>:<platform|web>"` — the contract's sourceKeyOf (same as the validator package). */
function sourceKeyOf(manifest) {
    const source = (manifest && manifest.source) || {};
    return `${source.kind || 'unknown'}:${source.platform || 'web'}`;
}

/**
 * Storybook's story id for a title and an export name (CSF `toId(title, storyNameFromExport(name))`).
 * Kept here so `scry analyze` and `capture rn` produce the same ids the web builds use.
 */
function sanitizeStoryIdPart(value) {
    return String(value)
        .toLowerCase()
        // eslint-disable-next-line no-useless-escape
        .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:",.<>\{\}\[\]\\\/]/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        // Single quantified atom anchored at the string end (no nested/overlapping quantifiers);
        // backtracking here is linear in input length, not a ReDoS.
        // eslint-disable-next-line sonarjs/super-linear-regex
        .replace(/-+$/, '');
}

function storyNameFromExport(exportName) {
    return String(exportName)
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, (c) => c.toUpperCase());
}

function toStoryId(title, exportName) {
    return `${sanitizeStoryIdPart(title)}--${sanitizeStoryIdPart(storyNameFromExport(exportName))}`;
}

/**
 * Zip a bundle directory (every file, paths relative to the directory, POSIX separators).
 *
 * @param {string} dir
 * @param {string} outPath
 * @returns {Promise<{bytes:number, members:string[]}>}
 */
function zipBundleDir(dir, outPath) {
    const members = listFiles(dir);
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', reject);
        output.on('error', reject);
        output.on('close', () => resolve({ bytes: fs.statSync(outPath).size, members }));
        archive.pipe(output);
        for (const rel of members) {
            // PNG data is already compressed: deflate level 9 costs seconds and saves almost nothing, so
        // store those members (zip method 0, which the upload service reads). Text and JSON are deflated.
        archive.file(path.join(dir, ...rel.split('/')), { name: rel, store: /\.png$/i.test(rel) });
        }
        archive.finalize().catch(reject);
    });
}

/** Every regular file under dir, as sorted POSIX paths relative to dir. Symlinks are skipped. */
function listFiles(dir) {
    const out = [];
    const walk = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const childAbs = path.join(abs, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(childAbs, childRel);
            else if (entry.isFile()) out.push(childRel);
        }
    };
    walk(dir, '');
    return out.sort();
}

module.exports = {
    SCF_SCHEMA_URL,
    VALIDATOR_CLI,
    vendoredScfVersion,
    validateBundle,
    printValidation,
    formatIssue,
    sourceKeyOf,
    toStoryId,
    storyNameFromExport,
    zipBundleDir,
    listFiles,
};
