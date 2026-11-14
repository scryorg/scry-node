/**
 * `--changed-since <ref>`: which story files a change can reach.
 *
 * A story file is affected when a changed file is in its static import graph. Some changes reach
 * every story and are not visible in any one story's graph: the Storybook config directory,
 * anything the preview file imports (global styles, providers), and the root config and lock
 * files. Those select everything. When in doubt, more is selected, never less.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const GLOBAL_FILES = [
    /^package\.json$/, /^package-lock\.json$/, /^npm-shrinkwrap\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/,
    /^yarn\.lock$/, /^bun\.lockb?$/, /^[tj]sconfig(\.[\w-]+)?\.json$/,
    /^(vite|vitest|next|tailwind|postcss|babel|svelte|astro|nuxt)\.config\.[cm]?[jt]s$/,
    /^\.babelrc(\.\w+)?$/, /^\.browserslistrc$/, /^\.env(\.[\w.-]+)?$/,
];

const toPosix = (p) => String(p).split(path.sep).join('/');

/** A repo-relative path as a project-relative POSIX path (`../` for files outside the project). */
function toProjectRelative(file, repoRoot, projectDir) {
    return toPosix(path.relative(projectDir, path.resolve(repoRoot, file)));
}

/**
 * @param {string} file project-relative POSIX path
 * @returns {string|null} why the change reaches every story, or null
 */
function isGlobalChange(file, { configDirRel, previewInputs }) {
    // eslint-disable-next-line sonarjs/super-linear-regex -- a short path from the command line
    const dir = toPosix(configDirRel || '.storybook').replace(/\/+$/, '');
    if (file === dir || file.startsWith(`${dir}/`)) return `Storybook config changed (${file})`;
    if ((previewInputs || []).includes(file)) return `a file the Storybook preview imports changed (${file})`;
    // Root files of the project, or of a directory above it (a monorepo's lock file).
    const atRoot = file.replace(/^(\.\.\/)+/, '');
    if (!atRoot.includes('/') && GLOBAL_FILES.some((re) => re.test(atRoot))) return `${file} changed`;
    return null;
}

/**
 * @param {{graph: Record<string, string[]>, previewInputs?: string[], changedFiles: string[], configDirRel: string}} input
 *   graph: story file -> every file in its import graph (project-relative POSIX paths)
 * @returns {{global: boolean, reason: string|null, files: string[]}}
 */
function selectAffected({ graph, previewInputs = [], changedFiles: changed, configDirRel }) {
    const all = Object.keys(graph).sort();
    for (const file of changed) {
        const reason = isGlobalChange(file, { configDirRel, previewInputs });
        if (reason) return { global: true, reason, files: all };
    }
    const set = new Set(changed);
    const files = all.filter((story) => set.has(story) || graph[story].some((input) => set.has(input)));
    return { global: false, reason: null, files };
}

const splitZ = (out) => String(out || '').split('\0').filter(Boolean);

/**
 * Files that differ from `ref` (committed, staged, unstaged and untracked). `A..B` compares two
 * commits instead and ignores the working tree.
 * @returns {{repoRoot: string, files: string[]}} repo-relative POSIX paths
 */
function changedFiles(ref, { cwd, exec } = {}) {
    if (!ref || String(ref).startsWith('-')) throw new Error(`--changed-since ${ref}: expected a git ref such as origin/main or HEAD~1.`);
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is found on PATH, as everywhere else in this CLI
    const git = exec || ((args, opts) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    let repoRoot;
    try {
        repoRoot = String(git(['rev-parse', '--show-toplevel'], { cwd })).trim();
    } catch (error) {
        throw new Error(`--changed-since needs a git repository (${cwd}): ${firstLine(error)}`);
    }
    const files = new Set();
    try {
        for (const f of splitZ(git(['diff', '--no-ext-diff', '--name-only', '-z', ref, '--'], { cwd: repoRoot }))) files.add(toPosix(f));
    } catch (error) {
        throw new Error(`--changed-since ${ref}: git could not compare against that ref (${firstLine(error)}). In CI, fetch it first (a shallow clone does not have it).`);
    }
    if (!ref.includes('..')) {
        for (const f of splitZ(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot }))) files.add(toPosix(f));
    }
    return { repoRoot, files: [...files].sort() };
}

function firstLine(error) {
    const text = String((error && (error.stderr || error.message)) || error);
    return text.trim().split('\n').pop().trim();
}

const CODE_FILE = /\.([cm]?[jt]sx?|json)$/;

function applyAlias(spec, alias) {
    for (const entry of alias || []) {
        const { find, replacement } = entry;
        if (typeof replacement !== 'string') continue;
        if (find instanceof RegExp) {
            if (find.test(spec)) return spec.replace(find, replacement);
        } else if (typeof find === 'string' && (spec === find || spec.startsWith(`${find}/`))) {
            return replacement + spec.slice(find.length);
        }
    }
    return spec;
}

/**
 * The static import graph of every story file (and of the preview file), from esbuild's metafile.
 * Packages are left out: a dependency change shows up as a lock file change. An import that cannot
 * be resolved is skipped; a file that is not code is recorded but not read.
 *
 * @returns {Promise<{graph: Record<string, string[]>, previewInputs: string[]}>}
 */
async function buildGraph({ projectDir, entries, previewFile, alias, esbuild }) {
    const entryPoints = [...entries, ...(previewFile ? [previewFile] : [])];
    const plugin = {
        name: 'scry-capture-graph',
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.kind === 'entry-point' || (args.pluginData && args.pluginData.scry)) return null;
                // eslint-disable-next-line sonarjs/super-linear-regex -- runs on the project's own source files, not on untrusted input
                const spec = applyAlias(args.path.replace(/[?#].*$/, ''), alias);
                if (!spec || /^(data|https?|virtual|node):/.test(spec) || spec.startsWith('\0')) return { path: args.path, external: true };
                const resolved = await build.resolve(spec, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { scry: true } });
                if (resolved.errors.length) return { path: args.path, external: true };
                if (!resolved.external && /[\\/]node_modules[\\/]/.test(resolved.path)) return { path: args.path, external: true };
                return resolved;
            });
            build.onLoad({ filter: /.*/ }, (args) => (CODE_FILE.test(args.path) ? null : { contents: '', loader: 'js' }));
        },
    };
    const result = await esbuild.build({
        entryPoints,
        absWorkingDir: projectDir,
        bundle: true,
        write: false,
        metafile: true,
        splitting: false,
        format: 'esm',
        platform: 'browser',
        outdir: path.join(projectDir, '.scry-capture-graph-never-written'),
        logLevel: 'silent',
        packages: 'external',
        jsx: 'automatic',
        plugins: [plugin],
    });
    const previewRel = previewFile ? toPosix(path.relative(projectDir, previewFile)) : null;
    const graph = {};
    let previewInputs = [];
    for (const output of Object.values(result.metafile.outputs)) {
        if (!output.entryPoint) continue;
        const entry = toPosix(output.entryPoint);
        const inputs = Object.keys(output.inputs).map(toPosix).sort();
        if (entry === previewRel) previewInputs = inputs;
        else graph[entry] = inputs;
    }
    return { graph, previewInputs };
}

module.exports = { isGlobalChange, selectAffected, changedFiles, toProjectRelative, buildGraph, applyAlias, GLOBAL_FILES };
