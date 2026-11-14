/**
 * Browser side of `scry-deployer capture web`.
 *
 * Plain ES module with no imports: the generated entry module (see vite-server.js) does every
 * import through the project's own Vite server and hands the results to `init`. Stories are
 * rendered with Storybook's portable-stories API (`composeStories` + `story.run`), the same
 * path @storybook/addon-vitest uses, so decorators, loaders, play functions and module mocks
 * behave as they do in the project's Storybook.
 *
 * The driver talks to `window.__scryCapture` only.
 */
/* global window, document, requestAnimationFrame */

const LAYOUT_CSS = `
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}
body.scry-layout-padded{padding:1rem;box-sizing:border-box}
body.scry-layout-centered{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box;margin:0}
body.scry-layout-fullscreen{margin:0}
`;

/** Storybook's built-in viewport names, for projects that pick one without listing its size. */
const BUILT_IN_VIEWPORTS = {
    mobile1: [320, 568], mobile2: [414, 896], tablet: [834, 1112], desktop: [1280, 1024],
    iphone5: [320, 568], iphone6: [375, 667], iphone6p: [414, 736], iphone8p: [414, 736], iphonex: [375, 812],
    iphonexr: [414, 896], iphonexsmax: [414, 896], iphonese2: [375, 667], iphone12mini: [375, 812],
    iphone12: [390, 844], iphone12promax: [428, 926], iphone14: [390, 844], iphone14promax: [430, 932],
    ipad: [768, 1024], ipad10p: [834, 1112], ipad11p: [834, 1194], ipad12p: [1024, 1366],
    pixel: [412, 732], pixelxl: [412, 847], galaxys9: [360, 740],
};

function size(width, height) {
    const w = Math.round(parseFloat(width));
    const h = Math.round(parseFloat(height));
    return w >= 1 && h >= 1 && w <= 10000 && h <= 10000 ? { width: w, height: h } : null;
}

/** The viewport a story asks for: parameters.scry.capture.viewport first, then Storybook's own viewport setting. */
function viewportOf(story) {
    const parameters = story.parameters || {};
    const own = parameters.scry && parameters.scry.capture && parameters.scry.capture.viewport;
    if (own && typeof own === 'object') {
        const s = size(own.width, own.height);
        if (s) return s;
    }
    const globals = story.globals || {};
    const picked = globals.viewport && typeof globals.viewport === 'object' ? globals.viewport.value : globals.viewport;
    const config = parameters.viewport || {};
    const options = config.options || config.viewports || {};
    const name = typeof picked === 'string' && picked ? picked : config.defaultViewport;
    if (typeof name !== 'string' || !name || name === 'responsive' || name === 'reset') return null;
    const styles = options[name] && options[name].styles;
    if (styles && /^\s*[\d.]+(px)?\s*$/.test(String(styles.width)) && /^\s*[\d.]+(px)?\s*$/.test(String(styles.height))) {
        return size(styles.width, styles.height);
    }
    return BUILT_IN_VIEWPORTS[name] ? size(...BUILT_IN_VIEWPORTS[name]) : null;
}

function themeOf(story) {
    const theme = story.globals && story.globals.theme;
    return typeof theme === 'string' && theme ? theme : null;
}

function messageOf(error) {
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message || error.name || 'Error';
    return String(error);
}

const frame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => {
        if (!done) {
            done = true;
            resolve();
        }
    };
    requestAnimationFrame(finish);
    // A page that is not being painted never gets a frame: do not wait for one for ever.
    setTimeout(finish, 250);
});

/**
 * @param {object} deps
 *   api: {composeStories, setProjectAnnotations}; annotations: project annotation modules in order;
 *   loaders: {storyFile: () => import(...)}; Channel: Storybook's channel class; sbTest: `storybook/test`.
 */
