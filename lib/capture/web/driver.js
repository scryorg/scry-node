/**
 * Drives the capture: a pool of browser pages on the harness page, one story after another.
 *
 * Between stories the page is put back to a known state (previous story unmounted, storage,
 * cookies, scroll, focus and viewport reset). A story that fails is tried again on a fresh page
 * and, when it still fails, recorded as skipped with the reason: nothing is dropped silently.
 */
/* global window, document */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { collectDomTree } = require('./harness/dom-tree.js');
const { boundedTree, STRUCTURE_MAX_NODES } = require('./scf-writer.js');
const { CaptureWebError } = require('./storybook-config.js');

// Easy to change once measured defaults arrive.
/** Screenshot settings handed to Playwright. */
const SCREENSHOT_OPTIONS = { type: 'png', animations: 'disabled', caret: 'hide', scale: 'device' };
/** A page is replaced after this many stories, so one leaky story cannot slow the whole run. */
const RECYCLE_PAGE_AFTER = 150;
/** Story files imported at once while warming the dev server. */
const WARMUP_CONCURRENCY = 6;
const WARMUP_PASSES = 3;
/** One story file gets this long to import during warm-up (the first import also waits for dependency optimisation). */
const WARMUP_FILE_TIMEOUT_MS = 60000;
/** Added to what the page was asked to wait, before the driver stops waiting for the page itself. */
const WARMUP_GRACE_MS = 15000;
const PAGE_GRACE_MS = 10000;
const MAX_BROWSER_RELAUNCHES = 5;
const MAX_CONSOLE_ERRORS = 200;
const MARK = 'data-scry-shot';
const HARNESS_READY_TIMEOUT_MS = 120000;

const TIMED_OUT = Symbol('timed out');

/** The browser could not be kept alive: the run ends early, with what it has. */
class BrowserGoneError extends Error {}

/**
 * Every function the driver runs inside the page. They are serialised into the browser, so each
 * one only touches the page's own globals and its argument.
 */
/* istanbul ignore next -- serialised into the browser */
const PAGE_CALLS = {
    ready: () => (window.__scryCapture ? window.__scryCapture.whenReady() : { ready: false, error: 'the capture harness did not load' }),
    /** Import story files; answers [{file, reason: 'error' | 'timeout', detail}] for those that did not load. */
    warm: (arg) => window.__scryCapture.warm(arg),
    reset: () => window.__scryCapture.reset(),
    describe: (arg) => window.__scryCapture.describe(arg),
    render: (arg) => window.__scryCapture.render(arg),
    framing: chooseFraming,
    tree: collectDomTree,
};

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Playwright from the project; else the copy that comes with scry-deployer's own dependencies. */
function loadPlaywright(projectDir) {
    const attempts = [
        () => createRequire(path.join(projectDir, 'package.json'))('playwright'),
        () => createRequire(path.join(projectDir, 'package.json'))('@playwright/test'),
        () => createRequire(path.join(projectDir, 'package.json'))('playwright-core'),
        () => require('playwright'),
        () => createRequire(require.resolve('@scrymore/scry-sbcov/package.json'))('playwright'),
    ];
    for (const attempt of attempts) {
        try {
            const mod = attempt();
            if (mod && mod.chromium) return mod;
        } catch {
            // try the next place
        }
    }
    throw new CaptureWebError(`capture web needs "playwright" installed in ${projectDir} (for example: npm install --save-dev playwright && npx playwright install chromium).`);
}

function pngSize(buffer) {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** True when every pixel has the same colour: the story drew nothing a person could see. */
async function isUniformImage(buffer) {
    try {
        const sharp = require('sharp');
        const stats = await sharp(buffer).stats();
        return stats.channels.every((c) => c.min === c.max);
    } catch {
        return false;
    }
}

function isClosedError(error) {
    return /has been closed|browser has disconnected|Target closed|Target crashed|Page crashed|Browser closed|Connection closed/i.test(String(error && error.message));
}

/** Runs in the page: mark the element the screenshot is cropped to and say which framing applies. */
/* istanbul ignore next -- serialised into the browser */
function chooseFraming(mark) {
    for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) el.removeAttribute(mark);
    const hosts = document.querySelectorAll('[data-scry-host]');
    const host = hosts[hosts.length - 1];
    if (!host) return { mode: 'viewport' };
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1;
    };
    let target = host.querySelector('[data-scry-root]');
    if (!target && host.childElementCount === 1 && visible(host.firstElementChild)) target = host.firstElementChild;
    if (!target && visible(host)) target = host;
    if (!target || !visible(target)) return { mode: 'viewport' };
    target.setAttribute(mark, '1');
    return { mode: 'root' };
}

