/* eslint-disable sonarjs/code-eval -- the test runs the page clock and fixed snippets in a VM context, as the browser would */
/**
 * The page clock `capture web` installs (storyClock): `Date` starts at --fixed-time when a story
 * starts and then runs at real speed; timers stay the browser's own. Run in a fresh VM context
 * with a hand-driven performance.now, so no browser is needed.
 */
const vm = require('vm');
const { storyClock } = require('../lib/capture/web/driver.js');

const FIXED = Date.parse('2026-11-14T12:00:00.000Z');

function page() {
    const perf = { t: 5000, now() { return this.t; } };
    const timers = { setTimeout() {}, setInterval() {}, requestAnimationFrame() {} };
    const ctx = vm.createContext({ performance: perf, ...timers });
    vm.runInContext('window = globalThis;', ctx);
    vm.runInContext(`(${storyClock.toString()})(${FIXED});`, ctx);
    const run = (code) => vm.runInContext(code, ctx);
    return { perf, run, timers };
}

describe('storyClock', () => {
    test('reads the fixed instant until a story starts (story files load at a steady instant)', () => {
        const { perf, run } = page();
        perf.t += 90000;
        expect(run('Date.now()')).toBe(FIXED);
        expect(run('new Date().toISOString()')).toBe('2026-11-14T12:00:00.000Z');
    });

    test('runs from the fixed instant once a story starts', () => {
        const { perf, run } = page();
        perf.t += 90000;
        run('__scryClock.restart()');
        expect(run('Date.now()')).toBe(FIXED);
        expect(run('new Date().toISOString()')).toBe('2026-11-14T12:00:00.000Z');
        perf.t += 1500.7;
        expect(run('Date.now()')).toBe(FIXED + 1500);
        expect(run('new Date().getTime()')).toBe(FIXED + 1500);
    });

    test('hold, then restart, for the next story: held at the fixed instant while its file loads, then runs again from it', () => {
        const { perf, run } = page();
        run('__scryClock.restart()');
        perf.t += 60000;
        run('__scryClock.hold()');
        expect(run('Date.now()')).toBe(FIXED);
        perf.t += 5000;
        expect(run('Date.now()')).toBe(FIXED);
        run('__scryClock.restart()');
        perf.t += 250;
        expect(run('Date.now()')).toBe(FIXED + 250);
    });

    test('explicit dates, Date(), parse, UTC, instanceof and the constructor behave like the real Date', () => {
        const { run } = page();
        expect(run('new Date(0).toISOString()')).toBe('1970-01-01T00:00:00.000Z');
        expect(run("new Date('2020-02-29T00:00:00Z').getTime()")).toBe(Date.parse('2020-02-29T00:00:00Z'));
        expect(run('new Date(2020, 1, 29).getDate()')).toBe(29);
        expect(run("Date.parse('2020-02-29T00:00:00Z')")).toBe(Date.parse('2020-02-29T00:00:00Z'));
        expect(run('Date.UTC(2020, 1, 29)')).toBe(Date.UTC(2020, 1, 29));
        expect(run('typeof Date()')).toBe('string');
        expect(run('new Date(Date()).getTime()')).toBe(FIXED);
        expect(run('new Date() instanceof Date')).toBe(true);
        expect(run('new Date().constructor === Date')).toBe(true);
        expect(run('[Date.name, Date.length]')).toEqual(['Date', 7]);
        expect(run('class D extends Date {}; new D().getTime()')).toBe(FIXED);
    });

    test('Intl.DateTimeFormat without a date formats the story clock', () => {
        const { perf, run } = page();
        run('__scryClock.restart()');
        perf.t += 3 * 60 * 60 * 1000;
        const fmt = "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hourCycle: 'h23' })";
        expect(run(`${fmt}.format()`)).toBe('15');
        expect(run(`${fmt}.formatToParts().find((p) => p.type === 'hour').value`)).toBe('15');
        expect(run(`${fmt}.format(new Date(0))`)).toBe('00');
    });

    test('timers and performance.now are left alone', () => {
        const { run, perf, timers } = page();
        expect(run('performance')).toBe(perf);
        for (const name of Object.keys(timers)) expect(run(name)).toBe(timers[name]);
    });
});
