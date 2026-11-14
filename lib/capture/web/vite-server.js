/**
 * The project's own Vite dev server, configured the way Storybook configures it, serving one
 * extra page: the capture harness. Nothing is built or written into the project (the dependency
 * cache goes to node_modules/.cache, or to SCRY_CAPTURE_CACHE_DIR when set).
 *
 * The recipe follows @storybook/addon-vitest, the supported way to run stories outside
 * Storybook: the framework's `viteFinal` supplies plugins and aliases (and module mocking),
 * docs-only plugins are dropped, .mdx is stubbed.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createRequire } = require('module');
const { findPackageJson, importFromPackage, CaptureWebError } = require('./storybook-config.js');

const HARNESS_FILE = path.join(__dirname, 'harness', 'harness.mjs');
const PAGE_PATH = '/__scry_capture__.html';
const ENTRY_URL = '/@scry-capture/entry.js';
const ENTRY_ID = '\0scry-capture-entry.js';

/** Vite plugins Storybook adds for docs pages, or that only make sense inside Storybook's own builder. */
const DROPPED_PLUGINS = new Set([
    'storybook:react-docgen-plugin',
    'vite:react-docgen-typescript',
    'storybook:svelte-docgen-plugin',
    'storybook:vue-component-meta-plugin',
    'storybook:package-deduplication',
    'storybook:mdx-plugin',
]);

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm',
};

const toPosix = (p) => p.split(path.sep).join('/');

async function withoutDroppedPlugins(plugins) {
    const out = [];
    for (const plugin of (await Promise.all(plugins || [])) || []) {
        if (Array.isArray(plugin)) out.push(await withoutDroppedPlugins(plugin));
        else if (plugin && !DROPPED_PLUGINS.has(plugin.name)) out.push(plugin);
    }
    return out;
}

/** The project's Vite, wherever its package manager put it. */
async function loadVite(sb) {
    const frameworkDir = path.dirname(sb.frameworkPackageJson);
    let packageJson = findPackageJson('vite', sb.projectDir) || findPackageJson('vite', frameworkDir);
    if (!packageJson) {
        const builder = findPackageJson('@storybook/builder-vite', frameworkDir) || findPackageJson('@storybook/builder-vite', sb.projectDir);
        if (builder) packageJson = findPackageJson('vite', path.dirname(builder));
    }
    if (!packageJson) throw new CaptureWebError(`capture web needs "vite" installed in ${sb.projectDir} (for example: npm install --save-dev vite). It is resolved from your project, never bundled with scry-deployer.`);
    const vite = await importFromPackage(packageJson, '.');
    return { vite, packageJson, version: JSON.parse(fs.readFileSync(packageJson, 'utf8')).version };
}

/** esbuild for the import graph: the copy Vite itself uses, else the project's. */
function loadEsbuild(vitePackageJson, projectDir) {
    for (const from of [vitePackageJson, path.join(projectDir, 'package.json')]) {
        try {
            return createRequire(from)('esbuild');
        } catch {
            // try the next place
        }
    }
    throw new CaptureWebError(`--changed-since needs "esbuild" (normally installed with Vite) in ${projectDir}.`);
}

/** How the page imports a file: a root-relative URL inside the project, /@fs/ outside it. */
function urlFor(file, root) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `/${toPosix(rel)}`;
    return `/@fs/${toPosix(file).replace(/^\//, '')}`;
}

