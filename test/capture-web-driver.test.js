/* eslint-disable sonarjs/no-nested-functions -- the fake browser is nested objects of small functions */
/**
 * The Playwright driver against a fake browser: what happens when a story fails, hangs, or the
 * browser dies. No real browser, no dev server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureStories, PAGE_CALLS } = require('../lib/capture/web/driver.js');

// The smallest thing pngSize accepts: a PNG signature and an IHDR saying 4 x 3.
const PNG = Buffer.alloc(33);
PNG.writeUInt32BE(0x89504e47, 0);
PNG.writeUInt32BE(0x0d0a1a0a, 4);
PNG.writeUInt32BE(13, 8);
PNG.write('IHDR', 12, 'ascii');
PNG.writeUInt32BE(4, 16);
PNG.writeUInt32BE(3, 20);

const CLOSED = 'Target page, context or browser has been closed';
const never = () => new Promise(() => {});

const DEFAULT_ANSWERS = {
    ready: () => ({ ready: true, error: null }),
    warm: () => [],
    reset: () => ({ ok: true }),
    describe: (arg) => ({ ok: true, id: arg.exportName, tags: [], skip: false, delay: 0, fullPage: false, fields: null, theme: null, viewport: null, layout: 'padded' }),
    render: () => ({ ok: true, portal: false, empty: false }),
    framing: () => ({ mode: 'viewport' }),
    tree: () => ({ type: 'div', bounds: { x: 0, y: 0, width: 4, height: 3 } }),
};

/**
 * A stand-in for the `playwright` module. `answers[name](arg, ctx)` answers the driver's page
 * calls (see PAGE_CALLS); ctx is {page, browser, stats}. `goto(page)` may throw.
 */
function fakePlaywright(answers = {}, { goto } = {}) {
    const stats = { launches: 0, contexts: 0, contextsClosed: 0, pages: 0, waited: 0, calls: [] };
    const all = { ...DEFAULT_ANSWERS, ...answers };
    const makeBrowser = () => {
        let connected = true;
        const browser = {
            isConnected: () => connected,
            kill() {
                connected = false;
            },
            async close() {
                connected = false;
            },
            async newContext() {
                if (!connected) throw new Error(CLOSED);
                stats.contexts++;
                const context = {
                    closed: false,
                    clock: { setFixedTime: async () => {} },
                    addInitScript: async () => {},
                    clearCookies: async () => {},
                    async close() {
                        if (!context.closed) {
                            context.closed = true;
                            stats.contextsClosed++;
                        }
                    },
                    async newPage() {
                        const page = {
                            no: ++stats.pages,
                            on() {},
                            async goto() {
                                if (goto) await goto(page);
                            },
                            async evaluate(fn, arg) {
                                if (!connected) throw new Error(CLOSED);
                                const name = Object.keys(PAGE_CALLS).find((key) => PAGE_CALLS[key] === fn);
                                if (!name) throw new Error('the driver evaluated a function that is not in PAGE_CALLS');
                                stats.calls.push({ name, page: page.no, story: arg && arg.exportName });
                                return all[name](arg, { page, browser, stats });
                            },
                            async setViewportSize() {},
                            async screenshot() {
                                if (!connected) throw new Error(CLOSED);
                                return PNG;
                            },
                            locator: () => ({ first: () => ({ screenshot: async () => PNG }) }),
                            async waitForTimeout(ms) {
                                stats.waited += ms;
                            },
                        };
                        return page;
                    },
                };
                return context;
            },
        };
        return browser;
    };
    return {
        stats,
        chromium: {
            async launch() {
                stats.launches++;
                return makeBrowser();
            },
        },
    };
}

const story = (name, file = `src/${name}.stories.jsx`) => ({ id: `x--${name.toLowerCase()}`, file, exportName: name, title: 'X', stem: `x--${name.toLowerCase()}` });

