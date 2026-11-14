/**
 * `scry-deployer capture web` end to end on the fixture project (test/fixtures/capture-web): a real
 * Storybook config, the project's own Vite and a real headless Chromium.
 *
 * Needs `npm install` in the fixture and a Playwright Chromium; skips with a message otherwise.
 * The CLI runs as a child process: Storybook 10 is ESM-only and Jest's CommonJS runtime cannot import it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'cli.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'capture-web');

const ALL_IDS = [
    'badge--blank',
    'badge--default',
    'components-broken--throws',
    'components-button--mobile',
    'components-button--primary',
    'components-button--secondary',
    'components-counter--clicked',
    'components-skipped--hidden',
    'screens-bigpage--scrolled',
    'widgets-clock--now',
];
const STORY_FILES = [
    'src/Badge.stories.jsx', 'src/Bigpage.stories.jsx', 'src/Broken.stories.jsx', 'src/Button.stories.jsx',
    'src/Clock.stories.jsx', 'src/Counter.stories.jsx', 'src/Skipped.stories.jsx',
];

function whyNotRunnable() {
    if (Number(process.versions.node.split('.')[0]) < 22) return `Node ${process.versions.node} is too old for Storybook 10 (needs 22+)`;
    for (const pkg of ['storybook', 'vite', 'playwright', 'react', '@storybook/react-vite']) {
        if (!fs.existsSync(path.join(FIXTURE, 'node_modules', pkg, 'package.json'))) {
            return `the fixture has no node_modules/${pkg} (run: cd test/fixtures/capture-web && npm install)`;
        }
    }
    try {
        const { chromium } = require(path.join(FIXTURE, 'node_modules', 'playwright'));
        const exe = chromium.executablePath();
        if (!exe || !fs.existsSync(exe)) return 'no Playwright Chromium for the fixture (run: cd test/fixtures/capture-web && npx playwright install chromium)';
    } catch (error) {
        return `Playwright did not load from the fixture: ${error.message}`;
    }
    return null;
}

const skipReason = whyNotRunnable();
if (skipReason) {
    console.warn(`capture web integration test SKIPPED: ${skipReason}`);
}
const maybe = skipReason ? describe.skip : describe;

function cli(args, { cwd = FIXTURE, env = {} } = {}) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        timeout: 240000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: '1', SCRY_TELEMETRY_DISABLED: '1', CI: '1', NO_COLOR: '1', ...env },
    });
    return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', signal: result.signal };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Every text in a scf-tree/1 node and its descendants. */
function texts(node, out = []) {
    if (node.text) out.push(node.text);
    for (const child of node.children || []) texts(child, out);
    return out;
}

