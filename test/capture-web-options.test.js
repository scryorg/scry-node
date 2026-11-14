/** `capture web`: flag parsing and the worker default (no browser). */
const path = require('path');
const { parseCaptureWebOptions, DEFAULT_FIXED_TIME } = require('../lib/capture/web/options.js');
const { coresSeen, defaultWorkers, MAX_DEFAULT_WORKERS } = require('../lib/capture/web/cores.js');

const cwd = path.resolve('/work/project');

describe('capture web options', () => {
    test('defaults', () => {
        const o = parseCaptureWebOptions({}, { cwd });
        expect(o.projectDir).toBe(cwd);
        expect(o.configDir).toBe(path.join(cwd, '.storybook'));
        expect(o.outDir).toBe(path.join(cwd, '.scry', 'capture'));
        expect(o.workers).toBeNull();
        expect(o.maxDropped).toBe(0);
        expect(o.retries).toBe(1);
        expect(o.storyTimeout).toBe(15000);
        expect(o.scale).toBe(1);
        expect(o.viewport).toEqual({ width: 1280, height: 720 });
        expect(o.fixedTime).toBe(DEFAULT_FIXED_TIME);
        expect(new Date(DEFAULT_FIXED_TIME).toISOString()).toBe(DEFAULT_FIXED_TIME);
        expect(o.stories).toBeNull();
        expect(o.changedSince).toBeNull();
        expect(o.list).toBe(false);
        expect(o.listIds).toBe(false);
        expect(o.allowPartialBundle).toBe(false);
        expect(o.report).toBe(path.join(cwd, '.scry', 'capture-report.json'));
    });

    test('explicit values', () => {
        const o = parseCaptureWebOptions({
            configDir: '.storybook-vitest', out: 'out/b', workers: 3, maxDropped: '5', retries: 0, storyTimeout: 20000,
            scale: 2, viewport: '375x667', fixedTime: '2024-02-29T10:00:00Z', stories: 'a--b, c--d ,', changedSince: 'origin/main',
            list: true, report: 'r.json',
        }, { cwd });
        expect(o.configDir).toBe(path.join(cwd, '.storybook-vitest'));
        expect(o.outDir).toBe(path.join(cwd, 'out', 'b'));
        expect(o.workers).toBe(3);
        expect(o.maxDropped).toBe(5);
        expect(o.retries).toBe(0);
        expect(o.storyTimeout).toBe(20000);
        expect(o.scale).toBe(2);
        expect(o.viewport).toEqual({ width: 375, height: 667 });
        expect(o.fixedTime).toBe('2024-02-29T10:00:00.000Z');
        expect(o.stories).toEqual(['a--b', 'c--d']);
        expect(o.changedSince).toBe('origin/main');
        expect(o.list).toBe(true);
        expect(o.report).toBe(path.join(cwd, 'r.json'));
    });

    test('--project-dir moves every default', () => {
        const o = parseCaptureWebOptions({ projectDir: 'apps/web' }, { cwd });
        expect(o.projectDir).toBe(path.join(cwd, 'apps', 'web'));
        expect(o.configDir).toBe(path.join(cwd, 'apps', 'web', '.storybook'));
        expect(o.outDir).toBe(path.join(cwd, 'apps', 'web', '.scry', 'capture'));
    });

    test('--fixed-time off turns the fixed clock off', () => {
        expect(parseCaptureWebOptions({ fixedTime: 'off' }, { cwd }).fixedTime).toBeNull();
    });

    test('--list-ids implies --list', () => {
        const o = parseCaptureWebOptions({ listIds: true }, { cwd });
        expect(o.list).toBe(true);
        expect(o.listIds).toBe(true);
    });

    test.each([
        [{ viewport: '1280' }, /--viewport/],
        [{ viewport: '0x720' }, /--viewport/],
        [{ viewport: '99999x720' }, /--viewport/],
        [{ fixedTime: 'yesterday' }, /--fixed-time/],
        [{ scale: 0 }, /--scale/],
        [{ scale: 9 }, /--scale/],
        [{ workers: 0 }, /--workers/],
        [{ workers: 'many' }, /--workers/],
        [{ retries: -1 }, /--retries/],
        [{ storyTimeout: 10 }, /--story-timeout/],
        [{ maxDropped: 'x' }, /--max-dropped/],
        [{ stories: ' , ' }, /--stories/],
        [{ changedSince: '--upload-pack=x' }, /--changed-since/],
    ])('rejects %j', (argv, message) => {
        expect(() => parseCaptureWebOptions(argv, { cwd })).toThrow(message);
    });

    test('--changed-since output is never an upload candidate unless explicitly allowed', () => {
        expect(parseCaptureWebOptions({ changedSince: 'HEAD~1' }, { cwd }).writeBundle).toBe(false);
        expect(parseCaptureWebOptions({ changedSince: 'HEAD~1', allowPartialBundle: true }, { cwd }).writeBundle).toBe(true);
        expect(parseCaptureWebOptions({}, { cwd }).writeBundle).toBe(true);
    });
});

describe('capture web worker default', () => {
    const files = (map) => (file) => {
        if (file in map) return map[file];
        throw new Error('ENOENT');
    };

    test('no cgroup limit: the cores the process may use', () => {
        const seen = coresSeen({ availableParallelism: () => 16, readFile: files({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' }) });
        expect(seen).toMatchObject({ cores: 16, os: 16, cgroup: null });
        expect(defaultWorkers(seen.cores)).toBe(MAX_DEFAULT_WORKERS);
        expect(MAX_DEFAULT_WORKERS).toBe(4);
    });

    test('cgroup v2 limit of 2 CPUs on a 64-core box', () => {
        const seen = coresSeen({ availableParallelism: () => 64, readFile: files({ '/sys/fs/cgroup/cpu.max': '200000 100000\n' }) });
        expect(seen).toMatchObject({ cores: 2, os: 64, cgroup: 2, source: 'cgroup-v2' });
        expect(defaultWorkers(seen.cores)).toBe(2);
    });

    test('cgroup v2 fractional limit rounds down but never below one', () => {
        expect(coresSeen({ availableParallelism: () => 8, readFile: files({ '/sys/fs/cgroup/cpu.max': '150000 100000' }) }).cores).toBe(1);
        expect(coresSeen({ availableParallelism: () => 8, readFile: files({ '/sys/fs/cgroup/cpu.max': '50000 100000' }) }).cores).toBe(1);
        expect(defaultWorkers(1)).toBe(1);
    });

    test('cgroup v1 quota', () => {
        const seen = coresSeen({
            availableParallelism: () => 32,
            readFile: files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '300000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }),
        });
        expect(seen).toMatchObject({ cores: 3, cgroup: 3, source: 'cgroup-v1' });
        expect(defaultWorkers(seen.cores)).toBe(3);
    });

    test('cgroup v1 quota -1 means no limit; no cgroup files at all is fine', () => {
        expect(coresSeen({
            availableParallelism: () => 6,
            readFile: files({ '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }),
        })).toMatchObject({ cores: 6, cgroup: null, source: 'os' });
        expect(coresSeen({ availableParallelism: () => 3, readFile: files({}) })).toMatchObject({ cores: 3, source: 'os' });
    });

    test('taskset (fewer usable cores than the cgroup allows) wins', () => {
        const seen = coresSeen({ availableParallelism: () => 2, readFile: files({ '/sys/fs/cgroup/cpu.max': '800000 100000' }) });
        expect(seen.cores).toBe(2);
        expect(defaultWorkers(seen.cores)).toBe(2);
    });
});
