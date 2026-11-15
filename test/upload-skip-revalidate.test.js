/**
 * `upload DIR` skips its second validation only when it can prove the folder is exactly what
 * `capture web` validated (a record next to the folder), and the zip stores PNG members.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runUploadBundle } = require('../lib/uploadCommand.js');
const { writeCaptureRecord, checkCaptureRecord, recordPathFor } = require('../lib/captureRecord.js');
const { encodePng } = require('../lib/capture/png.js');

const UNZIP = path.join(__dirname, '..', 'lib', 'scf-unzip.mjs');

function logger() {
    const lines = [];
    const rec = (level) => (m) => lines.push(`${level}: ${m}`);
    return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), success: rec('success'), debug: () => {} };
}

function makeBundle() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-skip-test-'));
    const bundle = path.join(root, 'capture');
    fs.mkdirSync(path.join(bundle, 'images'), { recursive: true });
    const png = encodePng({ width: 4, height: 4, data: Buffer.alloc(64, 120) });
    fs.writeFileSync(path.join(bundle, 'images/0001.png'), png);
    const manifest = {
        scf: '1.0',
        source: { kind: 'storybook', platform: 'web', tool: { name: 'scry-deployer capture web' } },
        counts: { declared: 1, captured: 1, skipped: [] },
        captures: [{ id: 'a--b', image: 'images/0001.png', kind: 'component' }],
    };
    fs.writeFileSync(path.join(bundle, 'scf.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, bundle };
}

const skipped = (l) => l.lines.some((x) => x.includes('Validation skipped'));
const ranFull = (l) => l.lines.some((x) => x.includes('Running the full validation'));

describe('skip the second validation', () => {
    test('exact match skips, and says so', async () => {
        const { bundle } = makeBundle();
        expect(writeCaptureRecord(bundle)).toBe(true);
        const l = logger();
        const res = await runUploadBundle({ path: bundle, dryRun: true }, { logger: l });
        expect(res.exitCode).toBe(0);
        expect(skipped(l)).toBe(true);
        expect(ranFull(l)).toBe(false);
    });

    test('--validate forces the full validation', async () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        const l = logger();
        const res = await runUploadBundle({ path: bundle, dryRun: true, validate: true }, { logger: l });
        expect(res.exitCode).toBe(0);
        expect(skipped(l)).toBe(false);
        expect(l.lines.join('\n')).toContain('forced by --validate');
    });

    test('no record forces validation', async () => {
        const { bundle } = makeBundle();
        const l = logger();
        await runUploadBundle({ path: bundle, dryRun: true }, { logger: l });
        expect(skipped(l)).toBe(false);
        expect(l.lines.join('\n')).toContain('no capture record');
    });

    test('a changed file size forces validation', async () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        fs.appendFileSync(path.join(bundle, 'images/0001.png'), Buffer.from([0]));
        const l = logger();
        await runUploadBundle({ path: bundle, dryRun: true }, { logger: l });
        expect(skipped(l)).toBe(false);
        expect(ranFull(l)).toBe(true);
    });

    test('a changed file list forces validation (and the validator still rejects what is wrong)', async () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        fs.rmSync(path.join(bundle, 'images/0001.png'));
        const l = logger();
        const res = await runUploadBundle({ path: bundle, dryRun: true }, { logger: l });
        expect(res.exitCode).toBe(1);
        expect(skipped(l)).toBe(false);
    });

    test('same size, new content in scf.json forces validation', () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        const p = path.join(bundle, 'scf.json');
        const text = fs.readFileSync(p, 'utf8').replace('a--b', 'a--c');
        const st = fs.statSync(p);
        fs.writeFileSync(p, text);
        fs.utimesSync(p, st.atime, st.mtime);
        expect(checkCaptureRecord(bundle).match).toBe(false);
    });

    test('a record from another deployer version forces validation', () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        const rp = recordPathFor(bundle);
        const rec = JSON.parse(fs.readFileSync(rp, 'utf8'));
        rec.deployer = '0.0.0';
        fs.writeFileSync(rp, JSON.stringify(rec));
        expect(checkCaptureRecord(bundle)).toMatchObject({ match: false });
    });

    test('--include-source always validates', async () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        const l = logger();
        await runUploadBundle({ path: bundle, dryRun: true, includeSource: true, repoRoot: bundle }, { logger: l });
        expect(skipped(l)).toBe(false);
        expect(ranFull(l)).toBe(true);
    });

    test('the record is outside the bundle: not in the zip, not in the folder', async () => {
        const { bundle } = makeBundle();
        writeCaptureRecord(bundle);
        expect(fs.readdirSync(bundle).sort()).toEqual(['images', 'scf.json']);
        expect(recordPathFor(bundle).startsWith(`${bundle}${path.sep}`)).toBe(false);
    });
});

describe('zip members', () => {
    function methods(zipPath) {
        const buf = fs.readFileSync(zipPath);
        let i = buf.length - 22;
        while (buf.readUInt32LE(i) !== 0x06054b50) i--;
        const n = buf.readUInt16LE(i + 10);
        let off = buf.readUInt32LE(i + 16);
        const out = {};
        for (let k = 0; k < n; k++) {
            const nameLen = buf.readUInt16LE(off + 28);
            const extra = buf.readUInt16LE(off + 30);
            const comment = buf.readUInt16LE(off + 32);
            out[buf.toString('utf8', off + 46, off + 46 + nameLen)] = buf.readUInt16LE(off + 10);
            off += 46 + nameLen + extra + comment;
        }
        return out;
    }

    test('PNG members are stored (method 0), JSON is deflated (8), and the zip round-trips', async () => {
        const { bundle } = makeBundle();
        const l = logger();
        const res = await runUploadBundle({ path: bundle, dryRun: true }, { logger: l });
        expect(res.exitCode).toBe(0);
        const m = methods(res.prepared.zipPath);
        expect(m['images/0001.png']).toBe(0);
        expect(m['scf.json']).toBe(8);
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-skip-unzip-'));
        const r = spawnSync(process.execPath, [UNZIP, res.prepared.zipPath, out], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(fs.readFileSync(path.join(out, 'images/0001.png')).equals(fs.readFileSync(path.join(bundle, 'images/0001.png')))).toBe(true);
        expect(fs.readFileSync(path.join(out, 'scf.json'), 'utf8')).toBe(fs.readFileSync(path.join(bundle, 'scf.json'), 'utf8'));
    });
});
