const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { startTimer } = require('./ciTimings.js');
const { deltaEnabled } = require('./deltaUpload.js');

/**
 * @typedef {Object} RunCoverageOptions
 * @property {string} storybookDir Path to a built Storybook static directory (e.g. ./storybook-static)
 * @property {string} [baseBranch='main'] Base branch name to compare for "new code" analysis
 * @property {boolean} [failOnThreshold=false] If true, pass "--ci" to the coverage tool and rethrow errors
 * @property {string} [outputPath] If provided, write the report to this path (relative to cwd allowed)
 * @property {boolean} [keepReport=false] If true, do not delete the output file after reading
 * @property {boolean} [screenshots=false] Enable passing-story screenshots in scry-sbcov
 * @property {string|null} [outputZipPath=null] Where to write metadata+screenshots ZIP
 * @property {'root'|'viewport'} [captureMode] Screenshot framing forwarded as --capture-mode
 * @property {number|string} [captureScale] Device scale factor (0 < n <= 4) forwarded as --capture-scale
 * @property {string|{width:number,height:number}} [captureViewport] "WxH" or {width,height}, forwarded as --capture-viewport
 * @property {number|string} [concurrency] Stories rendered at once, forwarded as --concurrency (sbcov 0.7+; unset: sbcov default 4)
 * @property {number|string} [renderTimeoutMs] How long a story may take to show something, forwarded as --render-timeout (sbcov 0.7+; unset: sbcov default 5000)
 * @property {number|string} [maxDropped] Forwarded as --max-dropped: sbcov exits 3 when more stories than this were dropped.
 *   Unset: with screenshots on, the deployer passes --max-dropped 0 (any dropped story ends the
 *   deploy red, after the rest are uploaded) when the installed scry-sbcov supports the flag.
 */

/**
 * What a non-zero scry-sbcov exit means. The contract with scry-sbcov (#51):
 * 2 = the capture config is broken, misspelt or unknown and no archive was
 * written; 3 = more stories were dropped than --max-dropped allows, and the
 * archive of the stories that did capture WAS written.
 *
 * @param {number|null} code
 * @param {string|null} signal
 * @returns {string}
 */
function describeSbcovExit(code, signal) {
  if (code === 2) return 'scry-sbcov rejected the capture config (exit 2)';
  if (code === 3) return 'scry-sbcov dropped more stories than --max-dropped allows (exit 3)';
  if (signal) return `scry-sbcov was killed by ${signal}`;
  if (code === 127) return 'scry-sbcov could not be started (exit 127, command not found)';
  if (code === null || code === undefined) return 'scry-sbcov could not be run';
  return `scry-sbcov exited with code ${code}`;
}

const CAPTURE_MODES = ['root', 'viewport'];

/**
 * Turn a project's capture settings into scry-sbcov flags.
 *
 * Only settings the project actually set are forwarded: an unset value is left
 * to scry-sbcov, so its own defaults and any scry-sbcov.config.* in the project
 * still apply. Every value is validated to a fixed shape (enum, bounded number,
 * WxH integers) before it gets near a shell command; anything else throws.
 *
 * @param {{captureMode?:any, captureScale?:any, captureViewport?:any}} [settings]
 * @returns {string[]}
 */
