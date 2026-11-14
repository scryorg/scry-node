/**
 * The SCF 1.0 bundle `capture web` writes: `scf.json`, `images/<story id>.png` and one
 * `structure/<story id>.json` dom tree per story.
 *
 * Field for field what scry-sbcov writes for a built Storybook (id, kind, title, name, code,
 * capture, tags, x-scry-fields, structure), plus `variant {theme, viewport}`. There is no
 * `links.live`: nothing is deployed, so there is no live story to link to.
 */
const fs = require('fs');
const path = require('path');
const { SCF_SCHEMA_URL } = require('../../scf.js');

const TOOL_NAME = 'scry-deployer capture web';
const BLANK_SUSPECT = 'blank_suspect';

// The custom-metadata contract shared with scry-sbcov, build-processing and the dashboard.
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 64;
const MAX_FIELD_KEYS = 50;
const MAX_FIELD_STRING = 500;
const MAX_FIELD_ARRAY = 20;
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_ -]{0,63}$/;
/** Storybook's own tags: they say how Storybook treats a story, not what the story is about. */
const BUILT_IN_TAGS = new Set(['dev', 'test', 'autodocs']);
// eslint-disable-next-line no-control-regex -- stripping C0/C1 control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi controls and zero-width characters can reverse or hide text in a chip.
const INVISIBLE_CHARS = /[\u200b-\u200d\ufeff\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex -- C0/C1 controls except tab and newline
const FIELD_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const STRUCTURE_MAX_NODES = 5000;
const STRUCTURE_MAX_BYTES = 2 * 1024 * 1024;

/** The skip reasons SCF 1.0 knows. Anything else is written as "error" with the reason in the detail. */
const SCF_SKIP_REASONS = new Set(['error', 'timeout', 'filtered', 'unsupported', 'empty']);

function captureKind(title) {
    const first = String(title || '').split('/')[0].trim();
    return /^(screens?|pages?)$/i.test(first) ? 'screen' : 'component';
}

const isExcludedTag = (tag) => tag.startsWith('!') || BUILT_IN_TAGS.has(tag);

/** Built-ins and `!` tags out; control, bidi and zero-width characters stripped; 1-64 characters; at most 100. */
function sanitizeTags(raw) {
    const tags = [];
    const seen = new Set();
    for (const original of Array.isArray(raw) ? raw : []) {
        if (typeof original !== 'string') continue;
        const tag = original.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim();
        if (isExcludedTag(original) || isExcludedTag(tag) || seen.has(tag)) continue;
        const length = [...tag].length;
        if (length < 1 || length > MAX_TAG_LENGTH || tags.length >= MAX_TAGS) continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}

function cleanString(value) {
    const text = value.replace(FIELD_CONTROL_CHARS, '');
    return [...text].length <= MAX_FIELD_STRING ? text : undefined;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- one branch per JSON value kind
function cleanValue(value) {
    if (typeof value === 'string') return cleanString(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (value.length > MAX_FIELD_ARRAY) return undefined;
        const items = [];
        for (const item of value) {
            const text = typeof item === 'string' ? cleanString(item) : undefined;
            if (text === undefined) return undefined;
            items.push(text);
        }
        return items;
    }
    return undefined;
}

/** `parameters.scry.fields` under the contract: a value outside it is dropped, never truncated. */
function sanitizeFields(raw) {
    const fields = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
    let kept = 0;
    for (const [key, value] of Object.entries(raw)) {
        const clean = FIELD_KEY_PATTERN.test(key) ? cleanValue(value) : undefined;
        if (clean === undefined || kept >= MAX_FIELD_KEYS) continue;
        fields[key] = clean;
        kept++;
    }
    return fields;
}

function countNodes(node) {
    return 1 + (node.children || []).reduce((n, c) => n + countNodes(c), 0);
}

/** The first `budget` nodes in depth-first order. */
function truncateTree(node, budget) {
    let left = budget;
    const walk = (n) => {
        if (left <= 0) return null;
        left--;
        const { children, ...rest } = n;
        const out = { ...rest };
        if (children && children.length) {
            const kept = [];
            for (const c of children) {
                const k = walk(c);
                if (!k) break;
                kept.push(k);
            }
            if (kept.length) out.children = kept;
        }
        return out;
    };
    return walk(node);
}

/** A scf-tree/1 document within the node and byte caps, or null when there is nothing. */
function boundedTree(root) {
    if (!root || typeof root.type !== 'string') return null;
    let budget = Math.min(STRUCTURE_MAX_NODES, countNodes(root));
    let doc = { format: 'scf-tree/1', units: 'pt', root: truncateTree(root, budget) };
    while (Buffer.byteLength(JSON.stringify(doc)) > STRUCTURE_MAX_BYTES && budget > 1) {
        budget = Math.floor(budget / 2);
        doc = { format: 'scf-tree/1', units: 'pt', root: truncateTree(root, budget) };
    }
    return doc;
}

/** A file name for a story id: ids Storybook generates pass through unchanged. */
function fileStem(id, used) {
    let stem = String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
    if (!stem || /^\.+$/.test(stem)) stem = `story_${stem.length}`;
    let candidate = stem;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
        candidate = `${stem}-${n}`;
        n += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * One `captures[]` entry.
 * @param {object} declared from csf-meta.buildDeclared
 * @param {object} result {image, structure, viewport, scale, size, crop, theme, tags, fields, blankSuspect}
 */
function captureEntry(declared, result) {
    const title = String(declared.title || '').split('/').map((s) => s.trim()).filter(Boolean);
    const tags = sanitizeTags(result.tags || declared.tags);
    const fields = sanitizeFields(result.fields);
    return {
        id: declared.id,
        image: result.image,
        kind: captureKind(declared.title),
        ...(title.length ? { title } : {}),
        name: declared.name,
        code: {
            file: declared.file,
            ...(declared.line ? { line: declared.line } : {}),
            ...(declared.component ? { component: declared.component } : {}),
            ...(declared.componentFile ? { componentFile: declared.componentFile } : {}),
        },
        variant: { ...(result.theme ? { theme: String(result.theme) } : {}), viewport: result.viewport },
        capture: { viewport: result.viewport, scale: result.scale, size: result.size, crop: result.crop },
        ...(tags.length ? { tags } : {}),
        ...(Object.keys(fields).length ? { 'x-scry-fields': fields } : {}),
        ...(result.blankSuspect ? { 'x-scry': { captureWarnings: [BLANK_SUSPECT] } } : {}),
        ...(result.structure ? { structure: { file: result.structure, origin: 'dom', format: 'scf-tree/1' } } : {}),
    };
}

function skippedEntry(skip) {
    const known = SCF_SKIP_REASONS.has(skip.reason);
    const detail = known ? skip.detail : [skip.reason, skip.detail].filter(Boolean).join(': ');
    return { id: skip.id, reason: known ? skip.reason : 'error', ...(detail ? { detail: String(detail).slice(0, 2000) } : {}) };
}

/** scf.json (pure). */
function buildManifest({ captures, declared, skipped, toolVersion, framework, gitContext, createdAt }) {
    const git = gitContext || {};
    const repository = {
        ...(git.repository ? { url: git.repository } : {}),
        ...(git.commitSha ? { commit: git.commitSha } : {}),
        ...(git.branch ? { branch: git.branch } : {}),
    };
    return {
        $schema: SCF_SCHEMA_URL,
        scf: '1.0',
        source: {
            kind: 'storybook',
            platform: 'web',
            ...(framework ? { framework } : {}),
            tool: { name: TOOL_NAME, version: toolVersion },
        },
        ...(Object.keys(repository).length ? { repository } : {}),
        createdAt: createdAt || new Date().toISOString(),
        defaults: { capture: { method: 'browser' } },
        counts: { declared, captured: captures.length, skipped: (skipped || []).map(skippedEntry) },
        captures,
    };
}

function writeManifest(outDir, manifest) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'scf.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Remove what an earlier run left in outDir (only the members this tool writes). */
function resetOutDir(outDir) {
    for (const member of ['images', 'structure', 'scf.json']) fs.rmSync(path.join(outDir, member), { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'structure'), { recursive: true });
}

module.exports = {
    TOOL_NAME, BLANK_SUSPECT, STRUCTURE_MAX_NODES, STRUCTURE_MAX_BYTES,
    captureKind, sanitizeTags, sanitizeFields, truncateTree, boundedTree, fileStem, captureEntry, skippedEntry, buildManifest, writeManifest, resetOutDir,
};
