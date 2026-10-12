# Changelog

## 0.13.0

### Minor Changes

- 64b1522: Manifest-first picture upload. When scry-sbcov writes `delta-manifest.json` and `delta-files/` beside the metadata ZIP (`--delta-manifest`), the deployer asks the upload service which pictures it does not hold (`POST /delta/{project}/manifest`, with an `Idempotency-Key` and `transfers: ["r2-presigned","basic"]`), sends only those (8 at a time, up to 3 retries each, the Scry key only to the API's own origin), and commits. It prints `pictures: sent N of M (X MB), already held K`. The metadata ZIP path is used, with a one-line reason, when there is no manifest, the service answers 503 `delta_disabled` or 404, the network fails before the commit, or `SCRY_DELTA=0`. A commit that says pictures are missing, or a 403, ends the deploy red with the request id; it is never reported green. The storybook.zip upload is unchanged.

## 0.12.4

### Patch Changes

- 012e8ff: The CLI no longer reports your own mistakes as crashes. A missing or wrong `--dir`, a folder with no `.png`/`.jpg`/`.jpeg` images, and a missing API key or env var for `upload-images --local` print the same message and exit 1 as before, but are no longer sent to error reporting. Real crashes are still reported, and error reporting is now also off when `NODE_ENV=test` or `CI` is set to a true value, in addition to `SCRY_TELEMETRY=0` and `DO_NOT_TRACK=1`. You do not need to do anything.

## 0.12.3

### Patch Changes

- d039a7b: The Creative Cloud item link survives the converter: `cleanAdobeLink` now lets a `:` through in exactly one place, the `urn:aaid:sc:<REGION>:<uuid>` library segment of `https://www.adobe.com/files/libraries/<urn>[/<item uuid>]`, so Scry Sync can send a link that opens the picture itself. Every other colon, and every other rule (https only, no credentials, query and fragment stripped), is unchanged.

## 0.12.2

### Patch Changes

- 18fbaff: Generated workflows (`init`, `update-workflows`) now install `@scrymore/scry-deployer@^0.12.1` instead of `^0.9.0`. On 0.x a caret range on 0.9.0 stops below 0.10, so customer CI never got the deployer that carries Storybook tags (scry-sbcov ^0.8.0). Native capture workflow samples pin 0.12.1.

## 0.12.1

### Patch Changes

- ec9d03f: **Storybook tags now reach Scry.** The deployer installs `@scrymore/scry-sbcov` 0.8 (it was held at 0.7 by the `^0.7.0` range, which excludes 0.8 on 0.x semver). CI runs that use the deployer now capture `parameters.scry.tags` and `x-scry-fields` in the metadata ZIP. No flags or settings changed.

## 0.12.0

### Minor Changes

- e03e6f8: **Metadata ZIPs over 100 MiB now upload.** Before, a large library's metadata ZIP failed with `maxContentLength size of 104857600 exceeded` (the dashboard's reached 101.5 MiB), nothing was indexed, and the build stayed "pending" for ever. The ZIP now goes straight to storage on a presigned URL (presign, PUT, complete) instead of through the upload service, up to 2 GiB. If the PUT or the complete step fails, the build is marked failed with a reason on the upload service, the run prints that it did, and the command exits 1. Against an upload service that predates this change (no presign route) the old route is used for a ZIP of up to 100 MiB, with a warning in the log; a larger ZIP stops with `upload service too old for a ZIP this size`. No flags or settings changed.
- c10c395: Requires Node.js 20.9 or newer (was 18; Node 18 is past end of life) and updates `sharp` from 0.34.5 to 0.35.5, which closes two libvips advisories (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c) in the image conversion used by `scry import` and the scry-sync converter. Node 18 users stay on 0.11.x. CI now tests Node 20 and 22.

## 0.11.1

### Patch Changes

- ed9d554: `scry import`: the README now states the real picture limits (native PNG/JPEG/WebP within 4096 px and 4 MiB, converted or re-encoded files at 2048 px and 4 MiB) instead of the SCF validator's 20 MB / 16384 px, and a test pins that the consent line names OpenAI (descriptions), Google Gemini and Jina (search data). No behaviour change.

## 0.11.0

### Minor Changes

- 3c2426f: Add `scry import <folder>` (beta) to upload a folder exported from Adobe Bridge as an SCF bundle (`x-adobe-bridge`), with local format conversion, an XMP allow-list and metadata stripping.

### Patch Changes