function buildCaptureArgs(settings = {}) {
  const { captureMode, captureScale, captureViewport } = settings || {};
  const args = [];
  const isSet = (v) => v !== undefined && v !== null && v !== '';

  if (isSet(captureMode)) {
    if (typeof captureMode !== 'string' || !CAPTURE_MODES.includes(captureMode)) {
      throw new Error(`Invalid captureMode ${JSON.stringify(captureMode)}: expected "root" or "viewport"`);
    }
    args.push('--capture-mode', captureMode);
  }

  if (isSet(captureScale)) {
    const text = String(captureScale).trim();
    const n = Number(text);
    if (!/^\d+(\.\d+)?$/.test(text) || !(n > 0) || n > 4) {
      throw new Error(`Invalid captureScale ${JSON.stringify(captureScale)}: expected a number in (0, 4]`);
    }
    args.push('--capture-scale', String(n));
  }

  if (isSet(captureViewport)) {
    let width;
    let height;
    if (typeof captureViewport === 'string') {
      const m = /^\s*(\d{1,5})\s*[xX]\s*(\d{1,5})\s*$/.exec(captureViewport);
      if (m) {
        width = Number(m[1]);
        height = Number(m[2]);
      }
    } else if (typeof captureViewport === 'object') {
      width = captureViewport.width;
      height = captureViewport.height;
    }
    const ok = (v) => Number.isInteger(v) && v >= 1 && v <= 10000;
    if (!ok(width) || !ok(height)) {
      throw new Error(`Invalid captureViewport ${JSON.stringify(captureViewport)}: expected "WIDTHxHEIGHT" or { width, height } in whole CSS px`);
    }
    args.push('--capture-viewport', `${width}x${height}`);
  }

  return args;
}

/**
 * Run Storybook coverage analysis via `@scrymore/scry-sbcov`.
 *
 * Behavior:
 * - Writes a temporary report file in the current working directory
 * - Executes the `@scrymore/scry-sbcov` CLI
 * - Reads and returns the parsed JSON report
 * - Deletes the temporary report file
 *
 * If the underlying tool exits non-zero it is no longer swallowed: the result
 * carries `sbcovFailure: {exitCode, signal, reason}`, plus whatever report and
 * archive sbcov did write (exit 3 writes both). The caller decides the exit
 * code. With `failOnThreshold` a failure other than exit 3 is rethrown, as
 * before.
 *
 * @param {RunCoverageOptions} options
 * @returns {Promise<{report:any|null, metadataZipPath:string|null, sbcovFailure:null|{exitCode:number|null, signal:string|null, reason:string}, effectiveMaxDropped:number|null, maxDroppedUnsupported:boolean}>}
 */
