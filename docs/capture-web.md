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

- Storybook 10 on a Vite framework with the React renderer (`@storybook/react-vite`,
  `@storybook/nextjs-vite`). Other Storybook versions and other renderers stop
  with a clear message.
- `storybook`, `vite` and `playwright` installed in the project. They are resolved from the
  project and are not dependencies of `scry-deployer`. Chromium must be installed
  (`npx playwright install chromium`).
- Node 20.19 or newer (what Storybook itself needs).

Nothing is written into the project except the bundle, the report and a dependency cache
under `node_modules/.cache/scry-capture-web` (set `SCRY_CAPTURE_CACHE_DIR` to move it). The
capture tool itself makes no network calls. A story that fetches from the network does so as
it would in Storybook: requests made by stories are not blocked or stubbed.

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
| `--fixed-time <iso\|off>` | `2026-11-14T12:00:00Z` | Instant the page clock starts at for each story; `off` for the real clock |
| `--stories <ids>` | all | Comma-separated story ids |
| `--changed-since <ref>` | | Capture only stories affected by changes since a git ref |
| `--list` | | Print story ids, one per line, and capture nothing |
| `--list-ids` | | With `--changed-since`: print affected story ids instead of story files |
| `--report <file>` | `capture-report.json` next to the bundle | Run report |

`--out` must be a directory this tool may clear: one that does not exist yet, an empty one,
one that holds the marker file `.scry-capture` (an unfinished or partial run), or a finished
bundle whose `scf.json` was written by `capture web`. Anything else stops the run before a
file is touched. Inside an accepted directory only `images/*.png`, `structure/*.json`,
`scf.json` and the marker are ever removed. The marker is removed when `scf.json` is written,
because a bundle may hold nothing but its manifest and the files it references.

The worker default honours CPU limits: an affinity mask (`taskset`) and a container CPU quota
both lower it.

## What a run does to each story

- The story is rendered into a fresh element; its loaders, decorators and play function run.
- It counts as settled when the play function is done, fonts are loaded and two frames have
  been painted. Animations and transitions are switched off.
- Between stories the previous story is unmounted and local storage, session storage,
  IndexedDB, Cache Storage, cookies, scroll position, focus, viewport, the document title and
  the page address (hash and history entries a story pushed) are reset. Style and script tags
  a story adds to `<head>` are not removed; a page is replaced after 150 stories.
- The page clock reads `--fixed-time` while story files load, and runs at real speed from
  `--fixed-time` once each story starts: `new Date()`, `Date.now()` and `Intl.DateTimeFormat`
  without a date read it. The time zone is UTC and the locale is `en-US`, so a story that
  prints a date gives the same image every run, and a play function that waits for time to
  pass (an elapsed timer) still finishes. Timers, `requestAnimationFrame` and
  `performance.now` are the browser's own.
- The image is cropped to the story's root element. A story that opens a dialog or popover
  outside its root is captured as the whole viewport.
- Before the first story every story file is imported once (warm-up). A story file that
  cannot be imported, or whose import hangs, gives each of its stories a skip with the reason;
  the rest of the run goes on.
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
        delay: 200,                             // wait in ms before the screenshot (counts toward --story-timeout)
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

If the browser dies it is started again, up to five times. Past that the run stops early:
the stories not reached are recorded as skipped, the report (with `aborted`) and the bundle
are still written, and the exit code is 1. Ctrl-C or SIGTERM closes the browser and the dev
server and exits 130 or 143; the output directory keeps its marker and has no `scf.json`.

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

## Runs over only some stories

A run with `--changed-since` or `--stories` writes images, structure trees and the report
(`"partial": true`) but no `scf.json`: it is a preview of those stories, not a bundle to
upload. Uploading a bundle that holds only some stories would make the rest look deleted.
`scry-deployer upload` refuses a bundle whose `scf.json` is marked `"x-scry-partial": true`.

## Limits

- React only. Vue, Svelte, Angular and web-components Storybooks are refused.
- Vite frameworks only. A webpack-based Storybook must be built and deployed the usual way.
- The affected-story graph follows JavaScript and TypeScript imports. It records an imported
  CSS file but does not follow that file's own `@import` chain.
- The clock runs while a story renders and plays, so a story that prints the time to the
  second (or finer) can differ between runs if its play function takes over a second.
- A story whose data holds dates later than `--fixed-time` sees them in the future; pass a
  later `--fixed-time` for such a project.
- Web workers and `Temporal` read the real clock. Inside an iframe the clock stays at
  `--fixed-time` for the whole story (it only starts running in the story's own page).
- Docs pages (MDX, autodocs) are not captured.
- Storybook 10 only. Storybook 9 has not been tested and is refused.
