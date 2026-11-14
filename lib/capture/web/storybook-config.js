/**
 * Reads a project's Storybook configuration without building it.
 *
 * Everything is resolved from the user's project (`storybook` is not a dependency of this
 * package): `storybook/internal/core-server` loads main.* and its presets, and Storybook's own
 * index generator lists the stories, so story ids are exactly the ones Storybook generates.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PREVIEW_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'];
/** Addon preview annotations a capture does not need: docs rendering, accessibility checks, the test runner bridge. */
const SKIPPED_ANNOTATION_PACKAGES = new Set(['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest', '@storybook/addon-onboarding']);

class CaptureWebError extends Error {}

function missingPackage(name, projectDir) {
    return new CaptureWebError(`capture web needs "${name}" installed in ${projectDir} (for example: npm install --save-dev ${name}). It is resolved from your project, never bundled with scry-deployer.`);
}

/**
 * Path of `<name>/package.json` as seen from `fromDir`, or null.
 *
 * Walks node_modules upward by hand instead of asking require.resolve: that also works for
 * packages that do not export ./package.json, and it ignores NODE_PATH (package-manager bin
 * shims set it to scry-deployer's own tree, which is not the project's).
 */
function findPackageJson(name, fromDir) {
    for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
        if (path.basename(dir) !== 'node_modules') {
            const candidate = path.join(dir, 'node_modules', name, 'package.json');
            if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
        }
        if (path.dirname(dir) === dir) return null;
    }
}

function pickExport(target) {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return target.map(pickExport).find(Boolean) || null;
    if (target && typeof target === 'object') {
        for (const key of ['import', 'node', 'default', 'require']) {
            const found = pickExport(target[key]);
            if (found) return found;
        }
    }
    return null;
}

/** Import an ES module entry of a package by reading its export map (require.resolve cannot see "import"-only entries). */
async function importFromPackage(packageJsonPath, subpath = '.') {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const exportsField = pkg.exports;
    let target = null;
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) && Object.keys(exportsField).some((k) => k.startsWith('.'))) {
        target = pickExport(exportsField[subpath]);
    } else if (subpath === '.') {
        target = pickExport(exportsField) || pkg.module || pkg.main || 'index.js';
    }
    if (!target) throw new CaptureWebError(`"${pkg.name}" (${pkg.version}) has no "${subpath}" entry; this Storybook or Vite version is not supported by capture web.`);
    return import(pathToFileURL(path.join(path.dirname(packageJsonPath), target)).href);
}

/** `@scope/name` or `name` of the package a file inside node_modules belongs to. */
function packageNameOf(file) {
    const text = String(file).replace(/\\/g, '/');
    const at = text.lastIndexOf('/node_modules/');
    if (at < 0) return null;
    const parts = text.slice(at + '/node_modules/'.length).split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function nameOf(value) {
    if (typeof value === 'string') return value;
    return value && typeof value.name === 'string' ? value.name : '';
}

/** A preset name can be a package name or an absolute path (file: URL included) into the package. */
function toPackageName(value) {
    let text = nameOf(value);
    if (text.startsWith('file:')) text = decodeURIComponent(new URL(text).pathname);
    if (!path.isAbsolute(text)) return text.split('/').slice(0, text.startsWith('@') ? 2 : 1).join('/');
    const fromModules = packageNameOf(text);
    if (fromModules) return fromModules;
    for (let dir = text; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.name) return pkg.name;
        } catch {
            // keep walking up
        }
    }
    return text;
}