- 645b3dd: `scry import`: hold every converted picture to 2048 px and 4 MiB (PDF and AI pages are rendered at that size directly), re-encode PNG/JPEG files over 4096 px or 4 MiB, and check each output decodes before it is uploaded. A file that cannot be made valid is skipped with a named reason. Fixes PDF and AI files being converted to 16384 px and refused by the AI services.

## 0.10.0

### Minor Changes

- 4000a51: New `upload <dir|zip>` command for Scry Capture Format bundles (local validation with the vendored `@scrymore/scf`, every problem printed, exit 1 on reject; source text only with `--include-source`) and `capture rn` (React Native Storybook on an iOS Simulator or Android emulator → SCF bundle with crops, honest counts and rn-fiber trees). `scry analyze` now uploads an SCF bundle through the bundle route, so its builds are indexed.
- e82e98f: `upload-images --local` can embed with Gemini Embedding 2: pass `--gemini-api-key` (or `GEMINI_API_KEY`) and a g2 collection (`--collection` / `--milvus-collection`, or `MILVUS_COLLECTION_G2`). Rows are 1024-dim and carry `embed_model`. A Gemini run refuses to write to a non-g2 collection. `--jina-api-key` / `JINA_API_KEY` still work and print a deprecation warning.

### Patch Changes

