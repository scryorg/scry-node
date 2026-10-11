/**
 * adobe-bride-investigation, PR2: `scry import <folder>`.
 * guarantee-3 (only the folder given is read), guarantee-4 (client side: file text is data and is
 * never logged), guarantee-5 (no location or device identifiers, no paths, are uploaded), plus
 * the fixture folder end to end against a local fake of the upload route.
 */
const fs = require('fs');
const path = require('path');
const { runImport } = require('../lib/importCommand.js');
const { convertFile } = require('../lib/importConvert.js');
const { stripMetadata } = require('../lib/importStrip.js');
const { scanFolder, ImportInputError } = require('../lib/importScan.js');
const { MAGICK_LIMITS } = require('../lib/importConvert.js');
const {
    CANARY, riffChunk, makePng, makeJpeg, makeRealJpeg, decodeWithPillow, jpegMarkers, makeWebp, xmpPacket, tempDir, write, startFakeUploadService,
} = require('./helpers/importFixtures.js');

function recorder() {
    const lines = [];
    const push = (level) => (m) => lines.push(`${level}: ${m}`);
    return {
        lines,
        logger: { info: push('info'), warn: push('warn'), error: push('error'), success: push('success'), debug: push('debug') },
        print: (m) => lines.push(`print: ${m}`),
    };
}

/** A fake ImageMagick: answers -version, and writes a PNG that still carries a tEXt canary. */
function fakeMagick(calls) {
    return (file, args) => {
        calls.push({ file, args });
        if (args.includes('-version')) return { status: 0 };
        const out = args.find((a) => /^(png|jpeg):/.test(a));
        fs.writeFileSync(out.replace(/^(png|jpeg):/, ''), makePng(6, 5, { text: [`Comment\0${CANARY.gps} ${CANARY.serial}`] }));
        return { status: 0 };
    };
}