function findPreviewFile(configDir) {
    for (const ext of PREVIEW_EXTENSIONS) {
        const file = path.join(configDir, `preview.${ext}`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

/**
 * @param {{projectDir: string, configDir: string}} input
 * @returns {Promise<object>} what the Vite server, the driver and the bundle writer need
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- a linear sequence of checks, each with its own error message
async function loadStorybookProject({ projectDir, configDir }) {
    if (!fs.existsSync(configDir) || !fs.statSync(configDir).isDirectory()) {
        throw new CaptureWebError(`No Storybook config directory at ${configDir}. Run capture web from the project that holds .storybook/, or pass --config-dir <dir>.`);
    }
    const storybookPackageJson = findPackageJson('storybook', projectDir);
    if (!storybookPackageJson) throw missingPackage('storybook', projectDir);
    const storybookVersion = JSON.parse(fs.readFileSync(storybookPackageJson, 'utf8')).version;

    // Capture makes no network calls: Storybook's own telemetry and update check stay off.
    process.env.STORYBOOK_DISABLE_TELEMETRY = '1';
    process.env.NODE_ENV = process.env.NODE_ENV || 'development';
    // Storybook reads stories and static dirs relative to the working directory.
    process.chdir(projectDir);

    let coreServer;
    let common;
    try {
        coreServer = await importFromPackage(storybookPackageJson, './internal/core-server');
        common = await importFromPackage(storybookPackageJson, './internal/common');
    } catch (error) {
        if (error instanceof CaptureWebError) throw error;
        throw new CaptureWebError(`Could not load Storybook ${storybookVersion} from ${path.dirname(storybookPackageJson)}: ${error.message}`);
    }
    if (typeof coreServer.experimental_loadStorybook !== 'function' || typeof coreServer.StoryIndexGenerator !== 'function') {
        throw new CaptureWebError(`Storybook ${storybookVersion} is too old for capture web (it needs Storybook 9 or newer).`);
    }

    const options = await coreServer.experimental_loadStorybook({ configDir, packageJson: {} });
    const { presets } = options;

    const [framework, core, storiesSpec, indexers, docs, features] = await Promise.all([
        presets.apply('framework', undefined),
        presets.apply('core', {}),
        presets.apply('stories', []),
        presets.apply('experimental_indexers', []),
        presets.apply('docs', {}),
        presets.apply('features', {}),
    ]);

    const frameworkName = toPackageName(framework);
    const rendererName = toPackageName(core && core.renderer);
    const builderName = toPackageName(core && core.builder);
    if (!/builder-vite/.test(builderName) && !/-vite$/.test(frameworkName)) {
        throw new CaptureWebError(`capture web needs a Vite-based Storybook framework (for example @storybook/react-vite); this project uses "${frameworkName || 'unknown'}" with builder "${builderName || 'unknown'}". Build Storybook and use \`scry-deployer\` to deploy it instead.`);
    }
    if (rendererName !== '@storybook/react') {
        throw new CaptureWebError(`capture web supports React Storybooks in this version; this project renders with "${rendererName || 'unknown'}" (framework "${frameworkName || 'unknown'}"). Build Storybook and use \`scry-deployer\` to deploy it instead.`);
    }
    const frameworkPackageJson = findPackageJson(frameworkName, projectDir);
    if (!frameworkPackageJson) throw missingPackage(frameworkName, projectDir);
    const frameworkDir = path.dirname(frameworkPackageJson);
    const rendererPackageJson = findPackageJson(rendererName, frameworkDir) || findPackageJson(rendererName, projectDir);
    if (!rendererPackageJson) throw missingPackage(rendererName, projectDir);

    const previewFile = findPreviewFile(configDir);
    const rawAnnotations = await presets.apply('previewAnnotations', [], options);
    const annotations = [];
    for (const entry of rawAnnotations || []) {
        const absolute = typeof entry === 'string' ? entry : entry && entry.absolute;
        if (!absolute) continue;
        const file = absolute.startsWith('file:') ? decodeURIComponent(new URL(absolute).pathname) : absolute;
        if (previewFile && path.resolve(file) === previewFile) continue;
        const pkg = packageNameOf(file) || packageNameOf(fs.existsSync(file) ? fs.realpathSync(file) : file);
        if (pkg === rendererName || pkg === 'storybook' || SKIPPED_ANNOTATION_PACKAGES.has(pkg)) continue;
        annotations.push({ file, pkg, kind: pkg === frameworkName ? 'framework' : 'addon' });
    }

    return {
        projectDir,
        configDir,
        options,
        presets,
        features,
        core,
        storybookVersion,
        storybookPackageJson,
        frameworkName,
        frameworkPackageJson,
        rendererName,
        rendererPackageJson,
        /** SCF `source.framework`. */
        framework: 'react',
        /** Storybook's own story index (ids, titles, names, export names, tags), without a build. */
        async buildIndex() {
            const workingDir = process.cwd();
            const normalizedStories = common.normalizeStories(storiesSpec, { configDir, workingDir });
            const generator = new coreServer.StoryIndexGenerator(normalizedStories, { configDir, workingDir, indexers, docs, build: {} });
            await generator.initialize();
            return generator.getIndex();
        },
        previewFile,
        annotations,
        mapStaticDir: coreServer.mapStaticDir,
        importStorybook: (subpath) => importFromPackage(storybookPackageJson, subpath),
    };
}

module.exports = { loadStorybookProject, findPackageJson, importFromPackage, packageNameOf, toPackageName, CaptureWebError };
