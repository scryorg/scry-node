/**
 * Guards around `capture web`: what it may delete, what counts as an uploadable bundle, which
 * Storybook versions it accepts. No browser.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const sharp = require('sharp');
const { parseCaptureWebOptions } = require('../lib/capture/web/options.js');
const { buildManifest, captureEntry, writeManifest, boundedTree, fileStem, resetOutDir, sealOutDir, assertOutDirUsable, OUT_DIR_MARKER } = require('../lib/capture/web/scf-writer.js');
const { changedFiles } = require('../lib/capture/web/affected.js');
const { loadStorybookProject } = require('../lib/capture/web/storybook-config.js');
const { validateBundle } = require('../lib/scf.js');
const { runUploadBundle } = require('../lib/uploadCommand.js');
const { onSignals } = require('../lib/capture/web/signals.js');

let tmp;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-guards-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (file, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
};
/** Every file under dir, relative, sorted. */
const tree = (dir) => {
    const out = [];
    const walk = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            const next = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(abs, entry.name), next);
            else out.push(next);
        }
    };
    walk(dir, '');
    return out.sort();
};

describe('--out is only cleared when it is this tool\'s own directory', () => {
    test('a directory that does not exist is created with the marker', () => {
        const out = path.join(tmp, 'a', 'b');
        resetOutDir(out);
        expect(fs.readdirSync(out).sort()).toEqual([OUT_DIR_MARKER, 'images', 'structure']);
    });

    test('an empty directory is accepted', () => {
        const out = path.join(tmp, 'empty');
        fs.mkdirSync(out);
        expect(() => assertOutDirUsable(out)).not.toThrow();
        resetOutDir(out);
        expect(fs.existsSync(path.join(out, OUT_DIR_MARKER))).toBe(true);
    });

    test('a directory with someone else\'s files is refused and nothing in it is touched', () => {
        const out = path.join(tmp, 'public');
        write(path.join(out, 'images', 'logo.png'));
        write(path.join(out, 'index.html'));
        const before = tree(out);
        expect(() => assertOutDirUsable(out)).toThrow(/public/);
        expect(() => resetOutDir(out)).toThrow(/\.scry-capture/);
        expect(tree(out)).toEqual(before);
    });

    test('a file is refused', () => {
        const out = path.join(tmp, 'file');
        write(out);
        expect(() => resetOutDir(out)).toThrow(/not a directory/i);
    });

    test('with the marker, only the files this tool writes are removed', () => {
        const out = path.join(tmp, 'capture');
        resetOutDir(out);
        write(path.join(out, 'images', 'a--b.png'));
        write(path.join(out, 'structure', 'a--b.json'));
        write(path.join(out, 'scf.json'), '{}');
        write(path.join(out, 'images', 'notes.txt'));
        write(path.join(out, 'structure', 'deep', 'keep.json'));
        write(path.join(out, 'README.md'));
        resetOutDir(out);
        expect(tree(out)).toEqual([OUT_DIR_MARKER, 'README.md', 'images/notes.txt', 'structure/deep/keep.json']);
    });

    test('a finished bundle from this tool (marker removed, scf.json names the tool) may be replaced; another tool\'s bundle may not', () => {
        const out = path.join(tmp, 'bundle');
        resetOutDir(out);
        write(path.join(out, 'images', 'a--b.png'));
        writeManifest(out, buildManifest({ captures: [], declared: 0, skipped: [], toolVersion: '1.0.0' }));
        sealOutDir(out);
        expect(fs.existsSync(path.join(out, OUT_DIR_MARKER))).toBe(false);
        expect(() => resetOutDir(out)).not.toThrow();
        expect(fs.existsSync(path.join(out, 'images', 'a--b.png'))).toBe(false);

        const other = path.join(tmp, 'other');
        write(path.join(other, 'scf.json'), JSON.stringify({ scf: '1.0', source: { kind: 'storybook-rn', platform: 'ios', tool: { name: 'scry-deployer capture rn' } } }));
        write(path.join(other, 'images', 'x.png'));
        expect(() => resetOutDir(other)).toThrow(/\.scry-capture/);
        expect(tree(other)).toEqual(['images/x.png', 'scf.json']);
    });
});