/** The module the harness page loads: every import the browser side needs, done through Vite. */
function entrySource({ sb, storyFiles, root }) {
    const lines = [
        `import * as sbTest from 'storybook/test';`,
        `import { Channel } from 'storybook/internal/channels';`,
        `import * as renderer from ${JSON.stringify(sb.rendererName)};`,
        `import * as framework from ${JSON.stringify(sb.frameworkName)};`,
        `import { init } from ${JSON.stringify(urlFor(HARNESS_FILE, root))};`,
    ];
    const annotations = [];
    sb.annotations.forEach((annotation, i) => {
        lines.push(`import * as annotation${i} from ${JSON.stringify(urlFor(annotation.file, root))};`);
        annotations.push(`{ kind: ${JSON.stringify(annotation.kind)}, mod: annotation${i} }`);
    });
    if (sb.previewFile) {
        lines.push(`import * as userPreview from ${JSON.stringify(urlFor(sb.previewFile, root))};`);
        annotations.push(`{ kind: 'user', mod: userPreview }`);
    }
    lines.push(
        // A framework that ships portable stories (e.g. @storybook/nextjs-vite) already includes its own annotations.
        `const fromFramework = typeof framework.composeStories === 'function' && typeof framework.setProjectAnnotations === 'function';`,
        `const api = fromFramework ? framework : renderer;`,
        `const unwrap = (mod) => (mod.default && mod.default._tag === 'Preview' && mod.default.composed ? mod.default.composed : mod);`,
        `const annotations = [${annotations.join(', ')}].filter((a) => !(fromFramework && a.kind === 'framework')).map((a) => unwrap(a.mod));`,
        `const loaders = {`,
        ...storyFiles.map((file) => `  ${JSON.stringify(file)}: () => import(${JSON.stringify(urlFor(path.resolve(root, file), root))}),`),
        `};`,
        `init({ api, annotations, loaders, Channel, sbTest });`,
    );
    return `${lines.join('\n')}\n`;
}

function pageHtml({ head, body }) {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>scry capture</title>',
        head || '',
        '</head>',
        '<body>',
        body || '',
        '<div id="storybook-root"></div>',
        '<div id="storybook-docs" hidden></div>',
        `<script type="module" src="${ENTRY_URL}"></script>`,
        '</body>',
        '</html>',
    ].join('\n');
}

