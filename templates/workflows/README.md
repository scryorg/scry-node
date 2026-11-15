# Workflow templates

Copies of the GitHub Actions workflows that `scry-deployer init` and
`scry-deployer update-workflows` write, generated from `lib/templates.js` for an
npm project whose Storybook build script is `build-storybook`. They are
reference copies, not active workflows, and are not shipped in the npm package.

`deploy-storybook.yml` and `deploy-pr-preview.yml` are what the two commands
write by default. `scry-capture-web.yml` is written only with `--capture web`;
see "With `--capture web`" below.

Do not edit them by hand. Change `lib/templates.js`, then run:

```bash
node scripts/regenerate-workflow-templates.js
```

`test/templates.test.js` fails when these files differ from the generator.

## What the workflows do

- Install `@scrymore/scry-deployer@^0.12.1` into `$RUNNER_TEMP/scry`, outside the
  checkout, so the repo's own pin or lockfile cannot choose an older deployer
  and a pnpm or yarn `node_modules` is left alone.
- Install the Playwright browser with **that deployer's own Playwright**
  (`npx --no-install playwright install --with-deps chromium-headless-shell` in
  `$RUNNER_TEMP/scry`), cached by its Playwright version, so the browser build
  is the one the analyzer launches.
- Run that deployer with `--with-analysis`. It exits 1 when the build was asked
  to index and nothing will be indexed.
- Bound the job with `timeout-minutes: 20` and grant `actions: read` (plus
  `contents: read`) so the deployer can record the whole job's CI time from the
  Actions API; see the main README, "CI time".
- `deploy-pr-preview.yml` skips draft PRs, deploys when a PR is marked ready,
  and cancels a superseded run for the same PR (`concurrency`
  `storybook-pr-<number>`).

## With `--capture web`

For a project on Storybook 10 with a Vite framework, the React renderer and
Playwright installed. The commands check this first and write nothing when the
project does not qualify.

- `scry-capture-web.yml` is added. On a push to `main` or `master` it runs
  `scry-deployer capture web` (no Storybook build) and then
  `scry-deployer upload`. It runs on `ubuntu-24.04`, installs
  `@scrymore/scry-deployer@^0.14.0` from npm into `$RUNNER_TEMP/scry`, installs
  Chromium with the **project's own Playwright**, and stops after
  `timeout-minutes: 30`. A manual run on the default branch uploads; on
  another branch it only validates the bundle (`upload --dry-run`).
- The project is installed with its own package manager and lockfile. The copy
  in this folder is the npm variant. For pnpm the version comes from
  `packageManager` in `package.json`, else pnpm 10 (pnpm 8 for a lockfile
  older than version 9); the two deploy workflows keep their pnpm 8 step.
- The Storybook project must be at the repository root. The commands stop and
  write nothing when run from a subfolder.
- `deploy-storybook.yml` is written with `--no-analysis` in place of
  `--with-analysis`: it still hosts Storybook and reports coverage, and no
  longer takes the screenshots a second time. The copy in this folder is the
  default one, with `--with-analysis`.
- `deploy-pr-preview.yml` is unchanged.
- `--max-dropped` comes from the variable `SCRY_MAX_DROPPED` (default 0): one
  story that cannot be captured fails the run, and nothing is uploaded.

More in `docs/capture-web.md`, "Set it up in CI".

## Repository settings they read

- `SCRY_API_KEY` (secret), `SCRY_API_URL`, `SCRY_PROJECT_ID` (variables)
- Optional variables: `SCRY_COVERAGE_ENABLED`, `SCRY_COVERAGE_FAIL_ON_THRESHOLD`,
  `SCRY_COVERAGE_EXECUTE`, `SCRY_COVERAGE_BASE`, `SCRY_VIEW_URL`,
  `SCRY_MAX_DROPPED` (stories allowed to fail capture before the deploy ends red; default 0),
  `SCRY_CONCURRENCY`, `SCRY_RENDER_TIMEOUT_MS` (scry-sbcov 0.7+),
  `SCRY_EXECUTE_BUDGET_BASE_S`, `SCRY_EXECUTE_BUDGET_PER_STORY_S` (story execution budget; over it = a warning)

To refresh a project's workflows to the current templates:

```bash
npx -y @scrymore/scry-deployer@^0.12.1 update-workflows
```

With the build-free capture (0.14.0 or newer):

```bash
npx -y @scrymore/scry-deployer@^0.14.0 update-workflows --capture web
```