describe('a run over only some stories is not an uploadable bundle', () => {
    const cwd = '/work/app';

    test('--stories and --changed-since both leave scf.json out unless --allow-partial-bundle', () => {
        expect(parseCaptureWebOptions({ stories: 'a--b' }, { cwd }).writeBundle).toBe(false);
        expect(parseCaptureWebOptions({ stories: 'a--b', allowPartialBundle: true }, { cwd }).writeBundle).toBe(true);
        expect(parseCaptureWebOptions({ changedSince: 'HEAD' }, { cwd }).writeBundle).toBe(false);
        expect(parseCaptureWebOptions({ changedSince: 'HEAD', allowPartialBundle: true }, { cwd }).writeBundle).toBe(true);
        expect(parseCaptureWebOptions({}, { cwd }).writeBundle).toBe(true);
        expect(parseCaptureWebOptions({ stories: 'a--b' }, { cwd }).partial).toBe(true);
        expect(parseCaptureWebOptions({}, { cwd }).partial).toBe(false);
    });

    const declared = { id: 'a--b', title: 'A', name: 'B', exportName: 'B', file: 'src/A.stories.jsx' };
    const result = { image: 'images/a--b.png', structure: 'structure/a--b.json', viewport: { width: 1280, height: 720 }, scale: 1, size: { width: 20, height: 10 }, crop: 'root', tags: [] };

    async function bundle({ partial }) {
        const dir = fs.mkdtempSync(path.join(tmp, 'bundle-'));
        fs.mkdirSync(path.join(dir, 'images'));
        fs.mkdirSync(path.join(dir, 'structure'));
        await sharp({ create: { width: 20, height: 10, channels: 3, background: '#336699' } }).png().toFile(path.join(dir, result.image));
        fs.writeFileSync(path.join(dir, result.structure), JSON.stringify(boundedTree({ type: 'div', bounds: { x: 0, y: 0, width: 20, height: 10 } })));
        writeManifest(dir, buildManifest({ captures: [captureEntry(declared, result)], declared: 1, skipped: [], toolVersion: '1.0.0', framework: 'react', partial }));
        return dir;
    }

    test('a partial bundle is marked x-scry-partial and still passes the validator; a full one has no such key', async () => {
        const part = await bundle({ partial: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(part, 'scf.json'), 'utf8'));
        expect(manifest['x-scry-partial']).toBe(true);
        expect(manifest.counts.declared).toBe(1);
        expect((await validateBundle(part)).errors).toEqual([]);
        const full = await bundle({ partial: false });
        expect('x-scry-partial' in JSON.parse(fs.readFileSync(path.join(full, 'scf.json'), 'utf8'))).toBe(false);
    });

    function recordingLogger() {
        const lines = [];
        const push = (message) => lines.push(String(message));
        return { lines, info: push, warn: push, error: push, success: push, debug: push };
    }

    test('upload refuses a partial bundle, also as a dry run', async () => {
        const part = await bundle({ partial: true });
        for (const dryRun of [true, false]) {
            const logger = recordingLogger();
            const uploadBundle = jest.fn();
            const out = await runUploadBundle({ path: part, dryRun, project: 'p', apiKey: 'k' }, { logger, deps: { uploadBundle } });
            expect(out.exitCode).toBe(1);
            expect(uploadBundle).not.toHaveBeenCalled();
            expect(logger.lines.join('\n')).toMatch(/only some of the stories/i);
        }
    });

    test('upload takes a partial bundle with --allow-partial-bundle, and a full bundle as before', async () => {
        const part = await bundle({ partial: true });
        const allowed = await runUploadBundle({ path: part, dryRun: true, allowPartialBundle: true }, { logger: recordingLogger() });
        expect(allowed.exitCode).toBe(0);
        const full = await bundle({ partial: false });
        const plain = await runUploadBundle({ path: full, dryRun: true }, { logger: recordingLogger() });
        expect(plain.exitCode).toBe(0);
    });
});