describe('captureStories with a fake browser', () => {
    let outDir;
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const run = (playwright, stories, options = {}, tuning = {}) => captureStories({
        url: 'http://127.0.0.1:1/__scry_capture__.html',
        stories,
        options: { viewport: { width: 1280, height: 720 }, scale: 1, fixedTime: '2025-01-01T12:00:00.000Z', storyTimeout: 200, retries: 1, ...options },
        outDir,
        workers: 1,
        playwright,
        logger: quiet,
        tuning: { pageGraceMs: 50, warmupFileTimeoutMs: 100, warmupGraceMs: 50, ...tuning },
    });
    const renders = (pw, name) => pw.stats.calls.filter((c) => c.name === 'render' && c.story === name);

    beforeEach(() => {
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-driver-'));
        fs.mkdirSync(path.join(outDir, 'images'));
        fs.mkdirSync(path.join(outDir, 'structure'));
    });
    afterEach(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    test('a healthy run captures every story on one reused page', async () => {
        const pw = fakePlaywright();
        const out = await run(pw, [story('A'), story('B'), story('C')]);
        expect([...out.results.values()].map((r) => r.status)).toEqual(['captured', 'captured', 'captured']);
        expect(new Set(pw.stats.calls.filter((c) => c.name === 'render').map((c) => c.page)).size).toBe(1);
        expect(fs.readdirSync(path.join(outDir, 'images')).sort()).toEqual(['x--a.png', 'x--b.png', 'x--c.png']);
        expect(out.results.get('x--a').result.size).toEqual({ width: 4, height: 3 });
        expect(out.aborted).toBeNull();
        expect(pw.stats.contextsClosed).toBe(pw.stats.contexts);
    });

    test('a story that fails is tried once more, on a fresh page', async () => {
        let first = true;
        const pw = fakePlaywright({
            render: (arg) => {
                if (arg.exportName === 'B' && first) {
                    first = false;
                    return { ok: false, reason: 'error', detail: 'boom' };
                }
                return { ok: true, portal: false, empty: false };
            },
        });
        const out = await run(pw, [story('A'), story('B')]);
        expect(out.results.get('x--b').status).toBe('captured');
        expect(out.retried).toEqual(['x--b']);
        const pages = renders(pw, 'B').map((c) => c.page);
        expect(pages).toHaveLength(2);
        expect(pages[1]).not.toBe(pages[0]);
    });

    test('a story that fails every try is a recorded skip with its reason; --retries 0 means one try', async () => {
        const answers = { render: (arg) => (arg.exportName === 'B' ? { ok: false, reason: 'error', detail: 'always broken' } : { ok: true, portal: false, empty: false }) };
        const pw = fakePlaywright(answers);
        const out = await run(pw, [story('A'), story('B'), story('C')]);
        expect(out.results.get('x--b')).toEqual({ status: 'skipped', reason: 'error', detail: 'always broken' });
        expect(out.results.get('x--c').status).toBe('captured');
        expect(renders(pw, 'B')).toHaveLength(2);

        const once = fakePlaywright(answers);
        await run(once, [story('B')], { retries: 0 });
        expect(renders(once, 'B')).toHaveLength(1);
    });

    test('a story that never finishes is a timeout skip, and the stuck page is not used again', async () => {
        const pw = fakePlaywright({ render: (arg) => (arg.exportName === 'B' ? never() : { ok: true, portal: false, empty: false }) });
        const out = await run(pw, [story('A'), story('B'), story('C')], { storyTimeout: 60 });
        expect(out.results.get('x--b')).toMatchObject({ status: 'skipped', reason: 'timeout' });
        expect(out.results.get('x--c').status).toBe('captured');
        const stuck = new Set(renders(pw, 'B').map((c) => c.page));
        expect(stuck.has(renders(pw, 'C')[0].page)).toBe(false);
        expect(pw.stats.contextsClosed).toBe(pw.stats.contexts);
    });

    test('the browser dying under a story starts a new browser; the story is captured and nothing before it is lost', async () => {
        let killed = false;
        const pw = fakePlaywright({
            render: (arg, { browser }) => {
                if (arg.exportName === 'B' && !killed) {
                    killed = true;
                    browser.kill();
                    throw new Error(CLOSED);
                }
                return { ok: true, portal: false, empty: false };
            },
        });
        const out = await run(pw, [story('A'), story('B'), story('C')]);
        expect([...out.results.values()].map((r) => r.status)).toEqual(['captured', 'captured', 'captured']);
        expect(pw.stats.launches).toBe(2);
        expect(out.relaunches).toBe(1);
        expect(out.aborted).toBeNull();
    });

    test('a browser that keeps dying does not lose the run: captured stories stay, the rest are skips, and the run says it was cut short', async () => {
        const pw = fakePlaywright({
            render: (arg, { browser }) => {
                if (arg.exportName === 'A') return { ok: true, portal: false, empty: false };
                browser.kill();
                throw new Error(CLOSED);
            },
        });
        const stories = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => story(n));
        const out = await run(pw, stories);
        expect(out.results.size).toBe(6);
        expect(out.results.get('x--a').status).toBe('captured');
        for (const id of ['x--b', 'x--c', 'x--d', 'x--e', 'x--f']) {
            expect(out.results.get(id)).toMatchObject({ status: 'skipped', reason: 'error' });
        }
        expect(out.aborted).toMatch(/browser/i);
        expect(out.results.get('x--f').detail).toMatch(/browser/i);
        expect(pw.stats.launches).toBeLessThanOrEqual(6);
    });

    test('warm-up survives the dev server reloading the page (optimised dependencies changed)', async () => {
        let warmCalls = 0;
        const pw = fakePlaywright({
            warm: () => {
                warmCalls++;
                if (warmCalls === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
                return [];
            },
        });
        const out = await run(pw, [story('A'), story('B')]);
        expect(warmCalls).toBe(2);
        expect([...out.results.values()].map((r) => r.status)).toEqual(['captured', 'captured']);
    });

    test('a story file that cannot be imported becomes skips with the reason for its stories; the rest of the run goes on', async () => {
        const pw = fakePlaywright({
            warm: (arg) => arg.files.filter((f) => f === 'src/Bad.stories.jsx').map((file) => ({ file, reason: 'error', detail: 'Failed to fetch dynamically imported module' })),
        });
        const out = await run(pw, [story('A'), story('B1', 'src/Bad.stories.jsx'), story('B2', 'src/Bad.stories.jsx'), story('C')]);
        expect(out.results.get('x--b1')).toMatchObject({ status: 'skipped', reason: 'error' });
        expect(out.results.get('x--b1').detail).toMatch(/Failed to fetch dynamically imported module/);
        expect(out.results.get('x--b2')).toMatchObject({ status: 'skipped', reason: 'error' });
        expect(out.results.get('x--a').status).toBe('captured');
        expect(out.results.get('x--c').status).toBe('captured');
        expect(renders(pw, 'B1')).toHaveLength(0);
    });

    test('a story file whose import hangs is a timeout skip, not a run that never ends', async () => {
        const pw = fakePlaywright({
            warm: (arg) => arg.files.filter((f) => f === 'src/Hang.stories.jsx').map((file) => ({ file, reason: 'timeout', detail: `not imported within ${arg.timeout} ms` })),
        });
        const out = await run(pw, [story('A'), story('H', 'src/Hang.stories.jsx')]);
        expect(out.results.get('x--h')).toMatchObject({ status: 'skipped', reason: 'timeout' });
        expect(out.results.get('x--a').status).toBe('captured');
    });

    test('a warm-up call that never answers is cut off and the stories are still tried', async () => {
        const pw = fakePlaywright({ warm: never });
        const out = await run(pw, [story('A')]);
        expect(out.results.get('x--a').status).toBe('captured');
    }, 20000);

    test('a page that fails to open does not leak its browser context', async () => {
        let failed = false;
        const pw = fakePlaywright({}, {
            goto: () => {
                if (!failed) {
                    failed = true;
                    throw new Error('net::ERR_CONNECTION_RESET');
                }
            },
        });
        await run(pw, [story('A')]).catch(() => {});
        expect(failed).toBe(true);
        expect(pw.stats.contextsClosed).toBe(pw.stats.contexts);
    });

    test('a story delay is part of the story timeout', async () => {
        const fits = fakePlaywright({ describe: (arg) => ({ ...DEFAULT_ANSWERS.describe(arg), delay: 40 }) });
        const ok = await run(fits, [story('A')], { storyTimeout: 500 });
        expect(ok.results.get('x--a').status).toBe('captured');
        expect(fits.stats.waited).toBe(40);

        const tooLong = fakePlaywright({ describe: (arg) => ({ ...DEFAULT_ANSWERS.describe(arg), delay: 5000 }) });
        const out = await run(tooLong, [story('A')], { storyTimeout: 500, retries: 0 });
        expect(out.results.get('x--a')).toMatchObject({ status: 'skipped', reason: 'timeout' });
        expect(out.results.get('x--a').detail).toMatch(/delay/);
        expect(tooLong.stats.waited).toBe(0);
    });
});
