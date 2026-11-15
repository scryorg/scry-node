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
- `storybook` and `vite` installed in the project. They are resolved from the project and are
  not dependencies of `scry-deployer`.
- Playwright, with its Chromium installed (`npx playwright install chromium`). The project's
  own is used when it has one (`playwright`, `@playwright/test` or `playwright-core`).
  Otherwise the run falls back to the copy that comes with `scry-deployer`'s dependencies.
  The generated CI workflow does not use that fallback: it needs `playwright` or
  `@playwright/test` in the project (see "Set it up in CI").
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

## Set it up in CI

`init` and `update-workflows` write a GitHub Actions workflow for it. Both need
`@scrymore/scry-deployer` 0.14.0 or newer.

```bash
npx -y @scrymore/scry-deployer@^0.14.0 init --project-id YOUR_PROJECT_ID --api-key YOUR_API_KEY --capture web   # new project
npx -y @scrymore/scry-deployer@^0.14.0 update-workflows --capture web                                             # existing project
```

Keep the `@^0.14.0`. An older deployer (for example one npx has cached) does not know
`--capture`: it ignores the option without an error and writes the two default workflows only.

Add `--config-dir <dir>` when the Storybook config is not in `.storybook`.

Limit in this version: the Storybook project must be at the repository root, and the command
must be run there. From a subfolder of the repository (a monorepo package) it stops, says so
and writes nothing. For such a project, copy the workflow from
`templates/workflows/scry-capture-web.yml` by hand and add `working-directory`.

The command first checks the project: Storybook 10, a Vite framework, the React renderer, Vite,
and Playwright installed in the project. If a check fails it prints which one, writes nothing
and exits 1. In `init` the check runs before the credentials are looked at.

The check loads the project's Storybook and Vite config, as Storybook itself does; run it only
in a repository you trust. It runs in a child process. These are removed from that process's
environment: `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
`NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm's auth settings (`npm_config_*auth*`), and every `SCRY_*`
or `STORYBOOK_DEPLOYER_*` variable whose name contains KEY, TOKEN, SECRET or PASSWORD.
Everything else is passed through.

What it writes:

| File | What changes |
| --- | --- |
| `.github/workflows/scry-capture-web.yml` | New. Captures every story and uploads the bundle on a push to `main` or `master`. |
| `.github/workflows/deploy-storybook.yml` | `--with-analysis` becomes `--no-analysis`. It still builds and hosts Storybook and reports coverage. It no longer takes the screenshots. Coverage with `--coverage-execute` still renders the stories to run them. |
| `.github/workflows/deploy-pr-preview.yml` | Nothing. Pull requests keep the preview, the comment and their screenshots. |

Why two workflows stay: an uploaded bundle carries screenshots and structure for search. It has
no browsable Storybook and no coverage report. The deploy workflow keeps those. Each push
therefore creates two builds in Scry: the hosted one, which is not indexed, and the bundle,
which is.

What the capture workflow does:

- Runs on `ubuntu-24.04`, not `ubuntu-latest`. The floating label moves to a new Ubuntu before
  older Playwright versions have a Chromium build for it, and the browser install then fails.
- Runs on a push to `main` or `master`, like the deploy workflows. If the default branch has
  another name, change `branches` in the file; until then no push starts it.
- Uses Node 20 (the newest 20.x, which is 20.19 or newer).
- Installs the project with its own package manager and lockfile: `npm install`,
  `pnpm install`, `yarn install` or `bun install`.
  - pnpm: the version in `packageManager` in `package.json` when there is one. Otherwise
    pnpm 10 for a version 9 lockfile and pnpm 8 for an older one. (The deploy workflows still
    set up pnpm 8.)
  - yarn: the runner's Yarn 1, or the Yarn 2+ named in `packageManager`, through Corepack.
  - bun: `oven-sh/setup-bun`. A project with only `bun.lock` (Bun 1.2 or newer) is treated as
    a bun project here; the deploy workflows detect `bun.lockb` only.
- Installs the deployer from npm into `$RUNNER_TEMP/scry`, outside the checkout, with a floor
  of `^0.14.0`.
- Installs Chromium with the project's own Playwright (`playwright install --with-deps chromium`).
- Runs `capture web`, keeps `capture-report.json` as a workflow artifact for 7 days, then runs
  `upload`. The API key is only given to the upload step.
- Stops after 30 minutes. On a 2-core GitHub runner a Storybook of 1,734 stories took about
  10 minutes to capture and about 1.5 minutes to upload.
- Can be started by hand (`workflow_dispatch`). A manual run on the default branch uploads,
  like a push. A manual run on any other branch is a dry run: it validates the bundle with
  `upload --dry-run` and sends nothing.

It reads the same repository settings as the deploy workflows: the secret `SCRY_API_KEY` and
the variables `SCRY_API_URL` and `SCRY_PROJECT_ID`. One optional variable:

- `SCRY_MAX_DROPPED`: stories allowed to fail capture before the run ends red. Default `0`.
  A failed story is retried once before it counts. With `0`, one story that cannot be captured
  fails the run and nothing is uploaded, so search keeps the last complete capture. Raise it
  only for stories you know are flaky, and fix or skip those stories when you can: a story
  missing from an uploaded bundle is missing from search for that build.

To go back to the Storybook-build path: run `update-workflows` without `--capture web`, then
delete `.github/workflows/scry-capture-web.yml`. If the file is left in place, the command
warns that every push will be captured twice.

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