maybe('capture web on the fixture project', () => {
    let work;
    let out;
    let reportPath;
    let run;
    let manifest;
    let report;
    const capture = (id) => manifest.captures.find((c) => c.id === id);
    const tree = (id) => readJson(path.join(out, capture(id).structure.file));

    beforeAll(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-it-'));
        out = path.join(work, 'bundle');
        reportPath = path.join(work, 'report.json');
        run = cli(['capture', 'web', '--out', out, '--report', reportPath, '--workers', '1', '--max-dropped', '1']);
        if (fs.existsSync(path.join(out, 'scf.json'))) manifest = readJson(path.join(out, 'scf.json'));
        if (fs.existsSync(reportPath)) report = readJson(reportPath);
    }, 300000);

    afterAll(() => {
        if (work) fs.rmSync(work, { recursive: true, force: true });
    });

    test('exits 0 when the failed stories fit --max-dropped', () => {
        expect({ code: run.code, stderr: run.stderr.slice(-2000) }).toMatchObject({ code: 0 });
        expect(manifest).toBeDefined();
        expect(report).toBeDefined();
    });

    test('counts are honest: 10 declared, 8 captured, 2 skipped with reasons', () => {
        expect(manifest.counts.declared).toBe(10);
        expect(manifest.counts.captured).toBe(8);
        expect(manifest.captures.map((c) => c.id)).toEqual(ALL_IDS.filter((id) => !/broken|skipped/.test(id)));
        expect(manifest.counts.skipped).toHaveLength(2);
        expect(manifest.counts.skipped[0]).toMatchObject({ id: 'components-broken--throws', reason: 'error' });
        expect(manifest.counts.skipped[0].detail).toMatch(/fixture story always throws/);
        expect(manifest.counts.skipped[1]).toMatchObject({ id: 'components-skipped--hidden', reason: 'filtered' });
    });

    test('source is storybook:web from this tool, with no live links', () => {
        expect(manifest.scf).toBe('1.0');
        expect(manifest.source).toMatchObject({ kind: 'storybook', platform: 'web', framework: 'react', tool: { name: 'scry-deployer capture web' } });
        expect(manifest.source.tool.version).toBe(require('../package.json').version);
        for (const c of manifest.captures) expect(c.links).toBeUndefined();
    });

    test('every capture has viewport, scale, size and a structure tree; the image matches the size', async () => {
        for (const c of manifest.captures) {
            expect(c.capture.viewport.width).toBeGreaterThan(0);
            expect(c.capture.scale).toBe(1);
            const meta = await sharp(path.join(out, c.image)).metadata();
            expect(meta.format).toBe('png');
            expect({ id: c.id, ...c.capture.size }).toEqual({ id: c.id, width: meta.width, height: meta.height });
            expect(c.structure).toMatchObject({ origin: 'dom', format: 'scf-tree/1' });
            const doc = readJson(path.join(out, c.structure.file));
            expect(doc.format).toBe('scf-tree/1');
            expect(typeof doc.root.type).toBe('string');
        }
    });

    test('story metadata: title, name, code, kind, tags, fields', () => {
        expect(capture('components-button--primary')).toMatchObject({
            kind: 'component',
            title: ['Components', 'Button'],
            name: 'Primary',
            code: { file: 'src/Button.stories.jsx', line: 11, component: 'Button', componentFile: 'src/Button.jsx' },
            tags: ['brand'],
            'x-scry-fields': { team: 'core' },
        });
        expect(capture('components-button--mobile').tags).toEqual(['brand', 'phone']);
        expect(capture('components-button--mobile')['x-scry-fields']).toEqual({ team: 'core', surface: 'mobile' });
        expect(capture('screens-bigpage--scrolled')).toMatchObject({ kind: 'screen', title: ['Screens', 'Bigpage'], name: 'Scrolled' });
        expect(capture('badge--default')).toMatchObject({ title: ['Badge'], name: 'Default', code: { file: 'src/Badge.stories.jsx', component: 'Badge', componentFile: 'src/Badge.jsx' } });
        expect(capture('badge--default').tags).toBeUndefined();
    });

    test('variant: theme from the globals, viewport from the run; a per-story viewport override applies and is reset after', () => {
        expect(capture('components-button--primary').variant).toEqual({ theme: 'light', viewport: { width: 1280, height: 720 } });
        expect(capture('components-button--secondary').variant.theme).toBe('dark');
        expect(capture('components-button--mobile').capture.viewport).toEqual({ width: 375, height: 667 });
        expect(capture('components-button--mobile').variant.viewport).toEqual({ width: 375, height: 667 });
        expect(capture('components-button--primary').capture.viewport).toEqual({ width: 1280, height: 720 });
        expect(capture('components-button--secondary').capture.viewport).toEqual({ width: 1280, height: 720 });
    });

    test('images are cropped to the story, not the whole viewport', () => {
        const button = capture('components-button--primary').capture;
        expect(button.crop).toBe('root');
        expect(button.size.height).toBeLessThan(300);
        const big = capture('screens-bigpage--scrolled').capture;
        expect(big.size.height).toBeGreaterThan(2400);
    });

    test('the preview decorator, the global stylesheet and the play function ran', () => {
        const secondary = tree('components-button--secondary');
        expect(JSON.stringify(secondary)).toContain('Cancel');
        expect(texts(tree('components-counter--clicked').root).join(' ')).toContain('Count: 2');
        // preview.css rounds the button: proof the global stylesheet reached the page.
        expect(JSON.stringify(tree('components-button--primary'))).toMatch(/"cornerRadius":6/);
    });

    test('the clock is fixed, and nothing leaks from earlier stories on the same page (storage, cookies, scroll)', () => {
        const all = texts(tree('widgets-clock--now').root).join(' | ');
        expect(all).toContain('2025-01-01T12:00:00.000Z');
        expect(all).toContain('storage: clean');
        expect(all).toContain('scrollY: 0');
    });

    test('the report sits outside the bundle and repeats the counts', () => {
        expect(report.declared).toBe(10);
        expect(report.captured).toBe(8);
        expect(report.skipped.map((s) => s.id)).toEqual(['components-broken--throws', 'components-skipped--hidden']);
        expect(report.skipped[0].reason).toBe('error');
        expect(report.retried).toEqual(['components-broken--throws']);
        expect(report.blankSuspect).toEqual(['badge--blank']);
        expect(report.partial).toBe(false);
        expect(report.workers).toBe(1);
        expect(report.cores.cores).toBeGreaterThan(0);
        expect(report.fixedTime).toBe('2025-01-01T12:00:00.000Z');
        for (const phase of ['loadConfig', 'index', 'viteStart', 'browserLaunch', 'capture', 'write', 'total']) {
            expect({ phase, ms: typeof report.timingsMs[phase] }).toEqual({ phase, ms: 'number' });
        }
        expect(capture('badge--blank')['x-scry']).toEqual({ captureWarnings: ['blank_suspect'] });
    });

    test('the bundle passes the SCF validator and `upload --dry-run`', () => {
        const validate = spawnSync(process.execPath, [path.join(REPO, 'lib', 'vendor', 'scf', 'cli.js'), 'validate', '--json', out], { encoding: 'utf8' });
        const verdict = JSON.parse(validate.stdout);
        expect(verdict.errors).toEqual([]);
        expect(validate.status).toBe(0);
        const dry = cli(['upload', out, '--dry-run'], { cwd: work });
        expect({ code: dry.code, tail: (dry.stdout + dry.stderr).slice(-600) }).toMatchObject({ code: 0 });
        expect(dry.stdout + dry.stderr).toMatch(/8 captures, source storybook:web/);
    });

    test('nothing but images, structure and scf.json in the bundle; nothing written into the project', () => {
        expect(fs.readdirSync(out).sort()).toEqual(['images', 'scf.json', 'structure']);
        expect(fs.existsSync(path.join(FIXTURE, '.scry'))).toBe(false);
        expect(fs.existsSync(path.join(FIXTURE, 'storybook-static'))).toBe(false);
    });

    test('--list prints one story id per line on stdout and captures nothing', () => {
        const listOut = path.join(work, 'list-out');
        const r = cli(['capture', 'web', '--list', '--out', listOut]);
        expect({ code: r.code, stderr: r.stderr.slice(-1500) }).toMatchObject({ code: 0 });
        expect(r.stdout).toBe(`${ALL_IDS.join('\n')}\n`);
        expect(fs.existsSync(listOut)).toBe(false);
    }, 120000);

    test('--stories captures only those; a failed story beyond --max-dropped is exit 1, with the skip recorded', () => {
        const subOut = path.join(work, 'subset');
        const subReport = path.join(work, 'subset-report.json');
        const r = cli(['capture', 'web', '--stories', 'components-broken--throws,badge--default', '--out', subOut, '--report', subReport, '--retries', '0']);
        expect(r.code).toBe(1);
        const m = readJson(path.join(subOut, 'scf.json'));
        expect(m.captures.map((c) => c.id)).toEqual(['badge--default']);
        expect(m.counts).toMatchObject({ declared: 2, captured: 1 });
        expect(m.counts.skipped).toHaveLength(1);
        const rep = readJson(subReport);
        expect(rep.retried).toEqual([]);
        expect(rep.partial).toBe(true);
        expect(rep.declaredTotal).toBe(10);
    }, 240000);

    test('an unknown story id is an error, not a silent empty run', () => {
        const r = cli(['capture', 'web', '--stories', 'nope--nothing', '--out', path.join(work, 'nope')]);
        expect(r.code).toBe(1);
        expect(r.stderr + r.stdout).toMatch(/nope--nothing/);
    }, 120000);

    describe('--changed-since (in a throwaway git repository)', () => {
        let repo;
        const git = (...args) => {
            const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
            if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
            return r.stdout;
        };

        beforeAll(() => {
            repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-git-')));
            for (const entry of fs.readdirSync(FIXTURE)) {
                if (entry === 'node_modules' || entry === '.scry') continue;
                fs.cpSync(path.join(FIXTURE, entry), path.join(repo, entry), { recursive: true });
            }
            fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
            git('init', '-q');
            git('add', '-A');
            git('commit', '-q', '-m', 'base');
            fs.appendFileSync(path.join(repo, 'src', 'Button.jsx'), '\n// changed\n');
        }, 60000);

        afterAll(() => {
            if (repo) fs.rmSync(repo, { recursive: true, force: true });
        });

        test('--list prints the affected story files, one per line', () => {
            const r = cli(['capture', 'web', '--changed-since', 'HEAD', '--list'], { cwd: repo });
            expect({ code: r.code, stderr: r.stderr.slice(-1500) }).toMatchObject({ code: 0 });
            expect(r.stdout).toBe('src/Button.stories.jsx\n');
        }, 120000);

        test('--list-ids prints the affected story ids', () => {
            const r = cli(['capture', 'web', '--changed-since', 'HEAD', '--list-ids'], { cwd: repo });
            expect(r.code).toBe(0);
            expect(r.stdout).toBe('components-button--mobile\ncomponents-button--primary\ncomponents-button--secondary\n');
        }, 120000);

        test('a capture of the affected stories is marked partial and is not a bundle', () => {
            const partOut = path.join(repo, '.scry', 'capture');
            const r = cli(['capture', 'web', '--changed-since', 'HEAD', '--workers', '2'], { cwd: repo });
            expect({ code: r.code, stderr: r.stderr.slice(-1500) }).toMatchObject({ code: 0 });
            expect(fs.existsSync(path.join(partOut, 'scf.json'))).toBe(false);
            expect(fs.readdirSync(path.join(partOut, 'images')).sort()).toEqual([
                'components-button--mobile.png', 'components-button--primary.png', 'components-button--secondary.png',
            ]);
            const rep = readJson(path.join(repo, '.scry', 'capture-report.json'));
            expect(rep).toMatchObject({ partial: true, declared: 3, captured: 3, declaredTotal: 10, workers: 2 });
            expect(rep.changedSince).toMatchObject({ ref: 'HEAD', global: false, files: ['src/Button.stories.jsx'] });
            const upload = cli(['upload', partOut, '--dry-run'], { cwd: repo });
            expect(upload.code).not.toBe(0);
        }, 240000);

        test('a change to the Storybook config reaches every story file', () => {
            fs.appendFileSync(path.join(repo, '.storybook', 'preview.css'), '\n/* changed */\n');
            const r = cli(['capture', 'web', '--changed-since', 'HEAD', '--list'], { cwd: repo });
            expect(r.code).toBe(0);
            expect(r.stdout).toBe(`${STORY_FILES.join('\n')}\n`);
        }, 120000);
    });
});

