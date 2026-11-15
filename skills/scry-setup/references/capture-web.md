# Build-free capture (capture web)

Use when a web Storybook should feed Scry search without a Storybook build per
push, either in a new setup or to move an existing Scry project over.
`scry-deployer capture web` renders each story with the project's own Storybook,
Vite and Playwright and writes a capture bundle; `scry-deployer upload` sends it.

The command is in `@scrymore/scry-deployer` **0.14.0 and later**. This reference
was written from the deployer source before 0.14.0 was published. Check what the
user can actually install before using it (see "Check the deployer has it").

## Does the project qualify

All of these must hold. Read them from the project; do not guess.

- Storybook **10** (`storybook` in the lockfile or `node_modules`). 9 and
  earlier are refused.
- A **Vite** framework: `framework` in `.storybook/main.*` is, for example,
  `@storybook/react-vite` or `@storybook/nextjs-vite`. Webpack frameworks
  (`@storybook/react-webpack5`, `@storybook/nextjs`) are refused.
- The **React** renderer. Vue, Svelte, Angular and web components are refused.
- `vite` and `playwright` (or `@playwright/test`) installed in the project.
  If Playwright is missing, adding it as a development dependency is a change
  to the user's project: say so and add it with their package manager.
- Node **20.19** or newer, locally and in CI.
- For the generated workflow: the Storybook project is at the repository root.
  A project in a subfolder needs the workflow edited by hand
  (`working-directory`); say that instead of promising the generated file works.

The deployer runs the same checks. `init --capture web` and
`update-workflows --capture web` stop with the reason and write nothing when
one fails, so their output is the authority when your reading and the tool
disagree.

If the project does not qualify, use the Storybook-build path in
[project.md](project.md) and tell the user which requirement was not met.

## Check the deployer has it

```bash
npx --yes @scrymore/scry-deployer@latest capture web --help
npm view @scrymore/scry-deployer version
```

The command exists when the help lists `web` as an adapter and the version is
0.14.0 or later. If it is not there yet: tell the user build-free capture
arrives in 0.14.0, leave the project on its current path, and stop. Do not
install the deployer from a git URL or commit for a user, and do not write a
workflow that does.

## What it gives and what it does not

An uploaded bundle makes the stories searchable (screenshots and structure).
It has no browsable hosted Storybook, no coverage report and no pull-request
comment. That is why the generated setup keeps the deploy workflows:

| File | With `--capture web` |
| --- | --- |
| `.github/workflows/scry-capture-web.yml` | New. Captures and uploads on a push to the default branch. |
| `.github/workflows/deploy-storybook.yml` | `--no-analysis` replaces `--with-analysis`: still hosts Storybook and reports coverage, no longer captures. |
| `.github/workflows/deploy-pr-preview.yml` | Unchanged. Pull requests keep preview, comment and screenshots. |

Each push then creates two builds in Scry: the hosted one (not indexed) and the
bundle (indexed). Tell the user; it is expected.

## New setup

When the project qualifies and the deployer has the command, offer build-free
capture and say why (no Storybook build for search; the deploy workflow still
hosts and reports coverage). Otherwise use [project.md](project.md).

`init` accepts the option, with the same side effects described in `SKILL.md`
(it commits and pushes):

```bash
npx --yes @scrymore/scry-deployer@^0.14.0 init \
  --project-id YOUR_PROJECT_ID --api-key "$SCRY_API_KEY" --capture web
```

To prepare files without committing, set up the project as in `project.md`,
then run `update-workflows --capture web` (below), which only writes the three
workflow files.

## Upgrade an existing Scry project

1. **Detect the current path.** The project is on the Storybook-build path when
   `.github/workflows/deploy-storybook.yml` (or its own deploy workflow) runs
   the deployer with `--with-analysis` and there is no
   `scry-capture-web.yml`. Note any hand edits to the generated workflows:
   `update-workflows` overwrites `deploy-storybook.yml` and
   `deploy-pr-preview.yml`.