describe('scry import', () => {
    let svc;
    let work;
    let spies;
    const consoleLines = [];

    beforeEach(async () => {
        svc = await startFakeUploadService();
        work = tempDir('folder');
        consoleLines.length = 0;
        spies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => consoleLines.push(a.join(' '))));
    });
    afterEach(async () => {
        spies.forEach((s) => s.mockRestore());
        await svc.close();
        fs.rmSync(work, { recursive: true, force: true });
    });

    const argvFor = (folder, extra = {}) => ({ folder, project: 'p1', version: 'v1', apiUrl: svc.url, apiKey: 'k', yes: true, ...extra });

    test('a fixture folder goes end to end: convert, XMP allow-list, SCF bundle, upload, honest counts', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'kitchen.jpg', makeJpeg(8, 6, { xmp: xmpPacket({ title: 'Warm kitchen', description: 'Wood tones', keywords: ['kitchen', 'warm & wood'], rating: 4, label: 'Red' }) }));
        write(folder, 'sub/teapot.png', makePng(4, 4, { xmp: xmpPacket({ keywords: ['teapot'], form: 'attribute', rating: 2, label: 'Blue', title: 'Teapot' }) }));
        write(folder, 'sub/wave.webp', makeWebp(5, 3));
        write(folder, 'poster.psd', Buffer.from('8BPS fake psd bytes'));
        write(folder, 'poster.xmp', Buffer.from(xmpPacket({ keywords: ['poster', 'print'], rating: 5 })));
        write(folder, 'scan.tif', Buffer.from('II*\0 fake tiff'));
        write(folder, 'logo.ai', Buffer.from('%PDF-1.5 fake ai'));
        write(folder, 'copy-of-kitchen.jpg', fs.readFileSync(path.join(folder, 'kitchen.jpg')));
        write(folder, 'broken.png', Buffer.from('not a png'));
        write(folder, 'notes.txt', 'ignored');
        const calls = [];
        const rec = recorder();
        const tools = ['magick'];
        const convert = (abs, ext, o) => (ext === '.ai'
            ? Promise.resolve({ ok: false, reason: 'unsupported', detail: 'no converter for .ai on this machine' })
            : convertFile(abs, ext, { ...o, tools, run: fakeMagick(calls) }));

        const out = await runImport(argvFor(folder), { ...rec, deps: { convert, tools } });

        expect(out.exitCode).toBe(0);
        const bundle = svc.state.received[0];
        expect(bundle.manifest.source).toMatchObject({ kind: 'x-adobe-bridge', platform: 'other' });
        expect(bundle.manifest.captures.every((c) => c.kind === 'doc-image' && /^sha256-[0-9a-f]{64}$/.test(c.id))).toBe(true);
        // 5 pictures captured (jpg, png, webp, psd, tif); 3 skipped (duplicate, .ai, broken png); .txt ignored.
        expect(bundle.manifest.counts).toMatchObject({ declared: 8, captured: 5 });
        expect(bundle.manifest.counts.skipped.map((s) => s.reason).sort()).toEqual(['error', 'filtered', 'unsupported']);
        const kitchen = bundle.manifest.captures.find((c) => c['x-adobe-bridge']?.title === 'Warm kitchen');
        expect(kitchen.tags).toEqual(['kitchen', 'warm & wood']);
        expect(kitchen['x-adobe-bridge']).toEqual({ title: 'Warm kitchen', description: 'Wood tones', keywords: ['kitchen', 'warm & wood'], rating: 4, label: 'Red' });
        const poster = bundle.manifest.captures.find((c) => (c.tags || []).includes('poster'));
        expect(poster['x-adobe-bridge']).toEqual({ keywords: ['poster', 'print'], rating: 5 });
        expect(svc.state.requests[0].headers['x-scry-client']).toMatch(/^scry-deployer\//);
        expect(rec.lines.join('\n')).toMatch(/sent to OpenAI, Google Gemini and Jina/);
        // the converter ran with an explicit coder prefix and no shell string
        const psdCall = calls.find((c) => c.args.some((a) => a.startsWith('psd:')));
        expect(psdCall.file).toBe('magick');
        expect(psdCall.args).toEqual(expect.arrayContaining(['-strip']));
    });

    test('guarantee-3 only the folder given is read: symlinked files, folders and sidecars are never followed', async () => {
        const outside = tempDir('outside');
        const secretPng = write(outside, 'secret.png', makePng(4, 4, { shade: 77 }));
        write(outside, 'inner/deep.png', makePng(4, 4, { shade: 99 }));
        const secretXmp = write(outside, 'keys.xmp', Buffer.from(xmpPacket({ keywords: [CANARY.outsideKeyword] })));
        const folder = path.join(work, 'export');
        write(folder, 'ok.png', makePng(4, 4, { shade: 10 }));
        write(folder, 'plain.png', makePng(4, 4, { shade: 20 }));
        fs.symlinkSync(secretPng, path.join(folder, 'escape.png'));
        fs.symlinkSync(path.join(outside, 'inner'), path.join(folder, 'linked-dir'));
        fs.symlinkSync('../' + path.basename(outside) + '/secret.png', path.join(folder, 'dotdot.png'));
        fs.symlinkSync(secretXmp, path.join(folder, 'plain.xmp'));
        const outsideReads = [];
        const realRead = fs.readFileSync;
        const realOpen = fs.openSync;
        const note = (p) => { if (typeof p === 'string' && p.startsWith(outside)) outsideReads.push(p); };
        const rs = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...a) => { note(p); return realRead(p, ...a); });
        const os = jest.spyOn(fs, 'openSync').mockImplementation((p, ...a) => { note(p); return realOpen(p, ...a); });
        const rec = recorder();

        const out = await runImport(argvFor(folder), { ...rec, deps: { tools: [] } });
        rs.mockRestore();
        os.mockRestore();

        expect(out.exitCode).toBe(0);
        expect(outsideReads).toEqual([]);
        const bundle = svc.state.received[0];
        expect(bundle.manifest.counts.captured).toBe(2); // ok.png and plain.png only
        const allBytes = Buffer.concat(Object.values(bundle.files)).toString('latin1');
        expect(allBytes).not.toContain(CANARY.outsideKeyword);
        expect(bundle.manifest.captures.flatMap((c) => c.tags || [])).toEqual([]);
        const skipped = bundle.manifest.counts.skipped;
        expect(skipped).toHaveLength(3); // escape.png, linked-dir, dotdot.png
        expect(skipped.every((s) => s.detail === 'symbolic link not followed')).toBe(true);
        expect(rec.lines.join('\n')).toMatch(/skipped escape\.png: symbolic link not followed/);
        expect(rec.lines.join('\n')).toMatch(/1 sidecar \.xmp file not read/);
        fs.rmSync(outside, { recursive: true, force: true });
    });

    test('guarantee-3 an empty or unsupported-only folder uploads nothing and says why', async () => {
        const folder = path.join(work, 'empty');
        write(folder, 'readme.txt', 'x');
        const rec = recorder();
        const out = await runImport(argvFor(folder), { ...rec, deps: { tools: [] } });
        expect(out.exitCode).toBe(1);
        expect(svc.state.requests).toHaveLength(0);
        expect(rec.lines.join('\n')).toMatch(/No supported images found/);
    });

    test('guarantee-5 no GPS, camera serial or path reaches the bundle: not in scf.json, not in any image', async () => {
        const folder = path.join(work, 'FOLDER-NAME-CANARY');
        const xmp = xmpPacket({ title: 'Teapot', keywords: ['blue', 'ceramic'], rating: 3 });
        write(folder, 'a.jpg', makeJpeg(8, 6, { xmp, shade: 1 }));
        write(folder, 'b.png', makePng(4, 4, { xmp, text: [`Location\0${CANARY.gps}`, `Serial\0${CANARY.serial}`, `Source\0${CANARY.path}`], shade: 2 }));
        write(folder, 'c.webp', makeWebp(5, 3));
        write(folder, 'd.psd', Buffer.from(`8BPS ${CANARY.gps} ${CANARY.serial}`));
        write(folder, 'd.xmp', Buffer.from(xmpPacket({ keywords: ['psd'] })));
        const tools = ['magick'];
        const convert = (abs, ext, o) => convertFile(abs, ext, { ...o, tools, run: fakeMagick([]) });
        const rec = recorder();

        const out = await runImport(argvFor(folder), { ...rec, deps: { convert, tools } });

        expect(out.exitCode).toBe(0);
        const bundle = svc.state.received[0];
        expect(bundle.manifest.counts.captured).toBe(4);
        for (const [name, bytes] of Object.entries(bundle.files)) {
            const text = bytes.toString('latin1');
            for (const secret of [CANARY.gps, CANARY.serial, CANARY.path, 'IPTC-CANARY', 'comment-canary', 'Some Person', work]) {
                expect([name, text.includes(secret)]).toEqual([name, false]);
            }
        }
        // only the five allow-listed keys, and no file names or paths anywhere in the manifest
        const allowed = new Set(['title', 'description', 'keywords', 'rating', 'label']);
        for (const c of bundle.manifest.captures) {
            expect(Object.keys(c['x-adobe-bridge'] || {}).every((k) => allowed.has(k))).toBe(true);
            expect(c.image).toMatch(/^images\/[0-9a-f]{64}\.(jpg|png|webp)$/);
        }
        const manifestText = JSON.stringify(bundle.manifest);
        for (const word of ['a.jpg', 'b.png', 'c.webp', 'd.psd', 'FOLDER-NAME-CANARY']) expect(manifestText).not.toContain(word);
        expect(rec.lines.concat(consoleLines).join('\n')).not.toContain(CANARY.gps);
    });

    test('guarantee-4 text inside a file is data: capped, stripped of markup, never logged or printed', async () => {
        const folder = path.join(work, 'export');
        const evil = `${CANARY.injection} &lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;bold ${'x'.repeat(5000)}`;
        write(folder, 'a.png', makePng(4, 4, { xmp: xmpPacket({ title: `&lt;img src=x onerror=alert(1)&gt;${CANARY.injection}`, description: evil, keywords: [`${CANARY.injection} &lt;b&gt;k&lt;/b&gt;`, 'k'.repeat(500)], label: 'L'.repeat(100), rating: 5 }) }));
        const rec = recorder();

        const out = await runImport(argvFor(folder), { ...rec, deps: { tools: [] } });

        expect(out.exitCode).toBe(0);
        const meta = svc.state.received[0].manifest.captures[0]['x-adobe-bridge'];
        expect(meta.description.length).toBeLessThanOrEqual(2000);
        expect(meta.description).toContain(CANARY.injection); // kept as inert text, not obeyed or removed
        for (const value of [meta.title, meta.description, ...meta.keywords, meta.label]) {
            expect(value).not.toMatch(/[<>]/);
        }
        expect(meta.title).not.toContain('onerror=alert(1)>');
        expect(meta.keywords.every((k) => k.length <= 64)).toBe(true);
        expect(meta.label.length).toBeLessThanOrEqual(32);
        const everything = rec.lines.concat(consoleLines).join('\n');
        expect(everything).not.toContain('ignore previous instructions');
        expect(everything).not.toContain('onerror');
    });

    test('a non-interactive run without --yes sends nothing and says how to confirm', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const rec = recorder();
        const out = await runImport(argvFor(folder, { yes: false }), { ...rec, deps: { tools: [], isInteractive: () => false } });
        expect(out.exitCode).toBe(1);
        expect(svc.state.requests).toHaveLength(0);
        expect(rec.lines.join('\n')).toMatch(/Re-run with --yes/);
    });

    test('an interactive "no" sends nothing; an interactive "yes" uploads', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const asked = [];
        const no = await runImport(argvFor(folder, { yes: false }), { ...recorder(), deps: { tools: [], isInteractive: () => true, confirm: async (q) => { asked.push(q); return false; } } });
        expect(no.exitCode).toBe(1);
        expect(svc.state.requests).toHaveLength(0);
        expect(asked[0]).toMatch(/Send 1 image for AI processing/);
        const yes = await runImport(argvFor(folder, { yes: false }), { ...recorder(), deps: { tools: [], isInteractive: () => true, confirm: async () => true } });
        expect(yes.exitCode).toBe(0);
        expect(svc.state.received).toHaveLength(1);
    });

    test('--dry-run builds and validates the bundle and sends nothing, without needing --yes or --project', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const out = await runImport({ folder, dryRun: true, apiUrl: svc.url }, { ...recorder(), deps: { tools: [] } });
        expect(out.exitCode).toBe(0);
        expect(svc.state.requests).toHaveLength(0);
    });
});