function staticMiddleware(mounts) {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- one request handler: match a mount, guard the path, send the file
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let pathname;
        try {
            pathname = decodeURIComponent(String(req.url || '/').split(/[?#]/)[0]);
        } catch {
            return next();
        }
        for (const { dir, endpoint } of mounts) {
            const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
            if (pathname !== endpoint && !pathname.startsWith(base)) continue;
            const file = path.join(dir, pathname.slice(base.length));
            if (file !== dir && !file.startsWith(dir + path.sep)) continue;
            let stat;
            try {
                stat = fs.statSync(file);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            res.statusCode = 200;
            res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
            res.setHeader('Content-Length', String(stat.size));
            res.setHeader('Cache-Control', 'no-cache');
            if (req.method === 'HEAD') return res.end();
            return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        }
        return next();
    };
}

async function staticMounts(sb) {
    const dirs = await sb.presets.apply('staticDirs', []);
    const mounts = [];
    for (const staticDir of dirs || []) {
        try {
            const { staticPath, targetEndpoint } = sb.mapStaticDir(staticDir, sb.configDir);
            if (fs.existsSync(staticPath)) mounts.push({ dir: staticPath, endpoint: targetEndpoint || '/' });
        } catch {
            // a static dir that cannot be mapped is not served; stories that need it will show it
        }
    }
    // Longest endpoint first, so "/assets" wins over "/".
    return mounts.sort((a, b) => b.endpoint.length - a.endpoint.length);
}

function capturePlugin({ sb, storyFiles, root, html, mounts }) {
    const frameworkImporter = sb.frameworkPackageJson;
    const rootImporter = path.join(root, 'index.html');
    return {
        name: 'scry-capture-web',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (source === ENTRY_URL) return ENTRY_ID;
            // The entry is not a file: resolve its package imports from the project, then from the framework
            // package (pnpm does not hoist the renderer next to the framework).
            if (importer === ENTRY_ID && !source.startsWith('/') && !source.startsWith('.')) {
                const fromRoot = await this.resolve(source, rootImporter, { ...options, skipSelf: true });
                return fromRoot || this.resolve(source, frameworkImporter, { ...options, skipSelf: true });
            }
            if (/\.mdx$/.test(source.split('?')[0]) && !source.startsWith('\0')) return `\0scry-capture-mdx:${source}`;
            return null;
        },
        load(id) {
            if (id === ENTRY_ID) return entrySource({ sb, storyFiles, root });
            if (id.startsWith('\0scry-capture-mdx:')) return 'export default {};';
            return null;
        },
        configureServer(server) {
            server.middlewares.use(staticMiddleware(mounts));
            server.middlewares.use(async (req, res, next) => {
                if (String(req.url || '').split(/[?#]/)[0] !== PAGE_PATH) return next();
                try {
                    const page = await server.transformIndexHtml(PAGE_PATH, html);
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(page);
                } catch (error) {
                    next(error);
                }
            });
        },
    };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function stderrLogger(vite, verbose) {
    const logger = vite.createLogger(verbose ? 'info' : 'warn', { allowClearScreen: false });
    const write = (text) => process.stderr.write(`${text}\n`);
    return { ...logger, info: (msg) => verbose && write(msg), warn: (msg) => write(msg), warnOnce: (msg) => write(msg), error: (msg) => write(msg), clearScreen() {} };
}

/**
 * The Vite config for the capture server.
 * @param {{sb: object, vite: object, storyFiles: string[], port?: number, verbose?: boolean}} input storyFiles are project-relative
 */
async function buildViteConfig({ sb, vite, storyFiles, port = 0, verbose = false }) {
    const root = sb.projectDir;
    const { presets, options } = sb;
    const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, undefined, root);
    const userConfig = loaded && loaded.config ? loaded.config : {};

    const [extraDeps, previewHead, previewBody, mounts] = await Promise.all([
        presets.apply('optimizeViteDeps', []),
        presets.apply('previewHead', ''),
        presets.apply('previewBody', ''),
        staticMounts(sb),
    ]);

    const userPrefix = userConfig.envPrefix;
    const envPrefix = [...new Set([...(Array.isArray(userPrefix) ? userPrefix : [userPrefix || 'VITE_']), 'STORYBOOK_', 'VITE_'])];
    const clientConditions = Array.isArray(vite.defaultClientConditions) ? vite.defaultClientConditions : ['module', 'browser', 'development|production'];
    const cacheDir = process.env.SCRY_CAPTURE_CACHE_DIR
        ? path.resolve(process.env.SCRY_CAPTURE_CACHE_DIR)
        : path.join(root, 'node_modules', '.cache', 'scry-capture-web');
    const html = pageHtml({ head: previewHead, body: previewBody });

    const base = {
        root,
        cacheDir,
        envPrefix,
        resolve: { conditions: ['storybook', 'stories', 'test', ...clientConditions] },
        optimizeDeps: {
            entries: [...storyFiles, ...(sb.previewFile ? [toPosix(path.relative(root, sb.previewFile))] : [])],
            include: [...new Set(['storybook/test', 'storybook/internal/channels', sb.rendererName, sb.frameworkName, 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', ...(extraDeps || [])])],
        },
        define: { FEATURES: JSON.stringify(sb.features || {}) },
    };
    let config = vite.mergeConfig(userConfig, base);
    config = (await presets.apply('viteFinal', config, options)) || config;

    const forced = {
        configFile: false,
        root,
        cacheDir,
        appType: 'custom',
        clearScreen: false,
        customLogger: stderrLogger(vite, verbose),
        server: {
            host: '127.0.0.1',
            port,
            strictPort: true,
            open: false,
            hmr: false,
            watch: null,
            fs: { allow: [vite.searchForWorkspaceRoot(root), path.dirname(HARNESS_FILE), ...sb.annotations.map((a) => path.dirname(a.file))] },
        },
    };
    const plugins = [capturePlugin({ sb, storyFiles, root, html, mounts }), ...(await withoutDroppedPlugins(config.plugins))];
    const merged = vite.mergeConfig({ ...config, plugins: [] }, forced);
    merged.plugins = plugins;
    // mergeConfig joins arrays; these two must be exactly ours.
    merged.server.watch = null;
    merged.server.hmr = false;
    return merged;
}

/** Start the capture server on a free local port. */
async function startServer({ sb, vite, storyFiles, verbose }) {
    const port = await freePort();
    const config = await buildViteConfig({ sb, vite, storyFiles, port, verbose });
    const server = await vite.createServer(config);
    await server.listen();
    return {
        server,
        url: `http://127.0.0.1:${port}${PAGE_PATH}`,
        origin: `http://127.0.0.1:${port}`,
        close: () => server.close(),
    };
}

/** The resolved `resolve.alias` list, without starting a server (for the import graph). */
async function resolveAliases({ sb, vite, storyFiles }) {
    const config = await buildViteConfig({ sb, vite, storyFiles });
    const resolved = await vite.resolveConfig(config, 'serve', 'development');
    return resolved.resolve.alias || [];
}

module.exports = { loadVite, loadEsbuild, buildViteConfig, startServer, resolveAliases, entrySource, urlFor, PAGE_PATH };