export function init(deps) {
    const { api, annotations, loaders, Channel, sbTest } = deps;
    const root = document.getElementById('storybook-root');
    const initial = { bodyClass: document.body.className, htmlClass: document.documentElement.className, bodyStyle: document.body.getAttribute('style') };
    const modules = new Map();
    const composed = new Map();
    let blank = null;

    const style = document.createElement('style');
    style.setAttribute('data-scry-capture', '');
    style.textContent = LAYOUT_CSS;
    document.head.appendChild(style);

    const state = { ready: false, initError: null };

    async function start() {
        globalThis.__STORYBOOK_MODULE_TEST__ = sbTest;
        if (Channel && !globalThis.__STORYBOOK_ADDONS_CHANNEL__) {
            globalThis.__STORYBOOK_ADDONS_CHANNEL__ = new Channel({ transport: { setHandler() {}, send() {} } });
        }
        const project = api.setProjectAnnotations(annotations);
        const hooks = project && typeof project.beforeAll === 'function' ? project : globalThis.globalProjectAnnotations;
        if (hooks && typeof hooks.beforeAll === 'function') await hooks.beforeAll();
        blank = api.composeStories({ default: { title: 'Scry Capture/Blank' }, Blank: { render: () => null } }).Blank;
    }

    const started = start().then(
        () => {
            state.ready = true;
        },
        (error) => {
            state.initError = messageOf(error);
        },
    );

    async function load(file) {
        if (!modules.has(file)) {
            const loader = loaders[file];
            if (!loader) throw new Error(`"${file}" is not a story file this capture knows`);
            modules.set(file, await loader());
        }
        return modules.get(file);
    }

    /** The composed stories of a file. The title comes from Storybook's index so auto-titled files keep their real ids. */
    async function stories(file, title) {
        const key = `${file}\n${title || ''}`;
        if (!composed.has(key)) {
            const mod = await load(file);
            const meta = { ...(mod.default || {}) };
            if (title && !meta.title) meta.title = title;
            composed.set(key, api.composeStories({ ...mod, default: meta }));
        }
        return composed.get(key);
    }

    async function story(file, exportName, title) {
        const all = await stories(file, title);
        const found = all[exportName];
        if (!found) throw new Error(`"${file}" has no story export named "${exportName}"`);
        return found;
    }

    function clearLayout() {
        document.body.className = initial.bodyClass;
        document.documentElement.className = initial.htmlClass;
        if (initial.bodyStyle === null) document.body.removeAttribute('style');
        else document.body.setAttribute('style', initial.bodyStyle);
    }

    function hasPortal() {
        return Boolean(document.querySelector('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[data-radix-portal],[data-sonner-toaster],[data-floating-ui-portal]'));
    }

    const harness = {
        state,
        async whenReady() {
            await started;
            return { ready: state.ready, error: state.initError };
        },
        files: () => Object.keys(loaders),
        /** Import one story file (warm-up). */
        async load(file) {
            try {
                await load(file);
                return { ok: true };
            } catch (error) {
                modules.delete(file);
                return { ok: false, detail: messageOf(error) };
            }
        },
        /** What the driver must know before it renders a story. */
        async describe({ file, exportName, title }) {
            try {
                const s = await story(file, exportName, title);
                const parameters = s.parameters || {};
                const scry = parameters.scry && typeof parameters.scry === 'object' ? parameters.scry : {};
                const capture = scry.capture && typeof scry.capture === 'object' ? scry.capture : {};
                return {
                    ok: true,
                    id: s.id,
                    tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
                    skip: capture.skip === true,
                    delay: Number.isFinite(capture.delay) && capture.delay > 0 ? Math.min(capture.delay, 60000) : 0,
                    fullPage: capture.fullPage === true,
                    fields: scry.fields && typeof scry.fields === 'object' ? JSON.parse(JSON.stringify(scry.fields)) : null,
                    theme: themeOf(s),
                    viewport: viewportOf(s),
                    layout: typeof parameters.layout === 'string' ? parameters.layout : 'padded',
                };
            } catch (error) {
                return { ok: false, detail: messageOf(error) };
            }
        },
        /** Render one story into a fresh host element and wait until it is settled. */
        async render({ file, exportName, title, timeout }) {
            let s;
            try {
                s = await story(file, exportName, title);
            } catch (error) {
                return { ok: false, reason: 'error', detail: messageOf(error) };
            }
            clearLayout();
            const layout = (s.parameters && s.parameters.layout) || 'padded';
            if (['padded', 'centered', 'fullscreen'].includes(layout)) document.body.classList.add(`scry-layout-${layout}`);
            const host = document.createElement('div');
            host.setAttribute('data-scry-host', '1');
            root.appendChild(host);

            let timer;
            const timedOut = new Promise((resolve) => {
                timer = setTimeout(() => resolve({ timedOut: true }), timeout);
            });
            const run = Promise.resolve()
                .then(() => s.run({ canvasElement: host }))
                .then(() => ({}), (error) => ({ error }));
            const outcome = await Promise.race([run, timedOut]);
            clearTimeout(timer);
            if (outcome.timedOut) return { ok: false, reason: 'timeout', detail: `the story did not finish rendering and playing within ${timeout} ms` };
            if (outcome.error) return { ok: false, reason: 'error', detail: messageOf(outcome.error) };

            // Settled = play function done (above) + fonts loaded + two frames painted.
            try {
                if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
            } catch {
                // no font loading API: nothing to wait for
            }
            await frame();
            await frame();
            return {
                ok: true,
                portal: hasPortal(),
                empty: host.childElementCount === 0 && !(host.textContent || '').trim(),
            };
        },
        /** Unmount the last story and put the page back to a clean state. */
        async reset() {
            let detail = null;
            try {
                // story.run starts by unmounting the story before it and running that story's cleanups.
                if (blank) {
                    const scratch = document.createElement('div');
                    scratch.setAttribute('data-scry-host', '1');
                    root.appendChild(scratch);
                    await blank.run({ canvasElement: scratch });
                }
            } catch (error) {
                detail = messageOf(error);
            }
            for (const el of Array.from(document.querySelectorAll('[data-scry-host],[data-scry-shot]'))) {
                if (el.hasAttribute('data-scry-host')) el.remove();
                else el.removeAttribute('data-scry-shot');
            }
            clearLayout();
            try {
                window.localStorage.clear();
                window.sessionStorage.clear();
            } catch {
                // storage can be unavailable (sandboxed page): nothing to clear
            }
            if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') document.activeElement.blur();
            window.scrollTo(0, 0);
            return { ok: !detail, detail };
        },
    };
    window.__scryCapture = harness;
    return harness;
}
