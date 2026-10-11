# Scry Storybook Deployer

Deploy your Storybook to the cloud with one command. ⚡

## Set up with your AI assistant

From your application's repository, install the Scry setup skill:

```bash
npx skills add epinnock/scry-node --skill scry-setup
```

The current installer requires Node.js 22.20 or newer. Choose your assistant
(Claude Code, Codex, Cursor, or another compatible agent), then ask:
**“Set up Scry for this project and connect my assistant to its components.”**

The skill handles deployment configuration, GitHub Actions, component indexing,
MCP connections, and optional Figma linking. You can also ask for MCP alone.
Complete account sign-in in your browser and keep API keys in your environment
or CI secret store.

See the [setup guide](https://docs.scrymore.com/guide/skill) for installation
options, or inspect the [skill instructions](skills/scry-setup/SKILL.md).

## Set up directly with the CLI

`init` writes configuration and workflows, configures GitHub secrets, then
commits and pushes. For local preparation before publishing, use the skill or
the manual deployment path below. `--skip-gh-setup` still commits and pushes.

### 1. Get your credentials
Visit the [Scry Dashboard](https://dashboard.scrymore.com) and:
- 🔐 Login with your account (Firebase)
- 📦 Create a new project
- 📋 Copy your **Project ID** and **API Key**

### 2. Run the setup command

```bash
npx @scrymore/scry-deployer init --projectId YOUR_PROJECT_ID --apiKey YOUR_API_KEY
```

**That's it!** 🎉

The `init` command automatically:
- ✅ Creates configuration file (`.storybook-deployer.json`)
- ✅ Generates GitHub Actions workflows
- ✅ Sets up repository variables and secrets
- ✅ Commits and pushes everything to GitHub
- ✅ Triggers automatic deployment

### What happens next?

Your Storybook now deploys automatically:
- 🚀 **Push to main** → Deploys to production (`/latest`)
- 🔍 **Open a PR** → Deploys preview (`/pr-123`)
- 🔄 **Update PR** → Updates preview automatically

No additional configuration needed!

---

## 📚 About

A client-side Command-Line Interface (CLI) tool to automate the deployment of Storybook static builds.

This tool is designed for execution within a CI/CD pipeline (such as GitHub Actions). The core workflow involves:
1.  Archiving a specified Storybook build directory.
2.  Authenticating with a secure backend service.
3.  Uploading the archive directly to cloud storage.

**Features:**
- 🚀 Simple Storybook static build deployment
- 🔍 Auto-detection of `.stories.*` files
- 📊 Story metadata extraction and analysis
- 📸 Automated screenshot capture with storycap
- 🧪 Storybook coverage analysis + PR summary comments (see `docs/COVERAGE.md`)
- 📦 Organized master ZIP packaging (staticsite, images, metadata)
- ⚙️ Flexible configuration (CLI, env vars, config file)
- 🔒 Secure presigned URL uploads

---

## 🚀 Manual Deployment (Testing)

Want to test a deployment before setting up automation? Run:

```bash
npx @scrymore/scry-deployer --dir ./storybook-static --project YOUR_PROJECT_ID --api-key YOUR_API_KEY
```

This deploys your Storybook immediately without setting up GitHub Actions.

---

## 📦 Installation (Optional)

**You don't need to install anything!** Just use `npx` to run the init command:

Requires Node.js 20.9 or newer (Node 18 is end of life; use `@scrymore/scry-deployer@0.11` if you are stuck on it).

```bash
# From npm (recommended)
npx @scrymore/scry-deployer init --projectId xxx --apiKey yyy

# From GitHub (latest from main branch)
npx github:scryorg/scry-node init --projectId xxx --apiKey yyy
```

### Installing as a Dependency

If you prefer to install it as a development dependency:

```bash
# From npm (when published)
npm install @scrymore/scry-deployer --save-dev

# From GitHub
npm install github:scryorg/scry-node --save-dev
# or
pnpm add github:scryorg/scry-node -D
# or
yarn add github:scryorg/scry-node --dev
```

After installation, you can run commands using:

```bash
# Using the scry-deployer binary
npm exec -- scry-deployer init --projectId xxx --apiKey yyy

# Using the scry alias
npx scry init --projectId xxx --apiKey yyy

# Using the storybook-deploy alias (for deploy commands)
npx storybook-deploy --dir ./storybook-static
```

**Note:** The `init` command handles all configuration automatically, so manual installation is only needed if you want the package in your `node_modules` for local development.

## Configuration for Your API

To use this package with the Storybook deployment API at `https://storybook-deployment-service.epinnock.workers.dev`, configure your `.storybook-deployer.json` file:

```json
{
  "apiUrl": "https://storybook-deployment-service.epinnock.workers.dev",
  "dir": "./storybook-static",
  "project": "my-project",
  "version": "v1.0.0",
  "verbose": false
}
```

**API Endpoints Used:**
1. **Direct Upload**: `POST /upload/{project}/{version}` with binary zip data

**Example Usage:**

```bash
# Deploy to project "my-storybook" with version "v1.0.0"
npx storybook-deploy \
  --dir ./storybook-static \
  --project my-storybook \
  --version v1.0.0

# Using environment variables
export STORYBOOK_DEPLOYER_API_URL=https://storybook-deployment-service.epinnock.workers.dev
export STORYBOOK_DEPLOYER_PROJECT=my-project
export STORYBOOK_DEPLOYER_VERSION=v1.0.0

npx storybook-deploy --dir ./storybook-static
```

**Note:** If `--project` or `--version` are not provided, they default to `main` and `latest` respectively.

## Usage

The CLI provides a single command to handle the deployment. It can be run using `npx` from within your project's directory.

```bash
npx storybook-deploy [options]
```
The CLI provides two commands: `deploy` (default) and `analyze`.

### Deploy Command (Default)

Deploy your Storybook static build, optionally with analysis.

```bash
npx storybook-deploy [options]
```

### Analyze Command

Analyze Storybook stories, capture screenshots, and generate metadata without deploying the static site.

```bash
npx storybook-deploy analyze [options]
```

Since 0.10 it writes a [Scry Capture Format](https://github.com/scryorg/scry-capture-format) bundle
(`scf.json` + images) and uploads it through the bundle route, so the build is queued for indexing
(earlier versions uploaded a ZIP that created a build and never indexed it).

### Upload Command (Scry Capture Format bundles)

Upload captures from any tool as an SCF 1.0 bundle — a directory or `.zip` with `scf.json` at the
root (a legacy sbcov `metadata.json` archive also works):

```bash
npx @scrymore/scry-deployer upload ./.scry/capture --project <id> --api-key <key> [--deploy-version v1]
```

- The bundle is validated locally first with the same validator the upload service runs
  (`@scrymore/scf`, vendored in `lib/vendor/scf`). Every problem is printed with its capture id and
  the command exits 1 without uploading anything. `--dry-run` validates and zips only.
- `--source <kind>:<platform>` must match `scf.json` (it defaults to it).
- **Source code is never uploaded unless you pass `--include-source`.** With it, each capture's
  `code.componentFile` (relative to `--repo-root`, default the working directory) is copied into the
  bundle's `source/` folder and the CLI prints `Uploading source text for N components
  (--include-source)`. Without it, any `source/` files or `sourceText` fields already in the input
  bundle are dropped.

### Capture Command (React Native Storybook)

Capture every story of an on-device [React Native Storybook](https://github.com/storybookjs/react-native)
(v10+, `websockets: 'auto'`) on an iOS Simulator or Android emulator into an SCF bundle:

```bash
npx @scrymore/scry-deployer capture rn --platform android --device Pixel_6_API_34 [--app app-debug.apk]
npx @scrymore/scry-deployer capture rn --platform ios --device "iPhone 16" [--app Kettle.app]
npx @scrymore/scry-deployer upload .scry/capture --project <id>
```

It starts Metro with `STORYBOOK_ENABLED=true` (unless the Storybook channel on `:7007` is already up),
boots or finds the device, fixes the status bar (iOS: 9:41 and a full battery; Android: System UI demo
mode) and turns animations off, installs `--app` (or builds with `--build`, or uses the installed app
from `app.json`'s id), then for each story from the channel's `/index.json`: selects it over the
websocket, waits for it to render and for two identical frames (10 s budget, `--settle-timeout`, else it
is listed as skipped with reason `timeout`), crops to the view with `testID="scry-root"` and writes
`images/NNNN.png`. `scf.json` records `source.kind: storybook-rn`, the platform, device, scale and honest
counts; there is no `links.live`. If the app includes Scry's dev-only probe (see
[scry-sample-rn](https://github.com/scryorg/scry-sample-rn) `.rnstorybook/scryProbe.tsx`), each story also
gets an `rn-fiber` structure tree. Output goes to `.scry/capture` (`--out`).

#### The Dynamic Island and other hardware overlays

A simulator screenshot includes the Dynamic Island / notch / status bar, and the crop is the story's
`scry-root` view. A component that renders at the very top of the screen is therefore captured with the
island painted over it. `capture rn` does not crop a different region or hide the overlay. Instead, on iOS
it reads the story root's frame from the app's probe and, when the frame starts inside the device's top
unsafe area (59 pt on iPhone 15/16, 62 pt on 16 Pro, 47 pt on 12-14, from a table keyed on the simulator
name), it prints a warning per story and writes `"x-scry": { "captureWarnings": ["overlaps_top_unsafe_area"] }`
on that capture in `scf.json`.

To fix the captures, wrap every story in a `SafeAreaView` decorator
(`react-native-safe-area-context`) in `.rnstorybook/preview.tsx` so components render below the island:

```tsx
decorators: [(Story) => <SafeAreaProvider><SafeAreaView edges={['top']}><Story /></SafeAreaView></SafeAreaProvider>]
```

`--safe-area-inset <points>` sets the top unsafe-area height used for the check when your device is not in
the table (or to be stricter); it does not move or crop anything. Requires the app's Scry probe, since the
frame comes from it.

### Options

The CLI is configured through a combination of command-line options and environment variables. Command-line options always take precedence.

| Option         | Environment Variable                  | Description                                                  | Required | Default                              |
|----------------|---------------------------------------|--------------------------------------------------------------|----------|--------------------------------------|
| `--dir`        | `STORYBOOK_DEPLOYER_DIR`              | Path to the built Storybook directory (e.g., `storybook-static`). | Yes      | -                                    |
| `--api-key`    | `STORYBOOK_DEPLOYER_API_KEY`          | The API key for the deployment service.                        | No       | -                                    |
| `--api-url`    | `STORYBOOK_DEPLOYER_API_URL`          | Base URL for the deployment service API.                       | No       | `https://storybook-deployment-service.epinnock.workers.dev` |
| `--project`    | `STORYBOOK_DEPLOYER_PROJECT`          | The project name/identifier.                                   | No       | `main`                               |
| `--version`    | `STORYBOOK_DEPLOYER_VERSION`          | The version identifier for the deployment.                     | No       | `latest`                             |
| `--with-analysis` | `STORYBOOK_DEPLOYER_WITH_ANALYSIS` / `SCRY_WITH_ANALYSIS` | Capture screenshots and metadata so components are searchable. **On by default since 0.7.0.** | No       | on                                   |
| `--no-analysis` | `STORYBOOK_DEPLOYER_ANALYSIS=false` | Host the Storybook without indexing it. The log says the build is NOT searchable. | No | - |
| `--max-dropped` | `SCRY_MAX_DROPPED` (or `maxDropped` in `.storybook-deployer.json`) | How many stories may fail to capture before the deploy ends red. The deployer always passes it to scry-sbcov (0.5.2+); the stories that did capture are uploaded and queued first. | No | `0`: any dropped story ends the deploy red |
| `--stories-dir` | `STORYBOOK_DEPLOYER_STORIES_DIR`     | Path to stories directory (optional, auto-detects .stories.* files). | No | Auto-detect                          |
| `--screenshots-dir` | `STORYBOOK_DEPLOYER_SCREENSHOTS_DIR` | Directory for captured screenshots.                        | No       | `./screenshots`                      |
| `--storybook-url` | `STORYBOOK_DEPLOYER_STORYBOOK_URL` | URL of running Storybook server for screenshot capture.        | No       | `http://localhost:6006`              |
| `--capture-mode` | `SCRY_CAPTURE_MODE`                 | Screenshot framing forwarded to scry-sbcov: `root` (crop to the component) or `viewport`. | No | unset: sbcov decides (`root` from sbcov 0.6) |
| `--capture-scale` | `SCRY_CAPTURE_SCALE`               | Screenshot device scale factor forwarded to scry-sbcov, `0 < n <= 4`. | No | unset: sbcov decides (`2` from sbcov 0.6) |
| `--capture-viewport` | `SCRY_CAPTURE_VIEWPORT`         | Browser viewport `WIDTHxHEIGHT` forwarded to scry-sbcov.       | No | unset: sbcov decides (`1280x720`) |
| -              | `SCRY_CONCURRENCY` (or `concurrency` in `.storybook-deployer.json`) | Stories scry-sbcov renders at once (`--concurrency`, 1-32). Forwarded only to scry-sbcov 0.7+; with an older one the log says it was not applied. | No | unset: sbcov decides (`4` from 0.7) |
| -              | `SCRY_RENDER_TIMEOUT_MS` (or `renderTimeoutMs`) | How long a story may take to show something before it is written off (`--render-timeout`, 100-600000 ms). sbcov 0.7+ only, as above. | No | unset: sbcov decides (`5000` from 0.7) |
| -              | `SCRY_EXECUTE_BUDGET_BASE_S`, `SCRY_EXECUTE_BUDGET_PER_STORY_S` | Story execution budget = base + per story × declared stories. Over it: a warning (`::warning::` in GitHub Actions), never a failure. See "CI time". | No | `120` and `0.5` |
| `--verbose`    | `STORYBOOK_DEPLOYER_VERBOSE`          | Enable verbose logging for debugging purposes.                 | No       | `false`                              |
| -              | `SCRY_NO_UPDATE_CHECK=1`              | Skip the check against npm `latest` (a one-line warning when this deployer is older; 2 s limit, never fails the deploy). | No | check on |
| `--help`, `-h` | -                                     | Show the help message.                                       | -        | -                                    |
| `--version`, `-v`| -                                     | Show the version number.                                     | -        | -                                    |

### Exit codes and indexing (0.7.0)

A deploy that was asked to index and will index nothing ends **red**. The Storybook is still
uploaded and hosted in every case below, so the preview link works; the red run is the signal.

| What happened | Log line | Exit code |
|---|---|---|
| Stories captured, metadata uploaded and queued | `⏳ Indexing has been queued, not finished.` | 0 |
| Metadata upload rejected by the service (a failed PUT or complete also marks the build failed) | `❌ The metadata upload failed (<reason>), so NOTHING WILL BE INDEXED.` | 1 |
| Metadata uploaded but not queued | `❌ Metadata was uploaded but not queued for processing, so NOTHING WILL BE INDEXED.` | 1 |
| Analysis captured 0 stories (the empty archive is not uploaded, no build is queued) | `❌ Analysis captured 0 of N stories, so NOTHING WILL BE INDEXED.` plus the first capture error | 1 |
| Analysis produced no archive (for example, no Playwright browser) | `❌ Analysis produced no metadata, so NOTHING WILL BE INDEXED.` | 1 |
| scry-sbcov exited non-zero but wrote an archive (exit 3: more stories dropped than `--max-dropped`, default 0) | the archive is queued, then `❌ scry-sbcov dropped more stories than --max-dropped allows (exit 3)…` and `N of M stories were not captured (timeout 40, …)` | 1 |
| scry-sbcov exited 0 but its `sbcov-manifest.json` lists more dropped stories than `--max-dropped` allows | the archive is queued, then `❌ N of M stories were not captured (…), more than --max-dropped K allows.` | 1 |
| Some stories dropped, within `--max-dropped` | `scry-sbcov: 417/461 stories captured, 44 not captured (timeout 40, render error 4).` then the queued line | 0 |
| scry-sbcov exited non-zero with no archive (exit 2: broken capture config) | `❌ Analysis produced no metadata…` with `Cause: scry-sbcov rejected the capture config (exit 2)` | 1 |
| `--no-analysis` (or `--no-coverage` / `--coverage-report <file>` without `--with-analysis`) | `ℹ️  Analysis skipped (--no-analysis): this build is hosted but NOT searchable.` | 0 |
| Any error before the upload (bad `--dir`, bad API key, invalid flag) | `❌ Error: …` | 1 |

scry-sbcov's own exit codes (0.5.2+): **0** ok, **2** the capture config is broken, misspelt or
unknown (no archive), **3** more stories dropped than `--max-dropped` (archive of the rest written).
The deployer passes `--max-dropped 0` unless you set a value; with a scry-sbcov older than 0.5.2,
which does not know the flag, it is not passed and the log says dropped stories cannot be counted.

Before 0.7.0 the metadata-upload failure, the "not queued" case, an empty archive, a non-zero
scry-sbcov exit and a workflow that simply forgot `--with-analysis` all ended green (ISSUES.md #50).

### Large metadata ZIPs (0.12.0)

The metadata ZIP is sent straight to storage on a presigned URL (presign, PUT, complete), not
through the upload service, so it can be larger than 100 MiB (limit 2 GiB). It used to be POSTed
through the service with a 100 MiB cap, and a library whose ZIP passed that (the dashboard's was
101.5 MiB) indexed nothing and left its build "pending" (ISSUES.md #74). If the PUT or complete step
fails, the build is marked failed with a reason, the log says `marked failed`, and the run exits 1.
Against an upload service that has no presign route yet, the old route is used for a ZIP of up to
100 MiB (the log says so); a larger ZIP stops with `upload service too old for a ZIP this size`.

### CI time (0.9.0)

Every deploy measures how much CI time Scry took and records it with the build (ISSUES.md #54:
a 461-story preview ran for 20 minutes and nothing said so). What you see in the log:

```
Story execution: 461 stories in 3.5 min (4 workers), budget 5.8 min.
CI time recorded: deployer 4.4 min, job 6.1 min so far (Actions API).
CI timings: stored with the build.
```

- **Budget.** Story execution is judged against `120 s + 0.5 s × declared stories`
  (`SCRY_EXECUTE_BUDGET_BASE_S`, `SCRY_EXECUTE_BUDGET_PER_STORY_S`). Over it, the run gets a
  `::warning title=Scry story execution over budget::…` annotation naming the time, the budget and
  where the time went (`timeout 40 s, …`). It is a warning; the exit code does not change.
- **What is recorded** on the build (`ciTimings`): `analyzeMs`, `executeMs` (from scry-sbcov;
  `executeSource: "deployer-wall"` when an older sbcov does not report it and the whole sbcov run
  is used instead), `archiveMs`, `uploadMs`, `deployerTotalMs`, story counts, time lost per reason,
  sbcov and deployer versions, `runner` (`github-hosted` / `self-hosted` / `unknown`), the Actions
  run id and attempt, `budgetMs` and `overBudget`. A number that could not be measured is left
  out, never sent as 0.
- **Whole-job time** needs `permissions: actions: read` and `GITHUB_TOKEN` in the deploy step (the
  generated workflows have both). The deployer reads its own job's start time from the Actions API
  (5 s limit). Without it the log says `CI time recorded: deployer time only (job start unknown:
  no-token | forbidden | timeout | not-github | …)` and only the deployer's own time is recorded.
- **Never fails a deploy.** An upload service without the CI-timings route answers 404: the log
  says `the upload service does not record CI timings yet; not stored` once and the summary line
  reads `CI timings: final record not stored (1)`. A record the service rejects (400) is a warning
  with the reason. Exit codes come from indexing only (table above).
- The generated workflows also set `timeout-minutes: 20` on the Storybook job, so a stuck run
  stops after 20 minutes instead of GitHub's default 6 hours.

### Story File Auto-Detection

The analysis feature now automatically detects `.stories.*` files anywhere in your project! You no longer need to specify a stories directory - the system intelligently searches for story files with these features:

**Supported File Patterns:**
- `.stories.ts`, `.stories.tsx`
- `.stories.js`, `.stories.jsx`
- `.stories.mjs`, `.stories.cjs`

**Auto-Detection Benefits:**
- **Automatic Discovery**: Finds story files anywhere in your project
- **Intelligent Exclusions**: Skips common directories (`node_modules`, `dist`, `build`, `.git`, etc.)
- **Flexible Structure**: Works with any project organization
- **Performance Optimized**: Searches up to 5 levels deep by default

You can still specify a custom directory with `--stories-dir` if needed.

### Configuration Hierarchy

The configuration is resolved in the following order of precedence:
1.  **Command-Line Arguments**: Highest precedence (e.g., `--api-key=some_key`).
2.  **Environment Variables**: Sourced from the execution environment (e.g., `STORYBOOK_DEPLOYER_API_KEY=some_key`).
3.  **Configuration File**: Values from `.storybook-deployer.json` in your project directory (automatically created during installation).
4.  **Programmatic Defaults**: Lowest precedence (e.g., for `--api-url`).

## Import from Adobe Bridge (beta)

`scry import <folder>` uploads a folder of images you exported from Adobe Bridge as a collection in a Scry project.

```bash
scry import ./bridge-export --project my-project        # asks before sending
scry import ./bridge-export --project my-project --yes  # no prompt (CI, scripts)
scry import ./bridge-export --dry-run                   # build the bundle, send nothing
```

- Only the folder you pass is read. Symbolic links are not followed, and nothing is watched or synced.
- PNG, JPEG and WebP are used as they are. PSD, TIFF, HEIC, PDF and AI are converted on your machine, so the original never leaves it. Conversion needs ImageMagick (`magick`), or `sips` on macOS, or `pdftoppm` for PDF/AI. Without one, those files are reported as skipped.
- Images are held to what the AI services accept. PNG, JPEG and WebP kept as they are must be within 4096 px on the longest side and 4 MiB; larger ones are re-encoded down to 2048 px and 4 MiB, and converted files (PSD, TIFF, HEIC, PDF, AI) are rendered at 2048 px and 4 MiB at most. A file that cannot be made to fit is skipped with the reason. Converters run with memory, disk, area and time limits. The home folder and the disk root are refused as the folder to import.
- From Bridge's metadata only title, description, keywords, rating and label are read (from the file or a sidecar `.xmp`). Location, camera serial and other device data are never read, and embedded EXIF/XMP/IPTC (and anything appended after the end of the image) is removed from the uploaded image. File names and folder paths are not uploaded; the text you wrote in a title, description or keyword is sent as you wrote it, so it is yours to keep clean. The upload also carries the git commit and branch of the repository in the directory you run the command from, which the consent text shows.
- Before uploading, the command prints the counts and what is skipped. The images are then sent to OpenAI, Google Gemini and Jina for AI captioning and embeddings, so it asks for a yes, or `--yes`. OpenAI writes a short description of each picture and sees only the picture; Google Gemini and Jina turn each picture, and its title, description and keywords, into search data; rating and label stay in Scry. No answer (Ctrl-D, Ctrl-C) counts as no: nothing is sent and the command exits 1.

Status: beta. Conversion of PSD/TIFF/HEIC/PDF/AI is covered by tests with a stand-in converter; try it on a real export and report problems.

## Private Projects

If your project is set to **private** in the Scry dashboard, uploaded Storybook
and coverage reports will only be accessible to logged-in project members.

### How it works

1. Upload works the same way (using your API key)
2. The generated links work for anyone who is:
   - Logged into the Scry dashboard
   - A member of your project

### Sharing with team members

To give someone access to a private project:

1. Go to your project in the [Scry Dashboard](https://dashboard.scrymore.com)
2. Navigate to **Settings** → **Members**
3. Add their email address

They'll need to log in once, then all project links will work automatically.

### Configuration File

The configuration file (`.storybook-deployer.json`) is automatically created in your project directory when you install the package. You can edit this file to set default values for common options:

```json
{
  "apiUrl": "https://api.your-service.com/v1",
  "dir": "./storybook-static",
  "project": "my-project",
  "version": "v1.0.0",
  "verbose": false
}
```

**Property Reference:**
- `apiKey` → `--api-key` CLI option
- `apiUrl` → `--api-url` CLI option
- `dir` → `--dir` CLI option
- `project` → `--project` CLI option
- `version` → `--version` CLI option
- `verbose` → `--verbose` CLI option
- `captureMode` → `--capture-mode` CLI option
- `captureScale` → `--capture-scale` CLI option
- `captureViewport` → `--capture-viewport` CLI option (`"390x844"` or `{ "width": 390, "height": 844 }`)

**Screenshot capture settings.** `captureMode`, `captureScale` and `captureViewport` are validated and passed to
scry-sbcov as `--capture-mode`, `--capture-scale` and `--capture-viewport`. Only the ones you set are passed, so
leaving them out keeps sbcov's defaults and any `scry-sbcov.config.*` in your project in charge. An invalid value
fails the run. To keep whole-window 1x screenshots, set `"captureMode": "viewport", "captureScale": 1`. For
`root` mode, mark the component with `data-scry-root` (see the scry-sbcov README, "Capture settings").

**See [`.storybook-deployer.example.json`](.storybook-deployer.example.json) for a complete configuration file with all available options and their default values.**

### Usage Examples

**Basic deployment with config file:**
```bash
# Set project and version in .storybook-deployer.json, then run:
npx storybook-deploy --dir ./storybook-static
```

**Deploy with Storybook analysis:**
```bash
# Deploy with story metadata and screenshots (auto-detects story files)
npx storybook-deploy \
  --dir ./storybook-static \
  --with-analysis \
  --storybook-url http://localhost:6006

# Or specify a custom stories directory
npx storybook-deploy \
  --dir ./storybook-static \
  --with-analysis \
  --stories-dir ./src/components \
  --storybook-url http://localhost:6006
```

**Standalone analysis (no deployment):**
```bash
# Analyze stories and capture screenshots (auto-detects story files)
npx storybook-deploy analyze \
  --project my-project \
  --version v1.0.0 \
  --storybook-url http://localhost:6006

# Or with custom stories directory
npx storybook-deploy analyze \
  --project my-project \
  --version v1.0.0 \
  --stories-dir ./src \
  --storybook-url http://localhost:6006
```

**Override specific options:**
```bash
# Use config file defaults but override API URL:
npx storybook-deploy --api-url https://staging-api.service.com/v1
```

**Full command-line configuration:**
```bash
npx storybook-deploy \
  --dir ./storybook-static \
  --api-url https://storybook-deployment-service.epinnock.workers.dev \
  --project my-storybook \
  --version v1.0.0 \
  --verbose
```

### Master ZIP Structure

When analysis is enabled (`--with-analysis`), the tool creates a master ZIP file named `{project}-{version}.zip` with the following CDN-compliant structure:

```
my-project-v1.0.0.zip
├── index.html           # Storybook static build at root (CDN-compliant)
├── iframe.html
├── static/
│   └── ...
├── images/              # Captured screenshots
│   ├── story1.png
│   ├── story2.png
│   └── ...
└── metadata.json        # Story metadata and mappings
```

**metadata.json** contains:
- Story metadata (file paths, component names, story names)
- Screenshot mappings (which image corresponds to which story)
- Analysis timestamp and configuration

**Important:** The static site files (`index.html`, etc.) are placed at the **root of the ZIP** to ensure CDN compatibility. This allows the CDN to find `index.html` at the root level as expected.

Without analysis, only the static site is zipped and uploaded as `{project}-{version}.zip` with files at root.

## Example CI/CD Integration (GitHub Actions)

Let the deployer write the workflows for you (`init` for a new project, `update-workflows` to
refresh existing ones; see below). The steps it generates, after your Storybook is built:

```yaml
- name: Install the Scry deployer
  id: scry
  # Its own folder and a floor of ^0.7.0: the repo's own pin cannot pick an older deployer.
  run: |
    set -o pipefail
    mkdir -p "$RUNNER_TEMP/scry"
    npm i --no-save --no-audit --no-fund --ignore-scripts --prefix "$RUNNER_TEMP/scry" @scrymore/scry-deployer@^0.7.0
    cd "$RUNNER_TEMP/scry"
    echo "version=$(node -p "require('@scrymore/scry-deployer/package.json').version")" >> "$GITHUB_OUTPUT"
    PW="$(npx --no-install playwright --version | awk '{print $2}')"
    [ -n "$PW" ] || { echo "::error::the deployer's Playwright was not found"; exit 1; }
    echo "playwright=$PW" >> "$GITHUB_OUTPUT"

- name: Cache the deployer's Playwright browser
  uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: scry-pw-${{ runner.os }}-${{ steps.scry.outputs.playwright }}

- name: Install the deployer's Playwright browser
  working-directory: ${{ runner.temp }}/scry
  run: npx --no-install playwright install --with-deps chromium-headless-shell

- name: Deploy to Scry
  run: |
    "$RUNNER_TEMP/scry/node_modules/.bin/scry-deployer" \
      --dir ./storybook-static \
      --with-analysis \
      --coverage-base ${{ vars.SCRY_COVERAGE_BASE || github.event.before }}
  env:
    STORYBOOK_DEPLOYER_API_URL: ${{ vars.SCRY_API_URL }}
    STORYBOOK_DEPLOYER_PROJECT: ${{ vars.SCRY_PROJECT_ID }}
    STORYBOOK_DEPLOYER_API_KEY: ${{ secrets.SCRY_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Why these steps and in this order:

- **The deployer goes into its own folder** (`$RUNNER_TEMP/scry`), so a version pinned in your
  `package.json` or lockfile cannot select an old deployer, and a pnpm or yarn `node_modules`
  is never touched. The same steps work for npm, pnpm, yarn and bun projects.
- **The browser comes from the deployer's own Playwright**, installed after the deployer.
  A bare `npx playwright install` resolves whatever Playwright is newest (or your project's)
  and can download a browser build the analyzer does not look for; every story then fails
  and nothing is indexed.
- **Never call a bare `npx @scrymore/scry-deployer`** in CI: it runs whatever version your
  repository pins, however old.

The full generated files are in [`templates/workflows/`](templates/workflows/). The PR
workflow also skips draft PRs, deploys when a PR is marked ready, and cancels a superseded run
for the same PR.

### PR Preview Deployments

Automatically deploy Storybook previews for every pull request to get instant visual feedback on UI changes. The PR preview workflow is included in this repository at [`.github/workflows/deploy-pr-preview.yml`](.github/workflows/deploy-pr-preview.yml).

**Features:**
- 🚀 Automatic deployment on PR creation and updates
- 💬 PR comment with deployment URL and metadata
- 🔄 Auto-updates the same comment on new commits
- ⚡ Fast builds (static site only, no analysis)
- 🏷️ Unique URLs per PR: `https://your-cdn.com/{project}/pr-{number}/`

#### Prerequisites

Before setting up PR preview deployments, ensure you have:

1. **A Storybook project** with a build command (e.g., `npm run build-storybook`)
2. **Access to repository settings** to configure GitHub Actions variables and secrets
3. **Backend deployment service** running and accessible (e.g., `https://storybook-deployment-service.epinnock.workers.dev`)
4. **Project identifier** for your Storybook deployment

#### Step-by-Step Setup

**Step 1: Copy the workflow file to your project**

If you're using this as a template, copy the workflow file to your repository:

```bash
mkdir -p .github/workflows
cp .github/workflows/deploy-pr-preview.yml YOUR_PROJECT/.github/workflows/
```

If you're installing from GitHub, the workflow file is already included.

**Step 2: Configure GitHub Actions Variables**

1. Navigate to your GitHub repository
2. Go to **Settings** → **Secrets and variables** → **Actions**
3. Click on the **Variables** tab
4. Click **New repository variable**
5. Add the following variables:

| Variable Name | Value | Example |
|--------------|-------|---------|
| `SCRY_PROJECT_ID` | Your project identifier | `my-storybook` or `company-design-system` |
| `SCRY_API_URL` | Backend API endpoint for uploads (the upload service) | `https://storybook-deployment-service.epinnock.workers.dev` |
| `SCRY_VIEW_URL` | Base URL where users view deployed Storybooks | `https://view.scrymore.com` |

**Note:** The `SCRY_VIEW_URL` is where users will access your deployed Storybook (e.g., `https://view.scrymore.com/{project}/pr-{number}/`). This is separate from `SCRY_API_URL`, which is the backend API endpoint used for uploads.

**Note:** Generated workflows pass `--with-analysis`, and since 0.7.0 analysis is on by default anyway. A deploy that indexes nothing ends red (see "Exit codes and indexing"). To host a Storybook without indexing it, change the flag to `--no-analysis`. Any story that fails to capture ends the deploy red (after the rest are queued); to allow some, set the repository variable `SCRY_MAX_DROPPED`.

**Step 3: Configure GitHub Actions Secrets (Optional)**

If your backend requires authentication:

1. In the same **Settings** → **Secrets and variables** → **Actions** page
2. Click on the **Secrets** tab  
3. Click **New repository secret**
4. Add the following secret:

| Secret Name | Value | Description |
|------------|-------|-------------|
| `SCRY_API_KEY` | Your API authentication key | Only needed if backend requires authentication |

**Step 4: Verify Your Storybook Build Command**

The workflow assumes your package.json has a `build-storybook` script. Verify this command exists:

```json
{
  "scripts": {
    "build-storybook": "storybook build"
  }
}
```

If your build command is different, update line 29 in `.github/workflows/deploy-pr-preview.yml`:

```yaml
- name: Build Storybook
  run: npm run build-storybook  # Change this if your command differs
```

**Step 5: Configure View URL (Where Users Access Storybooks)**

The workflow constructs deployment URLs using the `SCRY_VIEW_URL` variable:
```
{SCRY_VIEW_URL}/{PROJECT_ID}/pr-{PR_NUMBER}/
```

**Default:** If `SCRY_VIEW_URL` is not set, it defaults to `https://view.scrymore.com`

**Example URLs:**
- With default: `https://view.scrymore.com/my-project/pr-123/`
- With custom domain: `https://storybooks.mycompany.com/my-project/pr-123/`

To use a custom domain, add `SCRY_VIEW_URL` as a repository variable (see Step 2).

**Step 6: Test with a Pull Request**

1. Create a new branch in your repository:
   ```bash
   git checkout -b test-pr-preview
   ```

2. Make a small change (e.g., update README or add a comment)

3. Push the branch and create a pull request:
   ```bash
   git add .
   git commit -m "Test PR preview deployment"
   git push origin test-pr-preview
   ```

4. Open a PR on GitHub and watch the Actions tab for the workflow execution

5. Once complete, check for a comment on the PR with your deployment URL

#### Environment Variables Reference

The PR preview workflow uses these environment variables (configured via GitHub Variables and Secrets):

| Environment Variable | Source | Required | Description |
|---------------------|--------|----------|-------------|
| `SCRY_PROJECT_ID` | GitHub Variable | **Yes** | Project identifier for deployments |
| `SCRY_API_URL` | GitHub Variable | **Yes** | Backend API endpoint for uploads |
| `SCRY_VIEW_URL` | GitHub Variable | No | Base URL where users view Storybooks (default: `https://view.scrymore.com`) |
| `SCRY_API_KEY` | GitHub Secret | No | API authentication key (if required) |
| `STORYBOOK_DEPLOYER_WITH_ANALYSIS` | GitHub Variable | No | Set to `false` to disable build processing service integration (enabled by default in generated workflows) |
| `SCRY_MAX_DROPPED` | GitHub Variable | No | Stories allowed to fail capture before the deploy ends red (default 0) |
| `SCRY_CONCURRENCY`, `SCRY_RENDER_TIMEOUT_MS` | GitHub Variable | No | Stories rendered at once (default 4) and how long one may take to show something (default 5000 ms); scry-sbcov 0.7+ |
| `SCRY_EXECUTE_BUDGET_BASE_S`, `SCRY_EXECUTE_BUDGET_PER_STORY_S` | GitHub Variable | No | Story execution budget (default 120 s + 0.5 s per story); over it = a warning, see "CI time" |
| `GITHUB_TOKEN` | Actions token | No | Posts the PR comment and, with `permissions: actions: read`, lets the deployer record whole-job CI time |

**Important:** `SCRY_API_URL` (where files are uploaded) and `SCRY_VIEW_URL` (where users view the deployed Storybook) are two different URLs:
- **API URL**: Backend service endpoint (e.g., `https://api.scrymore.com`)
- **View URL**: Public-facing CDN or viewer URL (e.g., `https://view.scrymore.com`)

The CLI also supports these environment variables for backward compatibility:
- `STORYBOOK_DEPLOYER_*` (legacy prefix)
- `SCRY_*` prefix takes precedence

**How it works:**

1. When a PR is opened or updated, the workflow:
   - Builds the Storybook static site
   - Deploys to `{project}/pr-{number}` version
   - Posts a comment with the preview URL

2. The comment includes:
   - Direct link to the deployed preview
   - Commit SHA and branch name
   - Deployment timestamp

3. On subsequent commits to the PR:
   - The workflow redeploys to the same PR version
   - Updates the existing comment with new deployment details

**Example PR Comment:**

```markdown
## 🚀 Storybook Preview Deployed

**Preview URL:** https://view.scrymore.com/my-project/pr-123/

📌 **Details:**
- **Commit:** `abc1234`
- **Branch:** `feature/new-component`
- **Deployed at:** Wed, 13 Nov 2024 05:00:00 GMT

> This preview will be updated automatically on each commit to this PR.
```

#### Troubleshooting

**Problem: Workflow fails with "SCRY_PROJECT_ID not found"**
- Solution: Ensure you've added `SCRY_PROJECT_ID` as a repository variable (not secret)
- Variables and Secrets are different - make sure you're in the Variables tab

**Problem: Deployment succeeds but no comment is posted**
- Solution: Check that the workflow has `pull-requests: write` permission
- This is already configured in the workflow file but may be restricted by organization settings

**Problem: Comment is posted multiple times instead of updating**
- Solution: This is expected if the bot user changes. The workflow looks for existing comments from the same bot

**Problem: Build fails with "command not found: build-storybook"**
- Solution: Update your package.json to include the build-storybook script, or modify the workflow to use your build command

**Problem: Deployment URL returns 404**
- Solution: Verify your backend deployment service is running and the URL pattern matches your backend's routing

#### Workflow File Reference

See the complete workflow configuration: [`.github/workflows/deploy-pr-preview.yml`](.github/workflows/deploy-pr-preview.yml)

Key workflow features:
- **Triggers**: `pull_request` with types `[opened, synchronize, reopened]`
- **Permissions**: `contents: read`, `pull-requests: write`
- **Node version**: 20 (configurable in workflow)
- **Comment management**: Smart update/create logic to avoid duplicate comments

#### Cleanup

PR preview deployments remain available after the PR is closed. To implement automatic cleanup when PRs are closed, consider adding a cleanup workflow that posts a comment notifying users that the preview is no longer maintained.

A cleanup workflow template will be added in a future update.

---

## 📢 Notifications (Slack & Microsoft Teams)

Want to get notified when Storybook previews are deployed? You can add Slack and/or Microsoft Teams notifications to your workflows.

### Overview

Notifications are added as extra steps in your GitHub Actions workflow. This approach gives you full control over the message format and when notifications are sent.

```
┌────────────────────────────────────────────────────────────────┐
│  GitHub Actions Workflow                                       │
│  ─────────────────────────────────────────────────────────────  │
│  1. Build Storybook                                            │
│  2. Deploy to Scry           ─────► deployment_url             │
│  3. Comment on PR (existing)                                   │
│  4. Notify Slack (optional)  ◄───── uses deployment_url        │
│  5. Notify Teams (optional)  ◄───── uses deployment_url        │
└────────────────────────────────────────────────────────────────┘
```

### Step 1: Create Webhooks

#### Slack Webhook Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name your app (e.g., "Scry Storybook") and select your workspace
3. Go to **Incoming Webhooks** (left sidebar) → Toggle **Activate Incoming Webhooks** to ON
4. Click **Add New Webhook to Workspace** → Select the channel for notifications
5. Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)

#### Microsoft Teams Webhook Setup

1. In Microsoft Teams, go to your channel
2. Click the **⋯** (more options) → **Connectors** (or **Workflows** in new Teams)
3. Search for **Incoming Webhook** → **Configure**
4. Name it (e.g., "Scry Storybook"), optionally upload an icon
5. Copy the webhook URL (starts with `https://outlook.office.com/webhook/...`)

### Step 2: Add Secrets to GitHub

Add your webhook URLs as GitHub Secrets:

```bash
# Using GitHub CLI
gh secret set SLACK_WEBHOOK_URL --body "https://hooks.slack.com/services/..."
gh secret set TEAMS_WEBHOOK_URL --body "https://outlook.office.com/webhook/..."
```

**Or via GitHub UI:**
1. Go to your repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add `SLACK_WEBHOOK_URL` and/or `TEAMS_WEBHOOK_URL`

### Step 3: Add Notification Steps to Workflow

Add these steps to your `.github/workflows/deploy-pr-preview.yml` file, **after** the "Deploy Preview" step:

#### Slack Notification

```yaml
      # Add this after the "Deploy Preview" step
      - name: Notify Slack
        if: success()
        uses: slackapi/slack-github-action@v1.26.0
        with:
          payload: |
            {
              "text": "🚀 Storybook Preview Ready",
              "blocks": [
                {
                  "type": "header",
                  "text": {
                    "type": "plain_text",
                    "text": "🚀 Storybook Preview Deployed"
                  }
                },
                {
                  "type": "section",
                  "fields": [
                    {
                      "type": "mrkdwn",
                      "text": "*PR:*\n<${{ github.event.pull_request.html_url }}|#${{ github.event.pull_request.number }}>"
                    },
                    {
                      "type": "mrkdwn",
                      "text": "*Author:*\n${{ github.event.pull_request.user.login }}"
                    },
                    {
                      "type": "mrkdwn",
                      "text": "*Branch:*\n`${{ github.head_ref }}`"
                    },
                    {
                      "type": "mrkdwn",
                      "text": "*Commit:*\n`${{ github.sha }}`"
                    }
                  ]
                },
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Title:* ${{ github.event.pull_request.title }}"
                  }
                },
                {
                  "type": "actions",
                  "elements": [
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "text": "📖 View Storybook"
                      },
                      "url": "${{ steps.deploy.outputs.deployment_url }}",
                      "style": "primary"
                    },
                    {
                      "type": "button",
                      "text": {
                        "type": "plain_text",
                        "text": "View PR"
                      },
                      "url": "${{ github.event.pull_request.html_url }}"
                    }
                  ]
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

#### Microsoft Teams Notification

```yaml
      # Add this after the "Deploy Preview" step
      - name: Notify Teams
        if: success()
        run: |
          curl -H "Content-Type: application/json" -d '{
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "themeColor": "0076D7",
            "summary": "Storybook Preview Deployed",
            "sections": [{
              "activityTitle": "🚀 Storybook Preview Deployed",
              "activitySubtitle": "PR #${{ github.event.pull_request.number }} by ${{ github.event.pull_request.user.login }}",
              "facts": [{
                "name": "Branch",
                "value": "${{ github.head_ref }}"
              }, {
                "name": "Commit",
                "value": "${{ github.sha }}"
              }, {
                "name": "Title",
                "value": "${{ github.event.pull_request.title }}"
              }],
              "markdown": true
            }],
            "potentialAction": [{
              "@type": "OpenUri",
              "name": "View Storybook",
              "targets": [{
                "os": "default",
                "uri": "${{ steps.deploy.outputs.deployment_url }}"
              }]
            }, {
              "@type": "OpenUri",
              "name": "View PR",
              "targets": [{
                "os": "default",
                "uri": "${{ github.event.pull_request.html_url }}"
              }]
            }]
          }' "${{ secrets.TEAMS_WEBHOOK_URL }}"
```

### Optional: Toggle Notifications with Variables

Use GitHub Variables to enable/disable notifications without editing the workflow:

```bash
# Enable notifications
gh variable set ENABLE_SLACK_NOTIFICATIONS --body "true"
gh variable set ENABLE_TEAMS_NOTIFICATIONS --body "true"
```

Then update the `if` condition in the notification steps:

```yaml
      - name: Notify Slack
        if: success() && vars.ENABLE_SLACK_NOTIFICATIONS == 'true'
        # ... rest of step
```

### Notification Variables Reference

| Name | Type | Description |
|------|------|-------------|
| `SLACK_WEBHOOK_URL` | Secret | Your Slack incoming webhook URL |
| `TEAMS_WEBHOOK_URL` | Secret | Your Microsoft Teams incoming webhook URL |
| `ENABLE_SLACK_NOTIFICATIONS` | Variable (optional) | Set to `true` to enable Slack notifications |
| `ENABLE_TEAMS_NOTIFICATIONS` | Variable (optional) | Set to `true` to enable Teams notifications |

### What the Notifications Look Like

**Slack:**
```
┌───────────────────────────────────────────────┐
│ 🚀 Storybook Preview Deployed                 │
├───────────────────────────────────────────────┤
│ PR:     #42           Author: @developer      │
│ Branch: feature/new   Commit: abc1234         │
├───────────────────────────────────────────────┤
│ Title: Add new button component               │
│                                               │
│ [📖 View Storybook]  [View PR]                │
└───────────────────────────────────────────────┘
```

**Teams:**
```
┌───────────────────────────────────────────────┐
│ 🚀 Storybook Preview Deployed                 │
│ PR #42 by developer                           │
├───────────────────────────────────────────────┤
│ Branch: feature/new-button                    │
│ Commit: abc1234                               │
│ Title:  Add new button component              │
├───────────────────────────────────────────────┤
│ [View Storybook]  [View PR]                   │
└───────────────────────────────────────────────┘
```

### Troubleshooting Notifications

**Problem: Slack notification fails with "channel_not_found"**
- Solution: Regenerate the webhook URL and ensure the Slack app is still installed in your workspace

**Problem: Teams notification shows as plain text**
- Solution: Ensure the webhook is an "Incoming Webhook" connector, not a Power Automate flow

**Problem: Notification doesn't include buttons**
- Solution: Some webhook configurations may not support interactive elements. The links will still appear as text.

---

## 📊 Error Reporting

When a deploy fails, this CLI reports the error to Scry so we can fix it. It runs on
your machine, so it is worth being precise about what leaves it.

**Sent:** the error and its stack trace, the CLI and Node versions, the platform, and
the project id, deploy version, branch and whether analysis was enabled.

**Not sent:** your API key, presigned upload URLs and their signatures, absolute file
paths, your hostname or username, your component names, and your source code. Stack
frames are reduced to file basenames, and anything resembling a credential is redacted
before the report is sent — including the signed URLs that upload errors would
otherwise quote in full.

Nothing is reported on a successful run.

Your own mistakes (a missing or wrong `--dir`, a folder with no images, a missing key or
env var) print a message and exit 1 but are not reported. Nothing is reported when
`NODE_ENV=test` or `CI` is set to a true value.

**To opt out**, set either variable:

```bash
export SCRY_TELEMETRY=0     # Scry-specific
export DO_NOT_TRACK=1       # respected across many CLI tools
```

Both are honoured everywhere.

## 🔧 Troubleshooting the Init Command

### Command fails with "Not a git repository"

**Solution:** Initialize git first:
```bash
git init
git remote add origin https://github.com/your-username/your-repo.git
```

### GitHub CLI setup fails

**Solution:** Install GitHub CLI and authenticate:
```bash
# macOS
brew install gh

# Linux
sudo apt install gh  # Ubuntu/Debian
sudo dnf install gh  # Fedora

# Windows
winget install --id GitHub.cli

# Then authenticate
gh auth login
```

Or skip GitHub CLI setup and set variables manually:
```bash
npx @scrymore/scry-deployer init --projectId xxx --apiKey yyy --skip-gh-setup
```

Then manually add variables in GitHub Settings → Secrets and variables → Actions.

### Git push fails with "Authentication failed"

**Solution:** Configure Git credentials:
```bash
# For HTTPS
gh auth setup-git

# Or use SSH
git remote set-url origin git@github.com:your-username/your-repo.git
```

### "No build command found" warning

**Solution:** Add a build script to your `package.json`:
```json
{
  "scripts": {
    "build-storybook": "storybook build"
  }
}
```

### Regenerate your workflows (`update-workflows`)

Workflows written by an older deployer can be missing the browser step or run an old
deployer. Refresh them from the current templates, without an API key:

```bash
npx -y @scrymore/scry-deployer@^0.7.0 update-workflows            # rewrite both files
npx -y @scrymore/scry-deployer@^0.7.0 update-workflows --commit   # and commit them
```

It detects your package manager from the lockfile and your Storybook build script from
`package.json`, and overwrites `.github/workflows/deploy-storybook.yml` and
`.github/workflows/deploy-pr-preview.yml`. Review the diff if you customised them.

### Want to customize the generated workflows?

After running `init`, you can edit:
- `.github/workflows/deploy-storybook.yml` - Main deployment
- `.github/workflows/deploy-pr-preview.yml` - PR previews

Then commit and push your changes:
```bash
git add .github/
git commit -m "Customize Storybook workflows"
git push
```

---

## 👩‍💻 Contributing & Development

We use [Changesets](https://github.com/changesets/changesets) for version management and releases.

### Development Workflow

```bash
# 1. Create a feature branch
git checkout main && git pull
git checkout -b feature/my-new-feature

# 2. Make your changes
# ... edit files ...

# 3. Create a changeset (if your changes should be released)
pnpm changeset
# Select @scrymore/scry-deployer
# Choose: patch (bug fix), minor (feature), major (breaking)
# Write a description of your changes

# 4. Commit everything
git add .
git commit -m "feat: add new feature"

# 5. Push and create a PR
git push -u origin HEAD
```

### When to Create a Changeset

| Change Type | Changeset? | Version Bump |
|-------------|------------|--------------|
| Bug fix | ✅ Yes | `patch` (0.0.1 → 0.0.2) |
| New feature | ✅ Yes | `minor` (0.0.2 → 0.1.0) |
| Breaking change | ✅ Yes | `major` (0.1.0 → 1.0.0) |
| Documentation only | ❌ No | - |
| CI/workflow changes | ❌ No | - |

### Release Process

1. **Merge PR to main** → Release workflow runs
2. **Changesets bot creates "Version Packages" PR** → Updates version + CHANGELOG
3. **Merge Version PR** → Publishes to npm automatically

### Installing Development Versions

```bash
# Stable release (recommended)
npm install @scrymore/scry-deployer

# Nightly release (latest from main, published daily)
npm install @scrymore/scry-deployer@nightly
```

### Snapshot channels

Pushes to `stage` publish `@scrymore/scry-deployer@next`. The daily schedule
publishes `@nightly` from `main`; manual runs select the channel from the chosen
branch (`stage` → `next`, `main` → `nightly`). Other branches cannot publish.
Stable releases from `main` still use the existing Changesets release PR and
`latest` channel.

```bash
npm install --save-dev @scrymore/scry-deployer@next
```

The channel moves with each snapshot; pin the resolved prerelease version for a
reproducible build. Snapshots use a temporary patch changeset even when no release
changesets remain, and never commit generated versions or create Git tags. Runs
are serialized per branch and verify the prerelease suffix before publishing.

After merging this CI change, create `stage` from `main`. Both channels use the
existing repository `NPM_TOKEN` secret via setup-node's `NODE_AUTH_TOKEN`; it must
have npm publish permission for this package. No additional secret is required.
If GitHub has disabled the scheduled workflow for inactivity, re-enable
**Snapshot Release** in Actions. No npm dist-tag needs to be created manually.

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed contribution guidelines.

---

## 🆘 Support

Need help?
- 📖 [Documentation](https://github.com/scryorg/scry-node)
- 🐛 [Report an issue](https://github.com/scryorg/scry-node/issues)
- 💬 [Discussions](https://github.com/scryorg/scry-node/discussions)
