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
const MAX_BROWSER_RELAUNCHES = 5;
const MAX_CONSOLE_ERRORS = 200;
const MARK = 'data-scry-shot';
const HARNESS_READY_TIMEOUT_MS = 120000;

const TIMED_OUT = Symbol('timed out');

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
 *   outDir; workers; playwright; logger.
 * @returns {Promise<{results: Map<string, object>, retried: string[], consoleErrors: object[], relaunches: number, timingsMs: object}>}
 */
async function captureStories({ url, stories, options, outDir, workers, playwright, logger }) {
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
    const ensureBrowser = async () => {
        if (browser && browser.isConnected()) return browser;
        if (!launching) {
            launching = (async () => {
                if (browser) {
                    relaunches++;
                    if (relaunches > MAX_BROWSER_RELAUNCHES) throw new CaptureWebError(`The browser died ${relaunches} times; giving up.`);
                    logger.warn(`The browser died; starting a new one (${relaunches} of ${MAX_BROWSER_RELAUNCHES}).`);
                }
                browser = await launch();
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
        const ready = await withTimeout(page.evaluate(() => (window.__scryCapture ? window.__scryCapture.whenReady() : { ready: false, error: 'the capture harness did not load' })), HARNESS_READY_TIMEOUT_MS);
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

    // ---- warm-up: import every story file once so dependency optimisation and transforms are done ----
    const warmup = async () => {
        const started = Date.now();
        const slot = newSlot();
        let pending = [...new Set(stories.map((s) => s.file))];
        try {
            for (let pass = 0; pass < WARMUP_PASSES && pending.length; pass++) {
                await closePage(slot);
                await openPage(slot);
                const failed = await slot.page.evaluate(async ({ files, concurrency }) => {
                    const bad = [];
                    let next = 0;
                    const work = async () => {
                        while (next < files.length) {
                            const file = files[next++];
                            const out = await window.__scryCapture.load(file);
                            if (!out.ok) bad.push(file);
                        }
                    };
                    await Promise.all(Array.from({ length: concurrency }, work));
                    return bad;
                }, { files: pending, concurrency: WARMUP_CONCURRENCY });
                pending = failed;
            }
        } finally {
            await closePage(slot);
        }
        timingsMs.warmup = Date.now() - started;
        return pending;
    };

    // eslint-disable-next-line sonarjs/cognitive-complexity -- one story from describe to screenshot, read top to bottom
    const attemptStory = async (slot, story) => {
        const { page, context } = slot;
        slot.pageErrors = [];
        const budget = options.storyTimeout + 10000;
        const call = async (fn, arg) => {
            const out = await withTimeout(page.evaluate(fn, arg), budget);
            if (out === TIMED_OUT) {
                const error = new Error(`the page stopped answering within ${budget} ms`);
                error.scryTimeout = true;
                throw error;
            }
            return out;
        };

        await call(() => window.__scryCapture.reset());
        await context.clearCookies();
        const ref = { file: story.file, exportName: story.exportName, title: story.title };
        const info = await call((a) => window.__scryCapture.describe(a), ref);
        if (!info.ok) return { status: 'failed', reason: 'error', detail: info.detail };
        if (info.skip) return { status: 'skipped', reason: 'filtered', detail: 'parameters.scry.capture.skip is true' };

        const viewport = info.viewport || options.viewport;
        if (viewport.width !== slot.viewport.width || viewport.height !== slot.viewport.height) {
            await page.setViewportSize(viewport);
            slot.viewport = { ...viewport };
        }

        const rendered = await call((a) => window.__scryCapture.render(a), { ...ref, timeout: options.storyTimeout });
        if (!rendered.ok) return { status: 'failed', reason: rendered.reason, detail: rendered.detail, discardPage: rendered.reason === 'timeout' };
        if (rendered.empty && slot.pageErrors.length) return { status: 'failed', reason: 'error', detail: slot.pageErrors[0] };
        if (info.delay) await page.waitForTimeout(info.delay);

        let crop = 'viewport';
        let buffer;
        const shotOptions = { ...SCREENSHOT_OPTIONS, timeout: options.storyTimeout };
        if (info.fullPage) {
            crop = 'fullpage';
            buffer = await page.screenshot({ ...shotOptions, fullPage: true });
        } else {
            const framing = rendered.portal ? { mode: 'viewport' } : await call(chooseFraming, MARK);
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
            const tree = boundedTree(await call(collectDomTree, { mark: MARK, viewport: crop === 'viewport', fullPage: crop === 'fullpage', maxNodes: STRUCTURE_MAX_NODES }));
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

        const unloadable = await warmup();
        if (unloadable.length) logger.warn(`${unloadable.length} story file(s) did not load during warm-up; their stories will be tried anyway.`);

        const captureStarted = Date.now();
        let next = 0;
        let done = 0;
        const total = stories.length;
        const step = Math.max(1, Math.min(50, Math.ceil(total / 10)));
        const worker = async () => {
            const slot = newSlot();
            try {
                while (next < total) {
                    const story = stories[next++];
                    results.set(story.id, await runStory(slot, story));
                    done++;
                    if (done % step === 0 || done === total) logger.info(`  ${done} of ${total} stories done`);
                }
            } finally {
                await closePage(slot);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, total)) }, worker));
        timingsMs.capture = Date.now() - captureStarted;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
    return { results, retried: [...retried].sort(), consoleErrors, relaunches, timingsMs };
}

module.exports = { captureStories, loadPlaywright, pngSize, SCREENSHOT_OPTIONS, RECYCLE_PAGE_AFTER };
