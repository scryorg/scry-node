/**
 * `capture web` flags -> one checked options object. Pure: no file system, no process state.
 */
const path = require('path');

/**
 * The instant `new Date()` and `Date.now()` report in the page when each story starts, unless
 * `--fixed-time off`. Keep it no older than the dates stories write into their own data: a story
 * that says "sent 3 h ago" about an invite from 2026 cannot pass at a 2025 instant.
 */
const DEFAULT_FIXED_TIME = '2026-11-14T12:00:00.000Z';
const DEFAULT_VIEWPORT = '1280x720';
const MAX_VIEWPORT = 10000;

function fail(flag, value, expected) {
    throw new Error(`${flag} ${JSON.stringify(value)} is not valid: ${expected}.`);
}

function integer(flag, value, fallback, { min, max }) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(n) || n < min || n > max) fail(flag, value, `expected a whole number from ${min} to ${max}`);
    return n;
}

function parseViewport(value, flag = '--viewport') {
    const m = /^(\d{1,5})x(\d{1,5})$/i.exec(String(value).trim());
    const width = m ? Number(m[1]) : 0;
    const height = m ? Number(m[2]) : 0;
    if (!m || width < 1 || height < 1 || width > MAX_VIEWPORT || height > MAX_VIEWPORT) {
        fail(flag, value, `expected WIDTHxHEIGHT, each from 1 to ${MAX_VIEWPORT}, e.g. ${DEFAULT_VIEWPORT}`);
    }
    return { width, height };
}

function parseFixedTime(value) {
    if (value === undefined || value === null || value === '' || value === true) return DEFAULT_FIXED_TIME;
    if (value === false || String(value).trim().toLowerCase() === 'off') return null;
    const text = String(value).trim();
    const ms = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : NaN;
    if (!Number.isFinite(ms)) fail('--fixed-time', value, 'expected an ISO 8601 instant such as 2026-11-14T12:00:00Z, or "off"');
    return new Date(ms).toISOString();
}

function parseScale(value) {
    if (value === undefined || value === null || value === '') return 1;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 4) fail('--scale', value, 'expected a number above 0 and at most 4');
    return n;
}

function parseStories(value) {
    if (value === undefined || value === null || value === false) return null;
    const ids = [...new Set(String(value).split(',').map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) fail('--stories', value, 'expected a comma-separated list of story ids');
    return ids;
}

function parseRef(value) {
    if (value === undefined || value === null || value === false || value === '') return null;
    const ref = String(value).trim();
    if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) fail('--changed-since', value, 'expected a git ref such as origin/main or HEAD~1');
    return ref;
}

/**
 * @param {object} argv yargs output (camelCase keys)
 * @param {{cwd?: string}} [ctx]
 */
function parseCaptureWebOptions(argv, ctx = {}) {
    const cwd = ctx.cwd || process.cwd();
    const projectDir = path.resolve(cwd, argv.projectDir || '.');
    const outDir = path.resolve(projectDir, argv.out || path.join('.scry', 'capture'));
    const changedSince = parseRef(argv.changedSince);
    const allowPartialBundle = Boolean(argv.allowPartialBundle);
    const stories = parseStories(argv.stories);
    // A run over only some stories: by id, or those affected since a ref.
    const partial = Boolean(changedSince || stories);
    const listIds = Boolean(argv.listIds);
    return {
        projectDir,
        configDir: path.resolve(projectDir, argv.configDir || '.storybook'),
        outDir,
        // null = decide from the cores this process may use (see cores.js).
        workers: integer('--workers', argv.workers, null, { min: 1, max: 64 }),
        maxDropped: integer('--max-dropped', argv.maxDropped, 0, { min: 0, max: 1000000 }),
        retries: integer('--retries', argv.retries, 1, { min: 0, max: 5 }),
        storyTimeout: integer('--story-timeout', argv.storyTimeout, 15000, { min: 100, max: 600000 }),
        scale: parseScale(argv.scale),
        viewport: parseViewport(argv.viewport || DEFAULT_VIEWPORT),
        fixedTime: parseFixedTime(argv.fixedTime),
        stories,
        partial,
        changedSince,
        list: Boolean(argv.list) || listIds,
        listIds,
        // The report must sit outside the bundle: the SCF validator refuses members no capture references.
        report: argv.report ? path.resolve(projectDir, String(argv.report)) : path.join(path.dirname(outDir), 'capture-report.json'),
        allowPartialBundle,
        // A run over only some stories is never an upload candidate: no scf.json unless explicitly allowed.
        writeBundle: !partial || allowPartialBundle,
        verbose: Boolean(argv.verbose),
    };
}

module.exports = { parseCaptureWebOptions, parseViewport, DEFAULT_FIXED_TIME, DEFAULT_VIEWPORT };