describe('Storybook version gate', () => {
    function project(version) {
        const dir = fs.mkdtempSync(path.join(tmp, 'sb-'));
        write(path.join(dir, 'package.json'), '{"name":"x"}');
        write(path.join(dir, '.storybook', 'main.js'), 'export default { stories: [] };\n');
        write(path.join(dir, 'node_modules', 'storybook', 'package.json'), JSON.stringify({ name: 'storybook', version }));
        return dir;
    }
    const cwd = process.cwd();
    const env = { ...process.env };
    afterEach(() => {
        process.chdir(cwd);
        for (const key of ['NODE_ENV', 'STORYBOOK_DISABLE_TELEMETRY']) {
            if (env[key] === undefined) delete process.env[key];
            else process.env[key] = env[key];
        }
    });

    test.each(['8.6.14', '9.1.2', '11.0.0', '12.3.0-alpha.1'])('Storybook %s is refused with a message that names the supported version', async (version) => {
        const dir = project(version);
        const attempt = loadStorybookProject({ projectDir: dir, configDir: path.join(dir, '.storybook') });
        await expect(attempt).rejects.toThrow(new RegExp(`Storybook ${version.replace(/\./g, '\\.')}`));
        await expect(attempt).rejects.toThrow(/Storybook 10/);
        expect(process.cwd()).toBe(cwd);
    });
});

describe('small hardening', () => {
    test('git diff never runs a configured external diff tool', () => {
        const calls = [];
        const exec = (args) => {
            calls.push(args);
            if (args[0] === 'rev-parse') return '/repo\n';
            return '';
        };
        changedFiles('origin/main', { cwd: '/repo', exec });
        changedFiles('a..b', { cwd: '/repo', exec });
        const diffs = calls.filter((args) => args[0] === 'diff');
        expect(diffs).toHaveLength(2);
        for (const args of diffs) expect(args).toContain('--no-ext-diff');
    });

    test('file stems avoid names Windows reserves', () => {
        const used = new Set();
        for (const id of ['con', 'NUL', 'com1', 'lpt9', 'aux', 'prn']) {
            expect(fileStem(id, used)).not.toMatch(/^(con|prn|aux|nul|com\d|lpt\d)$/i);
        }
        expect(fileStem('console--default', used)).toBe('console--default');
    });
});

describe('Ctrl-C and SIGTERM', () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const fakeProcess = () => {
        const proc = new EventEmitter();
        proc.exit = jest.fn();
        return proc;
    };

    test.each([['SIGINT', 130], ['SIGTERM', 143]])('%s runs the clean-up once, then exits %i', async (signal, code) => {
        const proc = fakeProcess();
        const cleanup = jest.fn(async () => {});
        onSignals(cleanup, proc);
        proc.emit(signal);
        await settle();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(proc.exit).toHaveBeenCalledWith(code);
    });

    test('a clean-up that fails still ends the process; a second signal does not wait for the clean-up', async () => {
        const failing = fakeProcess();
        onSignals(async () => {
            throw new Error('close failed');
        }, failing);
        failing.emit('SIGTERM');
        await settle();
        expect(failing.exit).toHaveBeenCalledWith(143);

        const stuck = fakeProcess();
        onSignals(() => new Promise(() => {}), stuck);
        stuck.emit('SIGINT');
        await settle();
        expect(stuck.exit).not.toHaveBeenCalled();
        stuck.emit('SIGINT');
        expect(stuck.exit).toHaveBeenCalledWith(130);
    });

    test('the handlers are removed when the run is over', () => {
        const proc = fakeProcess();
        const off = onSignals(async () => {}, proc);
        expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(2);
        off();
        expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
    });
});