const TRAILER = Buffer.from(`TRAILER-${CANARY.gps}-${CANARY.serial}-${CANARY.path}`, 'latin1');
const SECRETS = [CANARY.gps, CANARY.serial, CANARY.path, 'TRAILER', 'IPTC-CANARY', 'comment-canary'];
const hasSecret = (buf) => SECRETS.some((secret) => buf.toString('latin1').includes(secret));
const segment = (marker, payload) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
};

describe('guarantee-5 JPEG: nothing after the picture survives', () => {
    test('a canary after EOI (trailer) is dropped and the file ends at its first EOI', () => {
        const out = stripMetadata(makeJpeg(8, 6, { trailer: TRAILER }), 'jpeg');
        expect(hasSecret(out)).toBe(false);
        expect(jpegMarkers(out).at(-1)).toBe('d9');
        expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
        expect(out).toEqual(stripMetadata(makeJpeg(8, 6), 'jpeg'));
    });

    test('a second JPEG with its own EXIF appended after the first (MPF gain map, motion photo) is dropped', () => {
        const second = makeJpeg(8, 6, { exif: true, xmp: xmpPacket({ title: 'x' }) });
        const out = stripMetadata(makeJpeg(8, 6, { trailer: Buffer.concat([Buffer.from('MPF-GAIN-MAP'), second]) }), 'jpeg');
        expect(hasSecret(out)).toBe(false);
        expect(out.toString('latin1')).not.toContain('MPF-GAIN-MAP');
        expect(jpegMarkers(out).filter((m) => m === 'd8')).toHaveLength(0);
        expect(jpegMarkers(out).filter((m) => m === 'da')).toHaveLength(1);
    });

    test('byte stuffing, restart markers and fill bytes stay inside the scan; the first real EOI ends the file', () => {
        const sof = Buffer.alloc(15);
        sof[0] = 8;
        sof.writeUInt16BE(16, 1);
        sof.writeUInt16BE(16, 3);
        sof[5] = 3;
        const entropy = Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xff, 0x00, 0x44, 0xff, 0xd7, 0x55]);
        const src = Buffer.concat([
            Buffer.from([0xff, 0xd8]), segment(0xe1, Buffer.from(`Exif\0\0${CANARY.gps}`)), segment(0xdd, Buffer.from([0, 4])),
            segment(0xc0, sof), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), entropy, Buffer.from([0xff, 0xd9]), TRAILER,
        ]);
        const out = stripMetadata(src, 'jpeg');
        expect(hasSecret(out)).toBe(false);
        expect(out.includes(entropy)).toBe(true);
        expect(jpegMarkers(out)).toEqual(['dd', 'c0', 'da', 'd9']);
    });

    test('a progressive file: every scan is kept, APPn and comments between scans are dropped', () => {
        const sof = Buffer.alloc(15);
        sof[0] = 8;
        sof.writeUInt16BE(8, 1);
        sof.writeUInt16BE(8, 3);
        sof[5] = 3;
        const sos = (n) => segment(0xda, Buffer.from([1, 1, 0, n, 63, 0]));
        const src = Buffer.concat([
            Buffer.from([0xff, 0xd8]), segment(0xc2, sof),
            sos(0), Buffer.from([1, 2, 0xff, 0x00, 3]),
            segment(0xe1, Buffer.from(`Exif\0\0${CANARY.serial}`)), segment(0xfe, Buffer.from('comment-canary')),
            sos(1), Buffer.from([4, 5, 6]),
            sos(2), Buffer.from([7, 8]), Buffer.from([0xff, 0xd9]), TRAILER,
        ]);
        const out = stripMetadata(src, 'jpeg');
        expect(hasSecret(out)).toBe(false);
        expect(jpegMarkers(out)).toEqual(['c2', 'da', 'da', 'da', 'd9']);
        expect(out.includes(Buffer.from([1, 2, 0xff, 0x00, 3]))).toBe(true);
    });

    test('a scan that runs to the end of the file (no EOI) is not passed through', () => {
        const src = makeJpeg(8, 6);
        expect(stripMetadata(src.subarray(0, src.length - 2), 'jpeg')).toBeNull();
    });

    test.each(['baseline', 'progressive'])('a real %s JPEG with EXIF and a trailer: metadata and trailer gone, still decodes at the same size', (kind) => {
        const real = makeRealJpeg(kind);
        expect(hasSecret(real)).toBe(true); // the fixture really carries the canaries
        const out = stripMetadata(Buffer.concat([real, TRAILER, makeJpeg(8, 6)]), 'jpeg');
        expect(hasSecret(out)).toBe(false);
        const markers = jpegMarkers(out);
        expect(markers.at(-1)).toBe('d9');
        expect(markers.filter((m) => m === 'da')).toHaveLength(kind === 'progressive' ? 10 : 1);
        expect(markers).not.toContain('e1');
        expect(jpegMarkers(real).filter((m) => m === 'da')).toHaveLength(markers.filter((m) => m === 'da').length);
        const decoded = decodeWithPillow(out);
        if (decoded === null) return; // python3 + Pillow not installed here: the structural checks above stand
        expect(decoded).toEqual({ width: 40, height: 32 });
    });

    test('end to end: a JPEG with a trailer is uploaded without the trailer', async () => {
        const svc = await startFakeUploadService();
        const work = tempDir('trailer');
        const spies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
        try {
            const folder = path.join(work, 'export');
            write(folder, 'a.jpg', makeJpeg(8, 6, { trailer: TRAILER }));
            const out = await runImport({ folder, project: 'p1', version: 'v1', apiUrl: svc.url, apiKey: 'k', yes: true }, { ...recorder(), deps: { tools: [] } });
            expect(out.exitCode).toBe(0);
            const [bundle] = svc.state.received;
            for (const bytes of Object.values(bundle.files)) expect(hasSecret(bytes)).toBe(false);
        } finally {
            spies.forEach((spy) => spy.mockRestore());
            await svc.close();
            fs.rmSync(work, { recursive: true, force: true });
        }
    });
});