2. **Check it qualifies** (above) and **check the deployer has the command**
   (above). Stop here, with the reason, if either fails.
3. **Record the old story count.** Build Storybook and count the entries of
   type `story` in `storybook-static/index.json`, or read the story count from
   the latest green deploy run's log.
4. **Prove it locally before changing CI.**

   ```bash
   npx playwright install chromium        # the project's Playwright
   npx --yes @scrymore/scry-deployer@^0.14.0 capture web --list
   npx --yes @scrymore/scry-deployer@^0.14.0 capture web
   npx --yes @scrymore/scry-deployer@^0.14.0 upload .scry/capture --dry-run
   ```

   `--list` prints the story ids and captures nothing. The capture prints
   `N of M stories captured` and writes `.scry/capture-report.json` (captured,
   skipped with reasons, blank suspects). `upload --dry-run` validates the
   bundle and sends nothing. Add `.scry/` to `.gitignore` if it is not ignored.
5. **Compare the counts.** `M` should equal the old count. Docs pages are not
   stories and are not captured by either path. Explain every difference from
   the report before going on; do not switch CI over a gap you cannot explain.
6. **Write the workflows.**

   ```bash
   npx --yes @scrymore/scry-deployer@^0.14.0 update-workflows --capture web
   ```

   Add `--config-dir <dir>` when the config is not in `.storybook`. Review the
   diff, re-apply any hand edits from step 1, and commit only within the
   user's authorized scope. The repository variables and secret are the ones
   already set (`SCRY_PROJECT_ID`, `SCRY_API_URL`, `SCRY_API_KEY`).
7. **Verify in CI.** After the push, the "Scry Capture (web)" run should end
   green with the same count, and "Deploy Storybook" should still host and
   report coverage. Then check search as in [mcp.md](mcp.md).
8. **Tell the user what changed and how to go back.** What changed: the table
   above. To go back: run `update-workflows` without `--capture web` and
   delete `.github/workflows/scry-capture-web.yml`. If the file is left, the
   command warns that every push is captured twice.

## Troubleshooting

- **Chromium install fails with "does not support chromium on ubuntu…".** The
  job is on a newer Ubuntu than the project's Playwright supports. The
  generated workflow pins `ubuntu-24.04` for this reason; keep it, or upgrade
  Playwright in the project.
- **"Could not start Chromium" or a missing executable.** Chromium must be
  installed by the project's Playwright, from the project directory
  (`npx playwright install chromium`; in CI with `--with-deps`). A browser
  installed by another Playwright version is not found.
- **Errors while loading the Storybook config, or syntax errors in Vite or
  Storybook.** Check `node --version`. Storybook 10 needs Node 20.19 or newer;
  20.9 to 20.18 are not enough.
- **The run ends red with "more than --max-dropped".** One or more stories
  failed to capture after a retry. The report lists them with reasons. Fix the
  story, or exclude it with `parameters.scry.capture.skip`. The repository
  variable `SCRY_MAX_DROPPED` raises the allowance (default 0); a story dropped
  under the allowance is missing from search for that build, so use it for
  known flaky stories only.
- **Screenshots differ between runs because of dates or relative times.** The
  clock starts at a fixed time for every story (`--fixed-time`, an ISO time).
  If the story data holds later dates, pass a later `--fixed-time`.
- **Stories that fetch from the network.** Requests are not blocked or
  stubbed: a story that calls a real API does so in CI too, and fails or
  varies when the API is unreachable. Mock the data in the story (for example
  with MSW) rather than raising `--max-dropped`.
- **The job times out.** The workflow stops at 30 minutes. Measured: 1,734
  stories took about 10 minutes on a 2-core GitHub runner. Raise
  `timeout-minutes` for a much larger Storybook.

Full flag list and limits: the deployer's
[capture-web.md](https://github.com/epinnock/scry-node/blob/main/docs/capture-web.md).