/** `Date` pinned to one instant, for Playwright versions without the clock API. Runs in the page. */
/* istanbul ignore next -- serialised into the browser */
function pinDate(fixedMs) {
    const RealDate = Date;
    class FixedDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) super(fixedMs);
            else super(...args);
        }

        static now() {
            return fixedMs;
        }
    }
    window.Date = FixedDate;
}

/**
 * @param {object} input
 *   url: harness page; stories: [{id, file, exportName, title, stem}]; options: parsed flags;
 *   outDir; workers; playwright; logger; control: the driver sets control.close (used on Ctrl-C);
 *   tuning: {pageGraceMs, warmupFileTimeoutMs, warmupGraceMs} waits, shortened by tests.
 * @returns {Promise<{results: Map<string, object>, retried: string[], consoleErrors: object[], relaunches: number, aborted: string | null, timingsMs: object}>}
 *   aborted: why the run ended early (the browser could not be kept alive), else null. Every story
 *   has a result either way.
 */
async function captureStories({ url, stories, options, outDir, workers, playwright, logger, control = {}, tuning = {} }) {
    const pageGraceMs = tuning.pageGraceMs ?? PAGE_GRACE_MS;
    const warmupFileTimeoutMs = tuning.warmupFileTimeoutMs ?? WARMUP_FILE_TIMEOUT_MS;
    const warmupGraceMs = tuning.warmupGraceMs ?? WARMUP_GRACE_MS;
    let aborted = null;
    let closing = false;
    const results = new Map();
    const retried = new Set();
    const consoleErrors = [];
    const timingsMs = {};
    let relaunches = 0;
    let browser = null;
    let launching = null;

    const launch = async () => {
        try {
            return await playwright.chromium.launch({ headless: true });
        } catch (error) {
            throw new CaptureWebError(`Could not start Chromium: ${String(error.message).split('\n')[0]} (run: npx playwright install chromium)`);
        }
    };
    const giveUp = (why) => {
        aborted = why;
        logger.error(why);
        return new BrowserGoneError(why);
    };
    const ensureBrowser = async () => {
        if (aborted || closing) throw new BrowserGoneError(aborted || 'the run is being stopped');
        if (browser && browser.isConnected()) return browser;
        if (!launching) {
            launching = (async () => {
                if (!browser) {
                    browser = await launch();
                    return;
                }
                if (relaunches >= MAX_BROWSER_RELAUNCHES) throw giveUp(`The browser died more than ${MAX_BROWSER_RELAUNCHES} times; the run was cut short.`);
                relaunches++;
                logger.warn(`The browser died; starting a new one (${relaunches} of ${MAX_BROWSER_RELAUNCHES}).`);
                try {
                    browser = await launch();
                } catch (error) {
                    throw giveUp(`The browser died and a new browser could not be started (${error.message}); the run was cut short.`);
                }
            })().finally(() => {
                launching = null;
            });
        }
        await launching;
        return browser;
    };

    const noteConsole = (slot, text) => {
        if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
        consoleErrors.push({ id: slot.current || null, text: String(text).slice(0, 500) });
    };

    const openPage = async (slot) => {
        const b = await ensureBrowser();
        const context = await b.newContext({
            viewport: options.viewport,
            deviceScaleFactor: options.scale,
            timezoneId: 'UTC',
            locale: 'en-US',
            reducedMotion: 'reduce',
            colorScheme: 'light',
        });
        try {
            await preparePage(slot, context);
        } catch (error) {
            // A page that did not open must not leave its context (and its renderer process) behind.
            await context.close().catch(() => {});
            throw error;
        }
    };

    const preparePage = async (slot, context) => {
        if (options.fixedTime) {
            if (context.clock && typeof context.clock.setFixedTime === 'function') await context.clock.setFixedTime(new Date(options.fixedTime));
            else await context.addInitScript(pinDate, Date.parse(options.fixedTime));
        }
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            slot.loadErrors.push(msg.text());
            noteConsole(slot, msg.text());
        });
        page.on('pageerror', (error) => {
            slot.pageErrors.push(String(error && error.message));
            noteConsole(slot, `Uncaught: ${error && error.message}`);
        });
        await page.goto(url, { waitUntil: 'load', timeout: HARNESS_READY_TIMEOUT_MS });
        const ready = await withTimeout(page.evaluate(PAGE_CALLS.ready), HARNESS_READY_TIMEOUT_MS);
        if (ready === TIMED_OUT) throw new CaptureWebError('The Storybook preview did not finish loading in the browser.');
        if (!ready.ready) {
            const why = ready.error && !slot.pageErrors.length && !slot.loadErrors.length ? ready.error : [ready.error, ...slot.pageErrors, ...slot.loadErrors].filter(Boolean).slice(0, 3).join(' | ');
            throw new CaptureWebError(`The Storybook preview failed to load in the browser: ${why || 'unknown error'}. Run again with --verbose for the dev server's output.`);
        }
        slot.loadErrors = [];
        slot.context = context;
        slot.page = page;
        slot.viewport = { ...options.viewport };
        slot.served = 0;
    };

    const closePage = async (slot) => {
        const { context } = slot;
        slot.context = null;
        slot.page = null;
        if (context) await context.close().catch(() => {});
    };

    const newSlot = () => ({ context: null, page: null, viewport: null, served: 0, current: null, pageErrors: [], loadErrors: [] });

    /**
     * Warm-up: import every story file once, so dependency optimisation and transforms are done
     * before the first story is timed. Each pass runs on a fresh page and is bounded: the dev
     * server reloads the page when it re-optimises dependencies, and an import can hang.
     * @returns {Promise<Map<string, {reason: string, detail: string}>>} files that did not load
     */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- one story's whole life (render, wait, frame, shoot) reads best in one place
    const warmup = async () => {
        const started = Date.now();
        const slot = newSlot();
        const failed = new Map();
        let pending = [...new Set(stories.map((s) => s.file))];
        try {
            for (let pass = 0; pass < WARMUP_PASSES && pending.length; pass++) {
                const bound = warmupFileTimeoutMs * Math.ceil(pending.length / WARMUP_CONCURRENCY) + warmupGraceMs;
                try {
                    await closePage(slot);
                    await openPage(slot);
                    const out = await withTimeout(slot.page.evaluate(PAGE_CALLS.warm, { files: pending, concurrency: WARMUP_CONCURRENCY, timeout: warmupFileTimeoutMs }), bound);
                    if (out === TIMED_OUT) {
                        logger.warn(`Warm-up pass ${pass + 1} did not answer within ${bound} ms.`);
                        continue;
                    }
                    failed.clear();
                    for (const f of out) failed.set(f.file, { reason: f.reason === 'timeout' ? 'timeout' : 'error', detail: String(f.detail || '') });
                    pending = [...failed.keys()];
                } catch (error) {
                    if (error instanceof CaptureWebError) throw error;
                    if (error instanceof BrowserGoneError) break;
                    // Most often the dev server reloading the page under us: the next pass starts over.
                    logger.debug(`Warm-up pass ${pass + 1} was interrupted: ${String(error.message).split('\n')[0]}`);
                }
            }
        } finally {
            await closePage(slot);
        }
        timingsMs.warmup = Date.now() - started;
        return failed;
    };

    // eslint-disable-next-line sonarjs/cognitive-complexity -- one story from describe to screenshot, read top to bottom
    const attemptStory = async (slot, story) => {
        const { page, context } = slot;
        slot.pageErrors = [];
        const budget = options.storyTimeout + pageGraceMs;
        const call = async (fn, arg) => {
            const out = await withTimeout(page.evaluate(fn, arg), budget);
            if (out === TIMED_OUT) {
                const error = new Error(`the page stopped answering within ${budget} ms`);
                error.scryTimeout = true;
                throw error;
            }
            return out;
        };

        await call(PAGE_CALLS.reset);
        await context.clearCookies();
        const ref = { file: story.file, exportName: story.exportName, title: story.title };
        const info = await call(PAGE_CALLS.describe, ref);
        if (!info.ok) return { status: 'failed', reason: 'error', detail: info.detail };
        if (info.skip) return { status: 'skipped', reason: 'filtered', detail: 'parameters.scry.capture.skip is true' };

        const viewport = info.viewport || options.viewport;
        if (viewport.width !== slot.viewport.width || viewport.height !== slot.viewport.height) {
            await page.setViewportSize(viewport);
            slot.viewport = { ...viewport };
        }

        const renderStarted = Date.now();
        const rendered = await call(PAGE_CALLS.render, { ...ref, timeout: options.storyTimeout });
        if (!rendered.ok) return { status: 'failed', reason: rendered.reason, detail: rendered.detail, discardPage: rendered.reason === 'timeout' };
        if (rendered.empty && slot.pageErrors.length) return { status: 'failed', reason: 'error', detail: slot.pageErrors[0] };
        if (info.delay) {
            // parameters.scry.capture.delay is part of the story's time, not on top of it.
            const left = options.storyTimeout - (Date.now() - renderStarted);
            if (info.delay > left) return { status: 'failed', reason: 'timeout', detail: `the story's capture delay of ${info.delay} ms does not fit in the story timeout of ${options.storyTimeout} ms` };
            await page.waitForTimeout(info.delay);
        }

        let crop = 'viewport';
        let buffer;
        const shotOptions = { ...SCREENSHOT_OPTIONS, timeout: options.storyTimeout };
        if (info.fullPage) {
            crop = 'fullpage';
            buffer = await page.screenshot({ ...shotOptions, fullPage: true });
        } else {
            const framing = rendered.portal ? { mode: 'viewport' } : await call(PAGE_CALLS.framing, MARK);
            if (framing.mode === 'root') {
                crop = 'root';
                buffer = await page.locator(`[${MARK}="1"]`).first().screenshot(shotOptions);
            } else {
                buffer = await page.screenshot(shotOptions);
            }
        }
        const size = pngSize(buffer);
        if (!size) return { status: 'failed', reason: 'error', detail: 'the browser returned an image that is not a PNG' };

        const image = `images/${story.stem}.png`;
        await fs.promises.writeFile(path.join(outDir, image), buffer);

        let structure = null;
        try {
            const tree = boundedTree(await call(PAGE_CALLS.tree, { mark: MARK, viewport: crop === 'viewport', fullPage: crop === 'fullpage', maxNodes: STRUCTURE_MAX_NODES }));
            if (tree) {
                structure = `structure/${story.stem}.json`;
                await fs.promises.writeFile(path.join(outDir, structure), JSON.stringify(tree));
            }
        } catch (error) {
            if (error.scryTimeout || isClosedError(error)) throw error;
            // The image is good; a tree that cannot be read is left out.
        }

        const blankSuspect = rendered.empty || (await isUniformImage(buffer));
        return {
            status: 'captured',
            result: { image, structure, viewport, scale: options.scale, size, crop, theme: info.theme, tags: info.tags, fields: info.fields, blankSuspect },
        };
    };

    // eslint-disable-next-line sonarjs/cognitive-complexity -- the retry and browser-relaunch ladder for one story
    const runStory = async (slot, story) => {
        let crashes = 0;
        for (let attempt = 0; ; attempt++) {
            let outcome;
            try {
                if (!slot.page || slot.served >= RECYCLE_PAGE_AFTER) {
                    await closePage(slot);
                    await openPage(slot);
                }
                slot.current = story.id;
                slot.served++;
                outcome = await attemptStory(slot, story);
            } catch (error) {
                if (error instanceof CaptureWebError) throw error;
                await closePage(slot);
                if (error instanceof BrowserGoneError) return { status: 'skipped', reason: 'error', detail: error.message };
                if (!error.scryTimeout && (isClosedError(error) || !(browser && browser.isConnected())) && crashes < 2) {
                    // The browser or the page died under this story: that is not the story's attempt.
                    crashes++;
                    attempt--;
                    continue;
                }
                outcome = { status: 'failed', reason: error.scryTimeout ? 'timeout' : 'error', detail: String(error.message).split('\n')[0] };
            } finally {
                slot.current = null;
            }
            if (outcome.status !== 'failed') return outcome;
            if (outcome.discardPage) await closePage(slot);
            if (attempt >= options.retries) return { status: 'skipped', reason: outcome.reason, detail: outcome.detail };
            // Second chance on a fresh page.
            retried.add(story.id);
            await closePage(slot);
        }
    };

    try {
        const launchStarted = Date.now();
        await ensureBrowser();
        timingsMs.browserLaunch = Date.now() - launchStarted;

        control.close = async () => {
            closing = true;
            if (browser) await browser.close().catch(() => {});
        };

        const unloadable = await warmup();
        const queue = [];
        for (const story of stories) {
            const why = unloadable.get(story.file);
            if (why) results.set(story.id, { status: 'skipped', reason: why.reason, detail: `the story file could not be imported: ${why.detail}`.slice(0, 2000) });
            else queue.push(story);
        }
        if (unloadable.size) logger.warn(`${unloadable.size} story file(s) could not be imported; their ${stories.length - queue.length} stories are recorded as skipped.`);

        const captureStarted = Date.now();
        let next = 0;
        let done = stories.length - queue.length;
        const total = stories.length;
        const step = Math.max(1, Math.min(50, Math.ceil(total / 10)));
        const worker = async () => {
            const slot = newSlot();
            try {
                while (next < queue.length) {
                    const story = queue[next++];
                    // Once the browser is gone for good, the rest is recorded without another try.
                    results.set(story.id, aborted ? { status: 'skipped', reason: 'error', detail: aborted } : await runStory(slot, story));
                    done++;
                    if (done % step === 0 || done === total) logger.info(`  ${done} of ${total} stories done`);
                }
            } finally {
                await closePage(slot);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, queue.length)) }, worker));
        timingsMs.capture = Date.now() - captureStarted;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
    return { results, retried: [...retried].sort(), consoleErrors, relaunches, aborted, timingsMs };
}

module.exports = { captureStories, loadPlaywright, pngSize, PAGE_CALLS, SCREENSHOT_OPTIONS, RECYCLE_PAGE_AFTER };