describe('guarantee-5 WebP: an allow-list of chunks', () => {
    const chunkNames = (buf) => {
        const names = [];
        for (let o = 12; o + 8 <= buf.length; o += 8 + buf.readUInt32LE(o + 4) + (buf.readUInt32LE(o + 4) % 2)) names.push(buf.toString('latin1', o, o + 4));
        return names;
    };

    test('an unknown chunk, a C2PA chunk, EXIF and XMP are dropped; the picture chunks, RIFF size and VP8X flags are right', () => {
        const src = makeWebp(5, 3, { unknown: [['ZZZZ', `${CANARY.gps}${CANARY.serial}x`], ['C2PA', CANARY.path]] });
        expect(hasSecret(src)).toBe(true);
        const out = stripMetadata(src, 'webp');
        expect(hasSecret(out)).toBe(false);
        expect(chunkNames(out)).toEqual(['VP8X', 'VP8L']);
        expect(out.readUInt32LE(4)).toBe(out.length - 8);
        expect(out[20] & 0x0c).toBe(0);
        expect(out.length % 2).toBe(0);
    });

    test('bytes after the RIFF size are dropped, and an unknown chunk inside an animation frame is dropped', () => {
        const frame = Buffer.concat([Buffer.alloc(16), riffChunk('ZZZZ', Buffer.from(CANARY.gps)), riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 1, 0, 0]))]);
        const body = Buffer.concat([
            Buffer.from('WEBP'), riffChunk('VP8X', Buffer.concat([Buffer.from([0x02, 0, 0, 0]), Buffer.alloc(6)])),
            riffChunk('ANIM', Buffer.alloc(6)), riffChunk('ANMF', frame),
        ]);
        const head = Buffer.alloc(8);
        head.write('RIFF');
        head.writeUInt32LE(body.length, 4);
        const out = stripMetadata(Buffer.concat([head, body, TRAILER]), 'webp');
        expect(hasSecret(out)).toBe(false);
        expect(chunkNames(out)).toEqual(['VP8X', 'ANIM', 'ANMF']);
        expect(out.readUInt32LE(4)).toBe(out.length - 8);
    });
});

