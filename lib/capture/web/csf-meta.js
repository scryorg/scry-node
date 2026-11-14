/**
 * The declared story list: ids, titles and names come from Storybook's own index (so they are the
 * ids Storybook generates, auto-titles included); the line of each story and the component it
 * documents are read from the story file's text. A light scan, not a parser: anything it cannot
 * read is left out of the capture, never guessed.
 */
const fs = require('fs');
const path = require('path');

const COMPONENT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte'];

// eslint-disable-next-line sonarjs/cognitive-complexity -- one pass over the import clauses of a file
function importsOf(source) {
    /** local name -> {imported, from} */
    const imports = new Map();
    // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
    const re = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(source))) {
        const clause = m[1];
        const from = m[2];
        // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
        const named = /\{([^}]*)\}/.exec(clause);
        if (named) {
            for (const part of named[1].split(',')) {
                const spec = part.trim().replace(/^type\s+/, '');
                if (!spec) continue;
                // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
                const [imported, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
                imports.set(local || imported, { imported, from });
            }
        }
        // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
        const rest = clause.replace(/\{[^}]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const item of rest) {
            const ns = /^\*\s+as\s+([\w$]+)$/.exec(item);
            if (ns) imports.set(ns[1], { imported: '*', from });
            else if (/^[\w$]+$/.test(item)) imports.set(item, { imported: 'default', from });
        }
    }
    return imports;
}

/**
 * @param {string} source story file text
 * @returns {{exports: Record<string, number>, component: string|null, componentImport: string|null}}
 */
function scanStoryFile(source) {
    const text = String(source || '');
    const lines = text.split(/\r?\n/);
    const exports = {};
    lines.forEach((line, i) => {
        const direct = /^\s*export\s+(?:const|let|var|function\*?|async\s+function|class)\s+([\w$]+)/.exec(line);
        if (direct) {
            exports[direct[1]] = i + 1;
            return;
        }
        // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
        const list = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/.exec(line);
        if (list) {
            for (const part of list[1].split(',')) {
                // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
                const names = part.trim().split(/\s+as\s+/);
                const local = (names[0] || '').trim();
                const name = (names[1] || local).trim();
                if (!name || name === 'default' || !/^[\w$]+$/.test(local)) continue;
                // Point at where the story is written, not at the export list.
                const declaredAt = lines.findIndex((l) => new RegExp(`^\\s*(?:const|let|var|function\\*?|class)\\s+${local.replace(/\$/g, '\\$')}\\b`).test(l));
                exports[name] = (declaredAt >= 0 ? declaredAt : i) + 1;
            }
        }
    });

    let component = null;
    let componentImport = null;
    // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const found = /(?:^|[\s,{])component\s*:\s*([\w$]+)(?:\s*\.\s*([\w$]+))?/.exec(withoutComments);
    if (found) {
        const imports = importsOf(withoutComments);
        const local = found[1];
        const member = found[2];
        const imported = imports.get(local);
        if (member) component = member;
        else if (imported && imported.imported !== 'default' && imported.imported !== '*') component = imported.imported;
        else component = local;
        componentImport = imported ? imported.from : null;
    }
    return { exports, component, componentImport };
}

const toPosix = (p) => p.split(path.sep).join('/');

function insideProject(file, projectDir) {
    const rel = path.relative(projectDir, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : null;
}

/** A relative import of a story file -> the project-relative file it names, when that file exists. */
function resolveComponentFile(storyFile, spec, projectDir) {
    if (!spec || !spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(storyFile), spec);
    const candidates = [base, ...COMPONENT_EXTENSIONS.map((e) => base + e), ...COMPONENT_EXTENSIONS.map((e) => path.join(base, `index${e}`))];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) return insideProject(candidate, projectDir);
        } catch {
            // try the next spelling
        }
    }
    return null;
}

/**
 * @param {Record<string, object>} entries Storybook index entries
 * @param {{projectDir: string, readFile?: (file: string) => string}} ctx
 */
function buildDeclared(entries, { projectDir, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
    const scans = new Map();
    const scanOf = (abs) => {
        if (!scans.has(abs)) {
            let scan = null;
            try {
                scan = scanStoryFile(readFile(abs));
            } catch {
                // unreadable: the entry still counts as declared
            }
            scans.set(abs, scan);
        }
        return scans.get(abs);
    };

    const declared = [];
    for (const entry of Object.values(entries || {})) {
        if (!entry || entry.type !== 'story' || !entry.id) continue;
        const abs = path.resolve(projectDir, entry.importPath || '');
        const file = toPosix(path.relative(projectDir, abs));
        const scan = entry.importPath ? scanOf(abs) : null;
        const exportName = entry.exportName || null;
        let componentFile = null;
        if (entry.componentPath) componentFile = insideProject(path.resolve(projectDir, entry.componentPath), projectDir);
        else if (scan && scan.componentImport) componentFile = resolveComponentFile(abs, scan.componentImport, projectDir);
        declared.push({
            id: entry.id,
            title: entry.title || '',
            name: entry.name || '',
            exportName,
            file,
            line: (scan && exportName && scan.exports[exportName]) || null,
            component: (scan && scan.component) || null,
            componentFile,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string') : [],
        });
    }
    return declared.sort((a, b) => {
        if (a.id === b.id) return 0;
        return a.id < b.id ? -1 : 1;
    });
}

module.exports = { scanStoryFile, buildDeclared, resolveComponentFile };