- 55d4318: A failed API call now ends with `Ref: <id>` (the server's `x-scry-request-id`) and the deployer sends `x-scry-client: scry-deployer/<version>` on every API request. Failure output prints the HTTP status and the server's `error` field only, never the whole response body. Sentry `environment` no longer falls back to `production` when `NODE_ENV` is unset (it is `development`), and the request id is attached to the event as a tag.
- 5a3944e: `scry upload` validates against the current SCF validator: manifests with an off-schema `capture.method`, `capture.crop`, `kind`, `source.platform` or `structure.origin` are now rejected locally (ENUM_VALUE_INVALID), matching the published schema and the server.

## 0.9.1

### Patch Changes

- f94cae8: **Large metadata ZIPs no longer time out on slow runners, and a failed metadata upload no longer prints success lines.**

  What failed before: the metadata ZIP and the coverage report are sent through the Scry upload service with a fixed 60 s timeout and no retry. With scry-sbcov 0.6+ (2× root captures) a 470-story Storybook's metadata ZIP is 28 MB, which a self-hosted runner uploading at 0.4-0.85 MB/s cannot send in 60 s: the deploy ended `NOTHING WILL BE INDEXED`, and the log still printed `✅ Archive uploaded.` and `✅ Upload complete.` around the failure.

  What you see now:

  - Both uploads get a timeout scaled to their size: max(60 s, size ÷ 100 KB/s), at most 15 minutes (28 MB → about 4.7 min). They are retried up to 3 attempts, with backoff, on a timeout, a 5xx/429 or a network error, and never on another 4xx. Each attempt logs its size and how long it took: `Metadata ZIP: sent 28.0 MB in 71.3 s (attempt 1/3).`
  - When the metadata upload still fails, no success line follows it. The deploy ends red with `NOTHING WILL BE INDEXED` and names the build, which is left pending (the upload service cannot mark it failed yet). Re-run the job to index it.
  - `SCRY_UPLOAD_TIMEOUT_FLOOR_MS` changes the 60 s floor.

  What you must do: nothing.

## 0.9.0

### Minor Changes

- fa895fa: **Every deploy now says how much CI time Scry took, warns when story execution is over budget, and records the time with the build** (ISSUES.md #54).

  What went wrong before: a 461-story Storybook preview spent 19-21 minutes rendering stories one at a time (40 dialogs waited 15 s each), used 61% of an account's GitHub Actions minutes in a month, and nothing in the run said so. No line gave the execution time, no workflow set `timeout-minutes`, and the build recorded no time at all.

  What you see now:

  - A duration line after the capture: `Story execution: 461 stories in 3.5 min (4 workers), budget 5.8 min.`
  - Over the budget (`120 s + 0.5 s × declared stories`; change it with `SCRY_EXECUTE_BUDGET_BASE_S` / `SCRY_EXECUTE_BUDGET_PER_STORY_S`), a `::warning::` annotation on the run naming the time, the budget and where it went. A warning only: the exit code does not change.
  - The build records its CI timings (analyze, execute, archive, upload and deployer total; story counts; time lost per reason; sbcov and deployer versions; runner kind; Actions run id and attempt; budget). Anything that could not be measured is left out, never sent as 0. The first part rides on the existing build request; the final record goes to a new upload-service route. An upload service without that route is told apart from an error: `the upload service does not record CI timings yet; not stored`, once, and the deploy result is unchanged.
  - Whole-job time, when the job may read Actions (`permissions: actions: read`) and `GITHUB_TOKEN` is passed: `CI time recorded: deployer 4.4 min, job 6.1 min so far (Actions API).` Otherwise `deployer time only (job start unknown: <reason>)`. This never fails a deploy.
  - `SCRY_CONCURRENCY` and `SCRY_RENDER_TIMEOUT_MS` (or `concurrency` / `renderTimeoutMs` in `.storybook-deployer.json`) are forwarded to scry-sbcov 0.7+ as `--concurrency` / `--render-timeout`; with an older scry-sbcov they are not sent and the log says so.
  - Generated workflows install `@scrymore/scry-deployer@^0.9.0`, set `timeout-minutes: 20` on the Storybook job and grant `actions: read`. The push workflow had no `permissions` block before; the one it has now lists `contents: read`, `actions: read` and `packages: read`, and every other scope (for example write access your own added steps relied on) is dropped: add what your steps need.
  - `timeout-minutes: 20` assumes scry-sbcov 0.7 (four stories at a time, 5 s render limit), which 0.9.0 installs. If you run an older scry-sbcov (`SCRY_SBCOV_CMD`, or your own pin) on a large Storybook, one run can take longer than 20 minutes and be stopped: raise the limit in your workflow.

  What you must do:

  1. Regenerate your workflows: `npx -y @scrymore/scry-deployer@^0.9.0 update-workflows` (the older `^0.7.0` and `^0.8.0` ranges do not pick up 0.9.0). If you keep a hand-written workflow, add `timeout-minutes: 20` to the Storybook job, `actions: read` to its `permissions` (a `permissions` block drops every scope it does not list, so keep `contents: read`), and `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the deploy step's `env`.
  2. Nothing else. Without step 1 the deployer still records its own time and says the job start is unknown.

## 0.8.0

### Minor Changes

- 8d12e73: Bump `@scrymore/scry-sbcov` to ^0.6.0: `--with-analysis` now captures each story at 2× and crops it to the component (`[data-scry-root]`, else `#storybook-root > :first-child`) by default, and each story's metadata.json `capture` block records `scale`, `root_found` and `sbcov_version`. Projects that set `captureMode` / `captureScale` themselves (sbcov config, `.storybook-deployer.json`, `SCRY_CAPTURE_*` or `--capture-*`) keep their values; set `captureMode: 'viewport', captureScale: 1` to keep the old whole-window 1× screenshots.

## 0.7.0

### Minor Changes

- abbe6f2: **A deploy that was asked to index but indexes nothing now exits 1** (ISSUES.md #50).

  What failed silently before: a rejected metadata upload, an upload that was not queued, an analysis archive with zero stories (it was queued, and the build showed `completed` with nothing in it), a non-zero exit from scry-sbcov, and a workflow that simply forgot `--with-analysis` all printed success and ended green, so nothing was searchable and nobody was told. A repository that pinned an old deployer and ran it with a bare `npx @scrymore/scry-deployer` could not see any of the earlier fixes either.

  What you see now:

  - `❌ … so NOTHING WILL BE INDEXED.` with the reason, and exit code 1. The Storybook is still uploaded and hosted, so preview links keep working; an empty archive is not uploaded and no build is queued.
  - Analysis is **on by default**. `--no-analysis` hosts without indexing and says `this build is hosted but NOT searchable` (exit 0). `--no-coverage` or `--coverage-report <file>` without `--with-analysis` also mean "no analysis" (they skip the capture) and print the same line; `withAnalysis: false` in `.storybook-deployer.json` or `SCRY_WITH_ANALYSIS=false` still opt out, so check your config if you copied the old example file (it no longer sets `withAnalysis`).
  - scry-sbcov's exit code is no longer swallowed. If it wrote an archive (exit 3: more stories dropped than `--max-dropped`), the captured stories are queued first and the run still ends red naming the reason; with no archive (exit 2: broken capture config) the run ends red with that cause. **Any story that fails to capture now ends the deploy red** (after the stories that did capture are uploaded and queued): the deployer passes `--max-dropped 0` to scry-sbcov (0.5.2+) and also checks the `sbcov-manifest.json` in the archive. Allow some with `--max-dropped <n>` / `SCRY_MAX_DROPPED` / `maxDropped` in `.storybook-deployer.json`. scry-sbcov exit codes: 0 ok, 2 broken capture config (no archive), 3 more stories dropped than `--max-dropped` (archive of the rest written). With a scry-sbcov older than 0.5.2 the flag is not passed and the log says dropped stories cannot be counted.
  - One warning line when the running deployer is older than npm `latest` (2 s limit, never fails the deploy; `SCRY_NO_UPDATE_CHECK=1` turns it off).
  - New `update-workflows` command.

  What you must do:

  1. Regenerate your workflows: `npx -y @scrymore/scry-deployer@^0.7.0 update-workflows` (or copy the steps in the README's "Example CI/CD Integration"). The new workflow installs `@scrymore/scry-deployer@^0.7.0` into its own folder, installs the Playwright browser with that deployer's own Playwright, and runs that deployer, so your repository's pin can no longer pick an old one. The PR workflow now skips drafts and cancels superseded runs.
  2. If a workflow had no browser step it will now go red instead of silently indexing nothing: add the browser step (step 1 does it).
  3. If you deploy a Storybook you do not want searchable, add `--no-analysis`.
  4. If some of your stories are known not to capture and you accept that, set `--max-dropped <n>` (or the `SCRY_MAX_DROPPED` repository variable); otherwise the first dropped story turns the run red.

- 7ed395b: Forward screenshot capture settings to scry-sbcov: `captureMode`, `captureScale` and `captureViewport` from `.storybook-deployer.json`, `SCRY_CAPTURE_MODE` / `SCRY_CAPTURE_SCALE` / `SCRY_CAPTURE_VIEWPORT`, or `--capture-mode` / `--capture-scale` / `--capture-viewport` (deploy and `coverage` commands). Values are validated (enum, number in (0, 4], `WxH`) and only settings you set are passed, so sbcov's own defaults and config file still apply otherwise.

## 0.6.1

### Patch Changes

- 37b7afe: Stop the API key reaching error reports: the verbose "Received arguments" log line masks credential fields, every Sentry breadcrumb is scrubbed like the event itself, and events carry the deployer version as `release`.

## 0.6.0

### Minor Changes

- 2e8a234: Uploads now carry the build's commit sha and branch, alongside the per-story ids scry-sbcov writes into metadata.json, so hosted search can report freshness — which commit a component came from and whether it is from the current build. The commit and branch are resolved from `SCRY_COMMIT_SHA`/`SCRY_BRANCH`, then the GitHub Actions environment, then the working copy, and either is omitted rather than defaulted when it cannot be determined, so an unknown commit reads as unknown instead of as one that cannot be looked up. Requires `@scrymore/scry-sbcov` 0.5.0, which is what emits the per-story fields.

## 0.5.2

### Patch Changes

- 708486c: Bump `@scrymore/scry-sbcov` to ^0.4.0: screenshot framing options (`captureMode: root`, `captureViewport`, `captureScale`) read from the project's `scry-sbcov.config.js`, so component stories are captured at the size of the Figma component they are compared against and phone-sized screens are no longer clipped at 720 px. No deployer flags change.

## 0.5.1

### Patch Changes

- 9fb43a2: A failed coverage upload no longer prevents your components being indexed.

  The coverage retry was unguarded, so when the second attempt also failed it threw
  out of `uploadBuild` and the metadata upload after it never ran. Coverage is a
  report; the metadata archive is what makes components searchable — so a failure in
  the optional artifact silently took down the essential one.

  Seen on a real 467-story design system: every story captured, the archive built,
  and nothing indexed — twice in a row.

  The retry is now guarded and prints a warning that says plainly which part failed
  and that indexing is unaffected.

## 0.5.0

### Minor Changes

- 7819a50: A deploy that was asked for `--with-analysis` now fails when analysis produces
  nothing.

  Previously it printed `✅ Upload successful!` and exited 0. No metadata archive
  meant nothing was queued, so no component ever became searchable — and because
  the indexing notice only prints when metadata _was_ sent, there was no output at
  all to distinguish it from a healthy run. CI stayed green. The first sign of
  trouble was search returning nothing, days later.

  **This is a behaviour change:** the command now exits non-zero in that state. The
  Storybook is still uploaded and hosted, so "failure" overstates it slightly — but
  the job asked for was to make components searchable, and a green build there means
  search silently returns nothing.

  Common causes, both seen in practice: a missing Playwright browser (fixed for
  generated workflows in 0.4.1), and a TypeScript resolution error in the analyzer
  on a plain `npm install` tree.

## 0.4.1

### Patch Changes

- a6ce9b3: `scry init` no longer reports success for steps that failed.

  Setting up a real repository end to end produced "✅ Changes committed and pushed"
  and "✅ Repository secret (SCRY_API_KEY)" while having done neither. CI then failed
  at the deploy step with no credentials, and the only clue was a warning printed
  twenty lines above the success banner that contradicted it.

  Three fixes:

  - **`git add` no longer aborts the commit.** It throws on a `.gitignore`'d path, and
    one throw skipped the workflow files entirely. A leftover `.storybook-deployer.json`
    ignore rule from the pre-0.4.0 workaround was enough to prevent CI ever being set up.
  - **`gh variable` is no longer assumed.** It arrived in gh 2.21; Ubuntu 22.04 ships
    2.4.0. On older `gh` the first call threw and the secret after it was never reached,
    leaving the repository with no variables _and_ no secret. There is now a capability
    check and a `gh api` fallback.
  - **The closing summary reports what happened**, including a distinct message for
    "not attempted" when GitHub setup was skipped.

- 92bc27e: The GitHub Actions workflow `scry init` generates now installs a browser.

  Without it, screenshot capture failed for every story, no metadata archive was
  produced, and **nothing was ever indexed** — while the deploy exited 0 and the
  workflow went green. Proved on a real repository: CI passed and the project
  recorded `storybook_uploaded` and nothing else.

  The install command follows the project's package manager. `npx` is not safe to
  assume: under pnpm it resolves against the pnpm-managed environment and reports
  `playwright: not found` (exit 127) even with `--yes`.

  **If you ran `scry init` before this release, add the step by hand** before your
  deploy step, or re-run `init` — otherwise CI will keep passing without indexing
  anything.

## 0.4.0

### Minor Changes

- b609957: `scry init` no longer writes your API key into the committed config file.

  `--commit-api-key` described itself as "not recommended" and defaulted to true, so
  every `init` wrote the key into `.storybook-deployer.json` and committed it. The
  copy was never load-bearing: `init` already stores the key as the `SCRY_API_KEY`
  GitHub secret and the workflow it generates reads it from there.

  Passing `--no-commit-api-key` did not help either — the key was written regardless,
  and the `.gitignore` entry it added never matched, because `#` only starts a comment
  at the beginning of a line in `.gitignore`.

  The default is now false and the escape hatch still exists behind an explicit
  `--commit-api-key`. For local runs, export `SCRY_API_KEY` instead.

  **If you ran an earlier version, rotate that project's API key** — git history keeps
  it after the file is changed.

## 0.3.2

### Patch Changes

- 6b9727b: Stop sending credentials to error reporting, and document the reporting.

  The CLI already reported errors to Sentry, and it was sending three things it
  should not have. `scope.setExtra('argv', argv)` shipped the whole parsed argv,
  which contains `--api-key` under both `apiKey` and `api-key` — so every failed
  deploy carried the customer's project credential to a third party. Upload errors
  quote the presigned URL in full, including `X-Amz-Signature`, which is a
  time-limited write credential for the bucket. Stack frames carried absolute paths
  containing usernames and, often, unreleased product names.

  Reporting now uses an allowlist of argv fields rather than the whole object, so a
  newly added option is invisible to telemetry until someone opts it in — the
  reverse, remembering to exclude each new secret, is exactly how the API key got
  through. Messages, exception values and extras are scrubbed for presigned query
  strings, `scry_proj_` keys and bearer tokens, and stack frames are reduced to
  basenames.

  Adds an opt-out. `SCRY_TELEMETRY=0` and the cross-tool `DO_NOT_TRACK=1` are both
  honoured, including in CI. The README now documents what is and is not sent;
  previously nothing disclosed that the CLI reported at all.

  Traces are no longer sampled from customer machines — errors only.

## 0.3.1

### Patch Changes

- 929c228: Retry the deploy upload on transient network failures.

  The presigned-URL request and the R2 upload were both single-shot, so a momentary
  DNS hiccup or connection reset discarded the several minutes of screenshot capture
  that had already succeeded. Six consecutive real deploys failed this way in one
  afternoon, each with `EAI_AGAIN` or `ECONNRESET` at the final step.

  Both calls now retry up to four times with exponential backoff, and only on
  conditions a later attempt can survive (network-level errors, 429, and 5xx) —
  a 4xx still fails immediately rather than delaying the error the user needs to
  see. Each retry re-requests the presigned URL, since those are signed at request
  time and would otherwise expire into a confusing signature error. Retries are
  logged at info level so a recovering deploy is not mistaken for a hung one.

## 0.3.0

### Minor Changes

- ab03139: Stop reporting indexing the deployer cannot confirm.

  Uploading is synchronous; indexing is not. The command printed
  `🎉 Deployment successful! 🎉` immediately after upload, so a build that failed
  in the processing queue seconds later still looked like a success. In one run
  the pipeline died 7s after this message on a revoked credential, and nothing in
  the output said so — the failure only surfaced much later, as an empty search.

  The final message is now `✅ Upload complete.`, followed by an explicit note
  that indexing is queued but unverified and that components are not searchable
  until it finishes. If metadata uploaded but was _not_ queued, that is called out
  as a warning: the Storybook is hosted, but nothing is being indexed.

  Also adds a `warn` level to the logger, which previously had only
  `info`/`success`/`error`/`debug`.

## 0.2.2

### Patch Changes

- a1a8178: Fix TypeError crash when metadata ZIP upload fails (logger.warn → logger.error)

## 0.2.1

### Patch Changes

- 481f52d: Fix: resolve scry-sbcov CLI from installed dependency instead of npx cache

  Prevents CI from using a stale cached version of @scrymore/scry-sbcov that
  doesn't support --screenshots. Falls back to npx if the resolve fails.

## 0.2.0

### Minor Changes

- a671ab2: Enable build processing service integration by default in generated workflows

  - Bump @scrymore/scry-sbcov dependency to ^0.3.0 for screenshot-metadata ZIP support
  - Generated GitHub Actions workflows now include `--with-analysis` flag by default
  - To disable, set env var `STORYBOOK_DEPLOYER_WITH_ANALYSIS=false` or remove the flag from workflow

## 0.1.1

### Patch Changes

- a671ab2: Bump @scrymore/scry-sbcov dependency to ^0.3.0 for screenshot-metadata zip support

## 0.1.0

### Minor Changes

- 87ed4ab: Changed `--coverage-execute` to be enabled by default in workflow templates

  **Breaking Change for Workflow Templates:**

  - Coverage execution is now **enabled by default** in generated GitHub Actions workflows
  - To disable, set repository variable `SCRY_COVERAGE_EXECUTE=false`

  **Upgrade Instructions:**
  Users who have already run `npx @scrymore/scry-deployer init` should run:

  ```bash
  npx @scrymore/scry-deployer update-workflows
  ```

  This will regenerate the workflow files with the new defaults.

## 0.0.7

### Patch Changes

- 0db40eb: Update @scrymore/scry-sbcov dependency to ^0.2.2 minimum

## 0.0.6

### Patch Changes

- Add Sentry integration for error tracking and update @scrymore/scry-sbcov dependency

## 0.0.5

### Patch Changes

- 6505a2c: Update @scrymore/scry-sbcov dependency to ^0.2.1 minimum and remove local linking

## 0.0.4

### Patch Changes

- [#7](https://github.com/epinnock/scry-node/pull/7) [`4e32596`](https://github.com/epinnock/scry-node/commit/4e32596bfe8c34d3d09bc1223fe90edb1ee619f7) Thanks [@epinnock](https://github.com/epinnock)! - fix: update the view link

## 0.0.3

### Patch Changes

- [#4](https://github.com/epinnock/scry-node/pull/4) [`5f124ef`](https://github.com/epinnock/scry-node/commit/5f124ef90d575f9956c2fa32a389bd101a4feb1a) Thanks [@epinnock](https://github.com/epinnock)! - update docs

## 0.0.2

### Patch Changes

- [`734fc67`](https://github.com/epinnock/scry-node/commit/734fc67a69ff70dbf556ba27029a0cf8ce4f882b) Thanks [@epinnock](https://github.com/epinnock)! - Initial release

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Changesets will automatically update this file when releases are made -->

## [0.0.1] - Initial Release

### Added

- Initial release of `@scrymore/scry-deployer`
- CLI for deploying Storybook static builds
- Support for automated screenshot capture with storycap
- GitHub Actions workflow templates for PR previews and production deployments
- Configuration via environment variables and config files