async function runCoverageAnalysis(options) {
  const {
    storybookDir,
    baseBranch = 'main',
    failOnThreshold = false,
    execute = false,
    outputPath: providedOutputPath,
    keepReport = false,
    screenshots = false,
    outputZipPath = null,
    captureMode,
    captureScale,
    captureViewport,
    concurrency,
    renderTimeoutMs,
    maxDropped,
  } = options || {};

  if (!storybookDir || typeof storybookDir !== 'string') {
    throw new Error('runCoverageAnalysis: options.storybookDir is required');
  }

  // Validate before doing anything: a bad explicit setting should fail loudly,
  // not be swallowed by the failOnThreshold=false path below.
  const captureArgs = buildCaptureArgs({ captureMode, captureScale, captureViewport });
  // Validated up front; the default (0) is decided below, once the command is known.
  const userMaxDroppedArgs = buildMaxDroppedArgs(maxDropped);
  const executionArgs = buildExecutionArgs({ concurrency, renderTimeoutMs });

  console.log(chalk.blue('Running Storybook coverage analysis...'));

  const outputPath = providedOutputPath
    ? (path.isAbsolute(providedOutputPath) ? providedOutputPath : path.resolve(process.cwd(), providedOutputPath))
    : path.join(process.cwd(), `.scry-coverage-report-${Date.now()}.json`);

  const resolvedBaseRef = resolveCoverageBaseRef(baseBranch);

  /** @type {string[]} */
  const cliArgs = [
    '--storybook-static',
    storybookDir,
    '--output',
    outputPath,
    '--base',
    normalizeGitBaseRef(resolvedBaseRef),
    '--verbose', // Enable verbose logging to debug component detection
  ];

  if (failOnThreshold) {
    cliArgs.push('--ci');
  }

  if (execute || screenshots) {
    cliArgs.push('--execute');
  }
  if (screenshots) {
    cliArgs.push('--screenshots');
    if (outputZipPath) {
      cliArgs.push('--output-zip', outputZipPath);
    }
  }
  cliArgs.push(...captureArgs);

  // Allow local override for E2E testing before package publication.
  // Example:
  //   SCRY_SBCOV_CMD="node /abs/path/to/scry-sbcov/dist/cli/index.js"
  //
  // Default: resolve the CLI from the installed dependency to avoid npx cache
  // issues where `npx -y` might resolve a stale older version.
  let defaultSbcovCmd = 'npx -y @scrymore/scry-sbcov';
  try {
    const sbcovCli = require.resolve('@scrymore/scry-sbcov/dist/cli/index.js');
    defaultSbcovCmd = `node ${shellEscape(sbcovCli)}`;
  } catch (error) {
    // Fall back to npx if resolve fails (e.g. not installed as dependency)
    if (error.code !== 'MODULE_NOT_FOUND') {
      console.warn('[scry-deployer] Unexpected error resolving @scrymore/scry-sbcov, falling back to npx:', error);
    }
  }
  const sbcovCommandPrefix = (process.env.SCRY_SBCOV_CMD || defaultSbcovCmd).trim();

  // --max-dropped. The user's value is forwarded as given. Unset, and capturing
  // screenshots, the deployer asks for 0 — any story that fails to capture ends
  // the deploy red after the rest are uploaded — because scry-sbcov itself only
  // exits 3 when the flag is passed. A scry-sbcov too old to know the flag
  // would reject it and capture nothing, so it is only sent when --help lists
  // it; otherwise the result says so and the caller warns.
  let effectiveMaxDropped = userMaxDroppedArgs.length ? Number(userMaxDroppedArgs[1]) : null;
  let maxDroppedUnsupported = false;
  if (userMaxDroppedArgs.length) {
    // The user's value, but only to an sbcov that knows the flag: an older one
    // rejects it, captures nothing, and the run would end red for the wrong
    // reason. The caller warns that it could not be applied.
    if (sbcovSupportsMaxDropped(sbcovCommandPrefix)) {
      cliArgs.push(...userMaxDroppedArgs);
    } else {
      maxDroppedUnsupported = true;
    }
  } else if (screenshots) {
    effectiveMaxDropped = 0;
    if (sbcovSupportsMaxDropped(sbcovCommandPrefix)) {
      cliArgs.push('--max-dropped', '0');
    } else {
      maxDroppedUnsupported = true;
    }
  }

  // --concurrency / --render-timeout (sbcov 0.7+), forwarded only to an sbcov
  // that lists them: an older one rejects an unknown option and captures
  // nothing. What could not be applied is returned for the caller to say.
  /** @type {string[]} */
  const executionUnsupported = [];
  // Without execution the settings have nothing to act on.
  for (let i = 0; (execute || screenshots) && i < executionArgs.length; i += 2) {
    if (sbcovSupportsFlag(sbcovCommandPrefix, executionArgs[i])) {
      cliArgs.push(executionArgs[i], executionArgs[i + 1]);
    } else {
      executionUnsupported.push(executionArgs[i]);
    }
  }

  // --delta-manifest (sbcov 0.9+): also write the delta bundle (manifest + pictures) beside the
  // metadata ZIP for the manifest-first upload. sbcov writes it by default, so with SCRY_DELTA=0
  // (the ZIP is all that is sent) ask it not to. Only to an sbcov that lists the flag.
  if (screenshots && outputZipPath && sbcovSupportsFlag(sbcovCommandPrefix, '--delta-manifest')) {
    cliArgs.push(deltaEnabled() ? '--delta-manifest' : '--no-delta-manifest');
  }

  const npxCommand = `${sbcovCommandPrefix} ${cliArgs.map(shellEscape).join(' ')}`;

  // Debug logging to show the exact command being executed
  console.log(chalk.yellow('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('DEBUG: Executing coverage command:'));
  console.log(chalk.gray(npxCommand));
  console.log(chalk.yellow('Working directory: ' + process.cwd()));
  console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Wall time of the sbcov process (analysis + execution), from a monotonic
  // clock; null when it never started. Used for the CI timings record.
  let sbcovStarted = null;
  let sbcovWallMs = null;
  // `executed`: stories were asked to run AND sbcov produced a report (exit 0
  // or 3). A crashed or missing sbcov ran no stories, so its wall time is not
  // an execute time (review should-fix 2).
  let producedReport = false;
  const extras = () => ({ sbcovWallMs, executionUnsupported, executed: Boolean((execute || screenshots) && producedReport) });

  try {
    // Determine the correct working directory
    // If storybookDir is relative, resolve it from cwd
    // Then use its parent directory as the project root
    const absoluteStorybookDir = path.isAbsolute(storybookDir)
      ? storybookDir
      : path.resolve(process.cwd(), storybookDir);
    
    const projectRoot = path.dirname(absoluteStorybookDir);
    
    console.log(chalk.yellow('Project root: ' + projectRoot));
    console.log(chalk.yellow('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    sbcovStarted = startTimer();
    execSync(npxCommand, {
      stdio: 'inherit',
      cwd: projectRoot // Run from the project root, not scry-node directory
    });
    sbcovWallMs = sbcovStarted.stop();

    const report = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    producedReport = true;
    const metadataZipPath = existingZip(screenshots, outputZipPath);

    if (!keepReport && !providedOutputPath) safeUnlink(outputPath);
    return { report, metadataZipPath, sbcovFailure: null, effectiveMaxDropped, maxDroppedUnsupported, ...extras() };
  } catch (error) {
    if (sbcovStarted !== null && sbcovWallMs === null) sbcovWallMs = sbcovStarted.stop();
    const exitCode = typeof error.status === 'number' ? error.status : null;
    const signal = error.signal || null;
    // A throw with no exit status is not sbcov's verdict: the command never
    // ran, or its report could not be read after a zero exit.
    const reason = (exitCode === null && !signal)
      ? `${describeSbcovExit(null, null)}: ${error.message}`
      : describeSbcovExit(exitCode, signal);

    // Exit 3 writes the report and the archive of the stories that captured;
    // keep both so they can still be uploaded and indexed. Any other failure
    // promises no complete archive, so a leftover one is removed, never sent.
    const report = readReportIfPresent(outputPath);
    producedReport = report !== null;
    let metadataZipPath = null;
    if (exitCode === 3) {
      metadataZipPath = existingZip(screenshots, outputZipPath);
    } else if (outputZipPath) {
      safeUnlink(outputZipPath);
    }

    if (!keepReport && !providedOutputPath) safeUnlink(outputPath);
    if (failOnThreshold && exitCode !== 3) throw error;

    console.error(chalk.red(`Coverage: ${reason}`));
    return {
      report,
      metadataZipPath,
      sbcovFailure: { exitCode, signal, reason },
      effectiveMaxDropped,
      maxDroppedUnsupported,
      ...extras(),
    };
  }
}

function existingZip(screenshots, outputZipPath) {
  return (screenshots && outputZipPath && fs.existsSync(outputZipPath)) ? outputZipPath : null;
}

function readReportIfPresent(outputPath) {
  try {
    if (!fs.existsSync(outputPath)) return null;
    return JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  } catch (_) {
    // A half-written report is no report; the failure itself is already
    // carried in sbcovFailure.
    return null;
  }
}

const sbcovHelp = new Map();

/**
 * This scry-sbcov command's --help text, cached per command for the life of
 * the process. Any failure to ask = '' (no optional flag is judged supported).
 *
 * @param {string} commandPrefix
 * @returns {string}
 */
function sbcovHelpText(commandPrefix) {
  if (sbcovHelp.has(commandPrefix)) return sbcovHelp.get(commandPrefix);
  let out = '';
  try {
    out = execSync(`${commandPrefix} --help`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (_) {
    // An sbcov whose --help fails is judged unable to take optional flags;
    // the caller prints what could not be applied.
    out = '';
  }
  sbcovHelp.set(commandPrefix, out);
  return out;
}

/**
 * Whether this scry-sbcov command knows --max-dropped (0.5.2+), from its --help.
 *
 * @param {string} commandPrefix
 * @returns {boolean}
 */
function sbcovSupportsMaxDropped(commandPrefix) {
  return /--max-dropped\b/.test(sbcovHelpText(commandPrefix));
}

/**
 * Whether this scry-sbcov command knows a flag, from its --help.
 *
 * @param {string} commandPrefix
 * @param {string} flag e.g. '--concurrency'
 * @returns {boolean}
 */
function sbcovSupportsFlag(commandPrefix, flag) {
  return new RegExp(`${flag.replace(/[-]/g, '\\-')}\\b`).test(sbcovHelpText(commandPrefix));
}

/**
 * --max-dropped for scry-sbcov: a whole number of stories, 0 or more.
 *
 * @param {any} maxDropped
 * @returns {string[]}
 */
function buildMaxDroppedArgs(maxDropped) {
  if (maxDropped === undefined || maxDropped === null || maxDropped === '') return [];
  const text = String(maxDropped).trim();
  if (!/^\d{1,9}$/.test(text)) {
    throw new Error(`Invalid maxDropped ${JSON.stringify(maxDropped)}: expected a whole number of stories, 0 or more`);
  }
  return ['--max-dropped', String(Number(text))];
}

/**
 * --concurrency / --render-timeout for scry-sbcov 0.7+ (storybook-preview-ci-runtime).
 * Only settings that were set are returned; each is validated to a bounded
 * whole number before it gets near a shell command, and anything else throws.
 *
 * @param {{concurrency?:any, renderTimeoutMs?:any}} [settings]
 * @returns {string[]}
 */
function buildExecutionArgs(settings = {}) {
  const { concurrency, renderTimeoutMs } = settings || {};
  const isSet = (v) => v !== undefined && v !== null && v !== '';
  const args = [];
  if (isSet(concurrency)) {
    const text = String(concurrency).trim();
    const n = Number(text);
    if (!/^\d{1,2}$/.test(text) || n < 1 || n > 32) {
      throw new Error(`Invalid concurrency ${JSON.stringify(concurrency)} (SCRY_CONCURRENCY): expected a whole number of stories from 1 to 32`);
    }
    args.push('--concurrency', String(n));
  }
  if (isSet(renderTimeoutMs)) {
    const text = String(renderTimeoutMs).trim();
    const n = Number(text);
    if (!/^\d{1,6}$/.test(text) || n < 100 || n > 600000) {
      throw new Error(`Invalid renderTimeoutMs ${JSON.stringify(renderTimeoutMs)} (SCRY_RENDER_TIMEOUT_MS): expected whole milliseconds from 100 to 600000`);
    }
    args.push('--render-timeout', String(n));
  }
  return args;
}

/**
 * Load a coverage report from disk.
 *
 * @param {string} reportPath
 * @returns {any}
 */
function loadCoverageReport(reportPath) {
  if (!reportPath || typeof reportPath !== 'string') {
    throw new Error('loadCoverageReport: reportPath is required');
  }
  const raw = fs.readFileSync(reportPath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Extracts a stable, API-friendly subset of the full report.
 *
 * NOTE: This function is intentionally defensive: if the report shape changes,
 * we return `null` instead of throwing to avoid breaking deployments.
 *
 * @param {any|null} report
 * @returns {null|{
 *   reportUrl: string|null,
 *   summary: {
 *     componentCoverage: number,
 *     propCoverage: number,
 *     variantCoverage: number,
 *     passRate: number,
 *     totalComponents: number,
 *     componentsWithStories: number,
 *     failingStories: number
 *   },
 *   qualityGate: any,
 *   generatedAt: string
 * }}
 */
function extractCoverageSummary(report) {
  if (!report) return null;

  try {
    return {
      reportUrl: null,
      summary: {
        componentCoverage: report.summary.metrics.componentCoverage,
        propCoverage: report.summary.metrics.propCoverage,
        variantCoverage: report.summary.metrics.variantCoverage,
        passRate: report.summary.health.passRate,
        totalComponents: report.summary.totalComponents,
        componentsWithStories: report.summary.componentsWithStories,
        failingStories: report.summary.health.failingStories,
      },
      qualityGate: report.qualityGate,
      generatedAt: report.generatedAt,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Best-effort deletion: ignore ENOENT and other fs errors.
 *
 * @param {string} filePath
 */
function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // ignore
  }
}

/**
 * Minimal shell escaping for arguments.
 *
 * @param {string} value
 * @returns {string}
 */
function shellEscape(value) {
  if (typeof value !== 'string') return '';
  if (/^[a-zA-Z0-9_\-./:@]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}



/**
 * Normalize a user-supplied base ref into something git understands.
 *
 * Why this exists:
 * - In CI, the best base for "push" is often a SHA (e.g. github.event.before)
 * - In PRs, the best base is often a remote-tracking branch (e.g. origin/main)
 * - Locally, users may pass branch names (e.g. main) or rev expressions (e.g. HEAD~1)
 *
 * `scry-sbcov` expects a value it can pass to git commands as the base reference.
 *
 * @param {string} baseBranch
 * @returns {string}
 */
function normalizeGitBaseRef(baseBranch) {
  const value = (baseBranch || '').trim();

  if (!value) return 'origin/main';

  // Commit SHA (short or full)
  if (/^[0-9a-f]{7,40}$/i.test(value)) return value;

  // Common rev expressions that should not be prefixed.
  if (value === 'HEAD' || value.startsWith('HEAD~') || value.startsWith('HEAD^')) return value;
  if (/[~^]/.test(value)) return value;

  // If user already provided a qualified ref, use it as-is.
  if (value.startsWith('origin/')) return value;
  if (value.startsWith('refs/')) return value;
  if (value.startsWith('remotes/')) return value;

  // Otherwise, treat it as a branch name and compare against the remote.
  // This also works for branch names that contain slashes (e.g. feature/foo).
  return `origin/${value}`;
}

/**
 * Resolve the base ref to pass into `scry-sbcov`, preferring PR base SHAs
 * from CI providers when available.
 *
 * @param {string} baseBranch
 * @returns {string}
 */
function resolveCoverageBaseRef(baseBranch) {
  const env = process.env || {};

  const githubBaseSha = readGithubPullRequestBaseSha(env.GITHUB_EVENT_PATH);
  if (githubBaseSha) return githubBaseSha;

  const gitlabBaseSha = env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA;
  if (gitlabBaseSha) return gitlabBaseSha;

  const bitbucketBaseSha = env.BITBUCKET_PR_DESTINATION_COMMIT || env.BITBUCKET_PR_BASE_COMMIT;
  if (bitbucketBaseSha) return bitbucketBaseSha;

  return baseBranch || 'main';
}

/**
 * Read GitHub pull_request base.sha from the event payload.
 *
 * @param {string|undefined} eventPath
 * @returns {string|null}
 */
function readGithubPullRequestBaseSha(eventPath) {
  if (!eventPath || typeof eventPath !== 'string') return null;

  try {
    if (!fs.existsSync(eventPath)) return null;
    const raw = fs.readFileSync(eventPath, 'utf-8');
    const payload = JSON.parse(raw);
    const baseSha = payload?.pull_request?.base?.sha;
    if (typeof baseSha === 'string' && baseSha.trim()) return baseSha.trim();
    return null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  runCoverageAnalysis,
  buildCaptureArgs,
  buildMaxDroppedArgs,
  buildExecutionArgs,
  describeSbcovExit,
  sbcovSupportsMaxDropped,
  sbcovSupportsFlag,
  loadCoverageReport,
  extractCoverageSummary,
  normalizeGitBaseRef,
  resolveCoverageBaseRef,
  readGithubPullRequestBaseSha,
};