describe('capture web CLI surface (no browser)', () => {
    test('help lists the web flags, including --changed-since', () => {
        const r = cli(['capture', 'web', '--help'], { cwd: REPO });
        expect(r.code).toBe(0);
        const help = r.stdout + r.stderr;
        for (const flag of ['--config-dir', '--out', '--workers', '--max-dropped', '--retries', '--story-timeout', '--scale', '--viewport', '--fixed-time', '--stories', '--changed-since', '--list', '--list-ids', '--report']) {
            expect(help).toContain(flag);
        }
        expect(help).not.toContain('--allow-partial-bundle');
    });

    test('--platform is still required for rn and not for web', () => {
        const rn = cli(['capture', 'rn'], { cwd: REPO });
        expect(rn.code).not.toBe(0);
        expect(rn.stderr).toMatch(/platform/);
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-empty-'));
        try {
            const web = cli(['capture', 'web', '--list'], { cwd: empty });
            expect(web.code).toBe(1);
            expect(web.stderr).not.toMatch(/Missing required argument/);
            expect(web.stderr).toMatch(/\.storybook/);
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });

    test('a project without Storybook installed gets an error that names the package', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-nosb-'));
        try {
            fs.mkdirSync(path.join(dir, '.storybook'));
            fs.writeFileSync(path.join(dir, '.storybook', 'main.js'), 'export default { stories: [] };\n');
            fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","type":"module"}\n');
            const r = cli(['capture', 'web'], { cwd: dir });
            expect(r.code).toBe(1);
            expect(r.stderr).toMatch(/"storybook"/);
            expect(r.stderr).toMatch(/install/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