describe('scry import: telemetry, prompt, terminal and folder rules', () => {
    let work;
    let svc;
    beforeEach(async () => {
        work = tempDir('rules');
        svc = await startFakeUploadService();
    });
    afterEach(async () => {
        await svc.close();
        fs.rmSync(work, { recursive: true, force: true });
    });
    const argvFor = (folder, extra = {}) => ({ folder, project: 'p1', version: 'v1', apiUrl: svc.url, apiKey: 'k', yes: true, ...extra });
    const tmpImports = () => fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('scry-import-') && !n.startsWith('scry-import-conv-'));

    test('F20: a canary path is scrubbed from error messages, breadcrumbs and events before Sentry gets them', () => {
        jest.isolateModules(() => {
            let options;
            jest.doMock('@sentry/node', () => ({ init: (o) => { options = o; } }));
            const saved = { ...process.env };
            delete process.env.DO_NOT_TRACK;
            delete process.env.SCRY_TELEMETRY;
            delete process.env.CI;
            process.env.NODE_ENV = 'production'; // telemetry is off under tests/CI (sentry-quota-noise)
            try {
                require('../lib/telemetry.js').initTelemetry();
            } finally {
                process.env = saved;
            }
            const message = `ENOENT: no such file or directory, open '${CANARY.path}/IMG_0001.psd'`;
            const event = options.beforeSend({
                message,
                exception: { values: [{ value: message }] },
                breadcrumbs: [{ message: `skipped ${CANARY.path}/IMG_0001.psd: x`, data: { file: CANARY.path } }],
                extra: { where: `C:\\Users\\designer\\Clients\\SECRET\\a.png and ~/Pictures/a.jpg` },
            });
            const crumb = options.beforeBreadcrumb({ message: `read ${CANARY.path}/IMG_0001.psd` });
            const text = JSON.stringify([event, crumb]);
            for (const leak of ['designer', 'SECRET-CANARY-PROJECT', 'IMG_0001', 'Pictures']) expect(text).not.toContain(leak);
            jest.dontMock('@sentry/node');
        });
    });

    test('F20: an unexpected error thrown during an import carries no folder, file name or temp path', async () => {
        const folder = path.join(work, 'CLIENT-FOLDER-CANARY');
        write(folder, 'IMG_SECRET_NAME.png', makePng());
        const convert = async (abs) => { throw new Error(`EACCES: permission denied, open '${abs}' under ${folder}`); };
        write(folder, 'x.psd', Buffer.from('8BPS'));
        const rec = recorder();
        const error = await runImport(argvFor(folder), { ...rec, deps: { tools: ['magick'], convert } }).then(() => null, (e) => e);
        expect(error).toBeInstanceOf(Error);
        for (const text of [error.message, error.stack]) {
            expect(text).not.toContain('CLIENT-FOLDER-CANARY');
            expect(text).not.toContain(work);
            expect(text).not.toContain('x.psd');
        }
    });

    test('F20: the default print writes straight to stdout, never through console.* (the Sentry breadcrumb path)', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const consoleSpies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
        const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const out = await runImport(argvFor(folder), { logger: recorder().logger, deps: { tools: [] } });
            expect(out.exitCode).toBe(0);
            expect(consoleSpies.some((spy) => spy.mock.calls.length > 0)).toBe(false);
            expect(stdout.mock.calls.map((c) => c[0]).join('')).toMatch(/Adobe Bridge import: 1 image ready/);
        } finally {
            stdout.mockRestore();
            consoleSpies.forEach((spy) => spy.mockRestore());
        }
    });

    test('F22: Ctrl-D / EOF at the prompt declines: exit 1, nothing sent, temp dir removed', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const before = tmpImports();
        // The real askYesNo on a stdin that is closed (EOF), as Ctrl-D produces.
        const { PassThrough } = require('stream');
        const fakeIn = new PassThrough();
        const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
        Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true });
        const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            const rec = recorder();
            const pending = runImport(argvFor(folder, { yes: false }), { ...rec, deps: { tools: [], isInteractive: () => true } });
            setTimeout(() => fakeIn.end(), 50);
            const out = await pending;
            expect(out.exitCode).toBe(1);
            expect(svc.state.requests).toHaveLength(0);
            expect(rec.lines.join('\n')).toMatch(/Nothing was uploaded/);
            expect(tmpImports()).toEqual(before);
        } finally {
            stdout.mockRestore();
            Object.defineProperty(process, 'stdin', realIn);
        }
    });

    test('F23: terminal escape and control characters in file names are not printed raw', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'evil\u001b[2Jname\u202e.png', Buffer.from('not a png'));
        const rec = recorder();
        await runImport(argvFor(folder, { dryRun: true }), { ...rec, deps: { tools: [] } });
        const printed = rec.lines.join('\n');
        expect(printed).toContain('skipped evil?[2J');
        expect(printed.includes('\u001b') || printed.includes('\u202e')).toBe(false);
    });

    test('F24: the home folder and the disk root are refused before anything is read', async () => {
        expect(() => scanFolder(require('os').homedir())).toThrow(ImportInputError);
        expect(() => scanFolder(path.parse(process.cwd()).root)).toThrow(/too broad/);
        const rec = recorder();
        const out = await runImport(argvFor(require('os').homedir()), rec);
        expect(out.exitCode).toBe(1);
        expect(rec.lines.join('\n')).toMatch(/too broad/);
        expect(svc.state.requests).toHaveLength(0);
    });

    test('F24: the second copy of a picture adds its sidecar metadata to the one capture', async () => {
        const folder = path.join(work, 'export');
        const bytes = makePng(4, 4, { shade: 9 });
        write(folder, 'a.png', bytes);
        write(folder, 'b copy.png', bytes);
        write(folder, 'b copy.xmp', Buffer.from(xmpPacket({ title: 'From the copy', keywords: ['alpha'], rating: 5, extra: false })));
        write(folder, 'a.xmp', Buffer.from(xmpPacket({ keywords: ['beta'], extra: false })));
        const out = await runImport(argvFor(folder), { ...recorder(), deps: { tools: [] } });
        expect(out.exitCode).toBe(0);
        const [capture] = svc.state.received[0].manifest.captures;
        expect(svc.state.received[0].manifest.captures).toHaveLength(1);
        expect(capture['x-adobe-bridge']).toEqual({ title: 'From the copy', rating: 5, keywords: ['beta', 'alpha'] });
        expect(capture.tags).toEqual(['beta', 'alpha']);
        expect(out.stats.withMetadata).toBe(1);
    });

    test('F25: consent text names what is sent, including the git commit and branch', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const rec = recorder();
        await runImport(argvFor(folder), { ...rec, deps: { tools: [], gitContext: () => ({ commitSha: 'abc1234def5678', branch: 'feature/x' }) } });
        const text = rec.lines.join('\n');
        expect(text).toMatch(/What is sent: the image files/);
        expect(text).toMatch(/title, description, keywords, rating and label/);
        expect(text).toMatch(/git commit abc1234def56 on branch feature\/x/);
        expect(text).toMatch(/OpenAI, Google Gemini and Jina/);
        expect(text).toMatch(/OpenAI writes a short description of each picture and sees only the picture/);
        expect(text).toMatch(/Rating and label stay in Scry/);
        expect(text).not.toMatch(/file-path data is never/);
        const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
        expect(readme).not.toMatch(/file paths are never read or sent/);
        expect(readme).toMatch(/git commit and branch/);
    });

    test('F25: the consent line names every service that sees the pictures, with its job', async () => {
        const folder = path.join(work, 'export');
        write(folder, 'a.png', makePng());
        const rec = recorder();
        await runImport(argvFor(folder), { ...rec, deps: { tools: [] } });
        const text = rec.lines.join('\n');
        for (const provider of ['OpenAI', 'Google Gemini', 'Jina']) expect(text).toContain(provider);
        expect(text).toMatch(/OpenAI writes a short description of each picture/);
        expect(text).toMatch(/Google Gemini and Jina turn each picture/);
        const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
        expect(readme).toMatch(/4096 px on the longest side and 4 MiB/);
        expect(readme).toMatch(/2048 px and 4 MiB/);
        expect(readme).not.toMatch(/20 MB or 16384 px/);
    });

    test('F26: every ImageMagick call carries memory, map, time, disk and area limits', async () => {
        const calls = [];
        const run = (file, args) => {
            calls.push({ file, args });
            if (args.includes('-version')) return { status: 0 };
            const out = args.find((a) => /^(png|jpeg):/.test(a));
            fs.writeFileSync(out.replace(/^(png|jpeg):/, ''), makePng(6, 5));
            return { status: 0 };
        };
        const res = await convertFile(write(work, 'a.psd', Buffer.from('8BPS')), '.psd', { tools: ['magick'], run });
        expect(res.ok).toBe(true);
        const convertCalls = calls.filter((c) => !c.args.includes('-version'));
        expect(convertCalls.length).toBeGreaterThan(0);
        for (const { args } of convertCalls) {
            const limits = {};
            args.forEach((a, i) => { if (a === '-limit') limits[args[i + 1]] = args[i + 2]; });
            expect(Object.keys(limits).sort()).toEqual(['area', 'disk', 'map', 'memory', 'time']);
            expect(args.indexOf('-limit')).toBeLessThan(args.findIndex((a) => a.startsWith('psd:')));
        }
        expect(MAGICK_LIMITS.map(([name]) => name).sort()).toEqual(['area', 'disk', 'map', 'memory', 'time']);
    });
});
