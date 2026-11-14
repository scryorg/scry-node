# `scry-deployer capture web`

Captures the stories of a Storybook project into a Scry Capture Format (SCF 1.0) bundle
without building Storybook. It starts the project's own Vite dev server, renders each story
with Storybook's portable-stories API in headless Chromium, and writes one image and one
structure tree per story.

```bash
npx scry-deployer capture web            # writes .scry/capture and .scry/capture-report.json
npx scry-deployer upload .scry/capture   # validate and upload the bundle
```

## What the project needs

- Storybook 9 or newer on a Vite framework with the React renderer (`@storybook/react-vite`,
  `@storybook/nextjs-vite`). Other renderers stop with a clear message.
- `storybook`, `vite` and `playwright` installed in the project. They are resolved from the
  project and are not dependencies of `scry-deployer`. Chromium must be installed
  (`npx playwright install chromium`).
- Node 20.19 or newer (what Storybook itself needs).

Nothing is written into the project except the bundle, the report and a dependency cache
under `node_modules/.cache/scry-capture-web` (set `SCRY_CAPTURE_CACHE_DIR` to move it). The
capture makes no network calls.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config-dir <dir>` | `.storybook` | Storybook config directory |
| `--project-dir <dir>` | current directory | Project root |
| `--out <dir>` | `.scry/capture` | Bundle directory |
| `--workers <n>` | CPU cores this process may use, at most 4 | Browser pages capturing at once |
| `--max-dropped <n>` | `0` | Exit 1 when more than this many stories fail to capture |
| `--retries <n>` | `1` | Extra tries, each on a fresh page, for a story that fails |
| `--story-timeout <ms>` | `15000` | Per-story budget to render and finish its play function |
| `--scale <n>` | `1` | Device scale factor of the images |
| `--viewport <WxH>` | `1280x720` | Browser viewport |
| `--fixed-time <iso\|off>` | `2025-01-01T12:00:00Z` | Instant the page clock is pinned to |
| `--stories <ids>` | all | Comma-separated story ids |
| `--changed-since <ref>` | | Capture only stories affected by changes since a git ref |
| `--list` | | Print story ids, one per line, and capture nothing |
| `--list-ids` | | With `--changed-since`: print affected story ids instead of story files |
| `--report <file>` | `capture-report.json` next to the bundle | Run report |

The worker default honours CPU limits: an affinity mask (`taskset`) and a container CPU quota
both lower it.

## What a run does to each story

- The story is rendered into a fresh element; its loaders, decorators and play function run.
- It counts as settled when the play function is done, fonts are loaded and two frames have
  been painted. Animations and transitions are switched off.
- Between stories the previous story is unmounted and local storage, session storage,
  cookies, scroll position, focus and viewport are reset.
- The clock is pinned (`--fixed-time`), the time zone is UTC and the locale is `en-US`, so a
  story that prints a date gives the same image every run.
- The image is cropped to the story's root element. A story that opens a dialog or popover
  outside its root is captured as the whole viewport.
- A story that fails is tried again on a fresh page. If it still fails it is listed in
  `counts.skipped` with the reason (`error`, `timeout`); it is never dropped silently.
- A capture that is one flat colour is kept and flagged (`x-scry.captureWarnings:
  ["blank_suspect"]`, and `blankSuspect` in the report).
- Console errors are collected in the report. They never fail a story.

## Per-story settings

```js
export const Mobile = {
  parameters: {
    scry: {
      capture: {
        skip: false,                            // true: leave this story out (counted as "filtered")
        viewport: { width: 375, height: 667 },  // overrides --viewport for this story
        delay: 200,                             // extra wait in ms before the screenshot
        fullPage: false,                        // true: capture the whole scrollable page
      },
      fields: { team: 'core' },                 // custom metadata, written as x-scry-fields
    },
  },
};
```

A story that picks a Storybook viewport (`globals.viewport` or `parameters.viewport`) is
captured at that size. The `theme` global, when a story or the preview sets one, is written
to `variant.theme`.

## Output

```
.scry/capture/
  scf.json                 # SCF 1.0 manifest: source storybook:web, counts, captures
  images/<story id>.png
  structure/<story id>.json
.scry/capture-report.json  # outside the bundle
```

`scf.json` carries `counts.declared`, `counts.captured` and `counts.skipped[] {id, reason}`.
Every capture has `capture.viewport`, `capture.scale`, `capture.size`, `variant {theme,
viewport}`, the story's file, line, component and component file, its tags and custom fields.
Story ids are the ids Storybook generates.

The report repeats the counts and adds: `retried`, `blankSuspect`, `partial`, `declaredTotal`,
`workers`, `cores` (what was detected and how), `fixedTime`, `consoleErrors` and `timingsMs`
per phase (`loadConfig`, `index`, `viteStart`, `browserLaunch`, `warmup`, `capture`, `write`,
`total`).

Exit code: 0 when the bundle is valid and no more than `--max-dropped` stories failed.
Stories left out with `parameters.scry.capture.skip` do not count as failed.

## Changed stories only

```bash
npx scry-deployer capture web --changed-since origin/main --list       # affected story files
npx scry-deployer capture web --changed-since origin/main --list-ids   # affected story ids
npx scry-deployer capture web --changed-since origin/main              # capture them
```

A story file is affected when it, or a file it imports (followed through the project's
import graph and Vite aliases), changed since the ref: committed, staged, unstaged or
untracked. A change to the Storybook config directory, to a file the preview imports, or to
`package.json`, a lock file, or a Vite, TypeScript, Tailwind or PostCSS config affects every
story. `A..B` compares two commits and ignores the working tree.

A changed-only run writes images, structure trees and the report (`"partial": true`) but no
`scf.json`: it is a preview of what changed, not a bundle to upload. Uploading a bundle that
holds only some stories would make the rest look deleted.

`--stories` also marks the report `"partial": true`. It still writes a bundle; only upload it
if a bundle with just those stories is what you want.

## Limits

- React only. Vue, Svelte, Angular and web-components Storybooks are refused.
- Vite frameworks only. A webpack-based Storybook must be built and deployed the usual way.
- The affected-story graph follows JavaScript and TypeScript imports. It records an imported
  CSS file but does not follow that file's own `@import` chain.
- With a pinned clock, a story that waits by polling `Date.now()` never finishes; give it
  `--fixed-time off` or a timer-based wait.
- Docs pages (MDX, autodocs) are not captured.
