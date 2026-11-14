/** `capture web`: the SCF 1.0 bundle (no browser). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
    buildManifest, captureEntry, captureKind, sanitizeTags, sanitizeFields, boundedTree, truncateTree, fileStem, writeManifest,
    TOOL_NAME, STRUCTURE_MAX_NODES,
} = require('../lib/capture/web/scf-writer.js');
const { validateBundle } = require('../lib/scf.js');

const declared = {
    id: 'components-button--mobile', title: 'Components/Button', name: 'Mobile', exportName: 'Mobile',
    file: 'src/Button.stories.jsx', line: 26, component: 'Button', componentFile: 'src/Button.jsx', tags: ['dev', 'test', 'brand', 'phone'],
};
const result = {
    id: 'components-button--mobile',
    image: 'images/components-button--mobile.png',
    structure: 'structure/components-button--mobile.json',
    viewport: { width: 375, height: 667 },
    scale: 2,
    size: { width: 240, height: 96 },
    crop: 'root',
    theme: 'dark',
    tags: ['dev', 'test', 'brand', 'phone'],
    fields: { team: 'core', surface: 'mobile' },
    blankSuspect: false,
};

describe('captureEntry', () => {
    test('carries the fields scry-sbcov writes, plus the variant', () => {
        expect(captureEntry(declared, result)).toEqual({
            id: 'components-button--mobile',
            image: 'images/components-button--mobile.png',
            kind: 'component',
            title: ['Components', 'Button'],
            name: 'Mobile',
            code: { file: 'src/Button.stories.jsx', line: 26, component: 'Button', componentFile: 'src/Button.jsx' },
            variant: { theme: 'dark', viewport: { width: 375, height: 667 } },
            capture: { viewport: { width: 375, height: 667 }, scale: 2, size: { width: 240, height: 96 }, crop: 'root' },
            tags: ['brand', 'phone'],
            'x-scry-fields': { team: 'core', surface: 'mobile' },
            structure: { file: 'structure/components-button--mobile.json', origin: 'dom', format: 'scf-tree/1' },
        });
    });

    test('leaves out what is unknown; never a live link', () => {
        const entry = captureEntry(
            { id: 'badge--default', title: 'Badge', name: 'Default', exportName: 'Default', file: 'src/Badge.stories.jsx', line: null, component: null, componentFile: null, tags: [] },
            { id: 'badge--default', image: 'images/badge--default.png', structure: null, viewport: { width: 1280, height: 720 }, scale: 1, size: { width: 80, height: 40 }, crop: 'viewport', theme: null, tags: ['dev'], fields: null, blankSuspect: true },
        );
        expect(entry).toEqual({
            id: 'badge--default',
            image: 'images/badge--default.png',
            kind: 'component',
            title: ['Badge'],
            name: 'Default',
            code: { file: 'src/Badge.stories.jsx' },
            variant: { viewport: { width: 1280, height: 720 } },
            capture: { viewport: { width: 1280, height: 720 }, scale: 1, size: { width: 80, height: 40 }, crop: 'viewport' },
            'x-scry': { captureWarnings: ['blank_suspect'] },
        });
        expect(entry.links).toBeUndefined();
    });

    test('kind follows the first title segment', () => {
        expect(captureKind('Screens/Bigpage')).toBe('screen');
        expect(captureKind('pages / Home')).toBe('screen');
        expect(captureKind('Page/Home')).toBe('screen');
        expect(captureKind('Components/Screens')).toBe('component');
        expect(captureKind('')).toBe('component');
    });
});

describe('tags and fields follow the scry-sbcov contract', () => {
    test('tags: built-ins and ! tags out, trimmed, deduped, 1-64 characters, at most 100', () => {
        expect(sanitizeTags(['dev', 'test', 'autodocs', '!dev', ' brand ', 'brand', '', 'x'.repeat(65), 'ok\u0000', 7, null])).toEqual(['brand', 'ok']);
        expect(sanitizeTags(Array.from({ length: 150 }, (_, i) => `t${i}`))).toHaveLength(100);
        expect(sanitizeTags(undefined)).toEqual([]);
    });

    test('fields: key pattern, value types and caps; a bad one is dropped, never truncated', () => {
        expect(sanitizeFields({
            team: 'core', 'Release train': 12, flag: true, owners: ['a', 'b'],
            '1bad': 'x', 'bad/key': 'x', long: 'x'.repeat(501), nested: { a: 1 }, mixed: ['a', 1], nan: NaN,
            many: Array.from({ length: 21 }, () => 'a'), nothing: null, ctl: 'a\u0007b',
        })).toEqual({ team: 'core', 'Release train': 12, flag: true, owners: ['a', 'b'], ctl: 'ab' });
        const many = {};
        for (let i = 0; i < 60; i++) many[`k${i}`] = i;
        expect(Object.keys(sanitizeFields(many))).toHaveLength(50);
        expect(sanitizeFields(null)).toEqual({});
        expect(sanitizeFields('nope')).toEqual({});
        expect(sanitizeFields(['a'])).toEqual({});
    });
});

describe('structure trees', () => {
    const wide = (n) => ({ type: 'div', children: Array.from({ length: n }, (_, i) => ({ type: 'span', text: `n${i}` })) });

    test('boundedTree wraps a root as scf-tree/1 and caps the node count', () => {
        expect(boundedTree({ type: 'div' })).toEqual({ format: 'scf-tree/1', units: 'pt', root: { type: 'div' } });
        const doc = boundedTree(wide(STRUCTURE_MAX_NODES + 500));
        expect(doc.root.children).toHaveLength(STRUCTURE_MAX_NODES - 1);
        expect(boundedTree(null)).toBeNull();
        expect(boundedTree({ nope: true })).toBeNull();
    });

    test('boundedTree halves the tree until it fits 2 MB', () => {
        const big = { type: 'div', children: Array.from({ length: 4000 }, () => ({ type: 'p', text: 'x'.repeat(480), style: { shadow: 'y'.repeat(400) } })) };
        const doc = boundedTree(big);
        expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(doc.root.children.length).toBeGreaterThan(100);
    });

    test('truncateTree keeps the first nodes depth-first', () => {
        const tree = { type: 'a', children: [{ type: 'b', children: [{ type: 'c' }] }, { type: 'd' }] };
        expect(truncateTree(tree, 3)).toEqual({ type: 'a', children: [{ type: 'b', children: [{ type: 'c' }] }] });
        expect(truncateTree(tree, 0)).toBeNull();
    });
});

describe('fileStem', () => {
    test('story ids pass through; anything unsafe is replaced; collisions get a suffix', () => {
        const used = new Set();
        expect(fileStem('components-button--primary', used)).toBe('components-button--primary');
        expect(fileStem('a/b:c--d', used)).toBe('a_b_c--d');
        expect(fileStem('a_b_c--d', used)).toBe('a_b_c--d-2');
        expect(fileStem('..', used)).not.toMatch(/^\.+$/);
    });
});

describe('buildManifest + writeManifest', () => {
    const skipped = [
        { id: 'components-broken--throws', reason: 'error', detail: 'fixture story always throws' },
        { id: 'components-skipped--hidden', reason: 'filtered', detail: 'parameters.scry.capture.skip' },
    ];
    const base = {
        captures: [captureEntry(declared, result)],
        declared: 3,
        skipped,
        toolVersion: '9.9.9',
        framework: 'react',
        gitContext: { repository: 'https://github.com/acme/app', commitSha: 'a'.repeat(40), branch: 'main' },
        createdAt: '2026-11-14T00:00:00.000Z',
    };

    test('source, counts and repository', () => {
        const m = buildManifest(base);
        expect(m.scf).toBe('1.0');
        expect(m.source).toEqual({ kind: 'storybook', platform: 'web', framework: 'react', tool: { name: 'scry-deployer capture web', version: '9.9.9' } });
        expect(TOOL_NAME).toBe('scry-deployer capture web');
        expect(m.repository).toEqual({ url: 'https://github.com/acme/app', commit: 'a'.repeat(40), branch: 'main' });
        expect(m.createdAt).toBe('2026-11-14T00:00:00.000Z');
        expect(m.defaults).toEqual({ capture: { method: 'browser' } });
        expect(m.counts).toEqual({ declared: 3, captured: 1, skipped });
        expect(m.captures).toHaveLength(1);
        expect(JSON.stringify(m)).not.toContain('"live"');
    });

    test('no repository block without git; skip reasons outside the format become "error"', () => {
        const m = buildManifest({ ...base, gitContext: null, skipped: [{ id: 'x--y', reason: 'browser_died', detail: 'gone' }], declared: 2 });
        expect(m.repository).toBeUndefined();
        expect(m.counts.skipped).toEqual([{ id: 'x--y', reason: 'error', detail: 'browser_died: gone' }]);
    });

    test('a written bundle passes the SCF validator', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-capture-web-'));
        try {
            fs.mkdirSync(path.join(dir, 'images'));
            fs.mkdirSync(path.join(dir, 'structure'));
            await sharp({ create: { width: 240, height: 96, channels: 3, background: '#336699' } }).png().toFile(path.join(dir, result.image));
            fs.writeFileSync(path.join(dir, result.structure), JSON.stringify(boundedTree({ type: 'div', bounds: { x: 0, y: 0, width: 120, height: 48 } })));
            writeManifest(dir, buildManifest(base));
            const validation = await validateBundle(dir);
            expect(validation.errors).toEqual([]);
            expect(validation.ok).toBe(true);
            expect(validation.manifest.counts.declared).toBe(3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
