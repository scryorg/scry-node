const Sentry = require('@sentry/node');

/**
 * Error reporting for a CLI that runs on other people's machines.
 *
 * This is not a server. Everything it sends left a customer's laptop or CI
 * runner, so the default has to be "send the minimum that makes a crash
 * diagnosable", not "send the context and sort it out later".
 *
 * Three things were being sent that should not have been:
 *
 *   1. `scope.setExtra('argv', argv)` shipped the whole parsed argv — which
 *      contains `--api-key` under both `apiKey` and `api-key`. Every customer
 *      error carried their project credential to a third party.
 *   2. Upload failures embed the presigned URL in the message, query string and
 *      all: `...storybook.zip?X-Amz-Signature=645e57...`. That signature is a
 *      time-limited write credential for the bucket.
 *   3. Absolute paths (`/home/alice/work/app`) leak usernames and, often,
 *      unreleased product names.
 *
 * None of that is needed to know that an upload failed with EAI_AGAIN.
 */

const { version: PACKAGE_VERSION } = require('../package.json');
const { UserInputError } = require('./errors.js');

const DSN =
  'https://c66ce229a1db2289f145eebd02436d9c@o4507889391828992.ingest.us.sentry.io/4510699330732032';

/**
 * argv fields safe to attach to an error.
 *
 * An allowlist, not a denylist: a new option should be invisible to telemetry
 * until someone deliberately adds it here. The reverse — remembering to exclude
 * each new secret — is the failure mode that put an API key in Sentry.
 */
const SAFE_ARGV_FIELDS = ['project', 'deployVersion', 'withAnalysis', 'verbose', 'branch'];

/** Anything that looks like a credential, wherever it appears in a string. */
const SECRET_PATTERNS = [
  // Presigned URL query strings. Keep the path so the failing operation is
  // still identifiable; drop the signature and everything with it.
  [/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?<redacted>'],
  // Local absolute paths (POSIX home/temp/volume roots, Windows drives, ~/): they carry user names,
  // client folder names and picture file names (scry import).
  [/(?<![\w:/.~-])\/(?:Users|home|root|var|tmp|private|mnt|Volumes|media|opt|srv|run|etc|usr|proc|data|workspace)\/[^\s"'<>`]*/g, '<path>'],
  [/(?<!\w)[A-Za-z]:\\[^\s"'<>`]*/g, '<path>'],
  [/(?<!\w)~\/[^\s"'<>`]*/g, '<path>'],
  [/scry_proj_[A-Za-z0-9_\-]+/g, 'scry_proj_<redacted>'],
  [/(X-Amz-Signature=)[^&\s]+/gi, '$1<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>'],
  // A credential flag echoed on a command line: --api-key X, --api-key=X,
  // -k X, --token X, --openai-api-key X, ...
  [/(--[\w-]*(?:api-key|apikey|token|secret|password)[\w-]*[=\s]+|(?:^|\s)-k[=\s]+)(?!<redacted>)[^\s"',]+/gi, '$1<redacted>'],
  // A credential field inside serialized JSON: "apiKey":"X", "token": "X".
  [/("[\w-]*(?:api[-_]?key|token|secret|password)[\w-]*"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"'],
  // An env echo: SCRY_API_KEY=X, STORYBOOK_DEPLOYER_API_KEY=X, JINA_API_KEY=X.
  [/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)(?!<redacted>)[^\s"',]+/g, '$1<redacted>'],
];

/** Field names whose values are credentials, in any spelling yargs produces. */
const SECRET_FIELD = /(^k$|api[-_]?key|token|secret|password)/i;

/**
 * A copy of argv with every credential-named field masked, at any depth.
 *
 * For logging argv whole (the --verbose "Received arguments" line), which is
 * also a Sentry breadcrumb. Unlike sanitizeArgv this keeps every field, so it
 * must only be used for local diagnostics, never as event context.
 */
function redactArgv(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactArgv(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) && v !== undefined && v !== null && v !== '' ? '<redacted>' : redactArgv(v, depth + 1);
  }
  return out;
}

/** Scrub every string in a JSON-like value (breadcrumb data), in place-safe copy. */
function scrubDeep(value, depth = 0) {
  if (typeof value === 'string') return scrub(value);
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_FIELD.test(k) && typeof v === 'string' && v ? '<redacted>' : scrubDeep(v, depth + 1);
  }
  return out;
}

/**
 * Breadcrumbs are sent with every event and beforeSend does not see them as
 * separate items, so they get the same scrubbing on the way in.
 */
function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb) return breadcrumb;
  if (breadcrumb.message) breadcrumb.message = scrub(breadcrumb.message);
  if (breadcrumb.data) breadcrumb.data = scrubDeep(breadcrumb.data);
  return breadcrumb;
}

function scrub(value) {
  if (typeof value !== 'string') return value;
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value);
}

/**
 * Whether the user has asked not to be tracked.
 *
 * DO_NOT_TRACK is honoured as well as our own flag — it is the cross-tool
 * convention (consoledonottrack.com), and a developer who has set it globally
 * should not have to discover a Scry-specific variable to be heard.
 */
function telemetryDisabled() {
  const off = (v) => v === '1' || v === 'true' || v === 'yes';
  return off(process.env.DO_NOT_TRACK) || process.env.SCRY_TELEMETRY === '0' ||
    process.env.SCRY_TELEMETRY === 'false' || isAutomatedRun();
}

/**
 * A test run or a CI job: failures there are expected and routine (our own
 * suites run the real CLI against deliberately broken input, and a CI job
 * retries), so they never use error-reporting quota. `CI` counts when it is
 * set to anything but an explicit false value.
 */
function isAutomatedRun() {
  const ci = process.env.CI;
  const ciOn = ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
  return process.env.NODE_ENV === 'test' || ciOn;
}

/** Only the fields on the allowlist, and scrubbed even then. */
function sanitizeArgv(argv) {
  if (!argv) return {};
  const safe = {};
  for (const field of SAFE_ARGV_FIELDS) {
    if (argv[field] !== undefined) safe[field] = scrub(argv[field]);
  }
  return safe;
}

function initTelemetry() {
  if (telemetryDisabled()) return false;

  Sentry.init({
    dsn: DSN,
    // Never claim production for a run we cannot place: unset means development.
    environment: process.env.NODE_ENV || 'development',
    // Which published deployer produced the event, so a fix can be matched to
    // the versions still in the wild.
    release: `@scrymore/scry-deployer@${PACKAGE_VERSION}`,

    // Errors only. Traces from a CLI describe the customer's build pipeline,
    // which is more than is needed to fix a crash.
    tracesSampleRate: 0,

    // No usernames, IPs, or machine hostnames.
    sendDefaultPii: false,
    serverName: false,

    // The logger turns every line (including debug) into a breadcrumb, and
    // Sentry's console integration does the same for console.*. None of that
    // passed through beforeSend's scrubbing before.
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },

    beforeSend(event) {
      if (event.message) event.message = scrub(event.message);
      // Belt and braces for breadcrumbs added before init or by integrations
      // that bypass beforeBreadcrumb.
      if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

      for (const entry of event.exception?.values ?? []) {
        if (entry.value) entry.value = scrub(entry.value);
        // Stack frames carry absolute paths from the customer's disk. The
        // filename is what makes a trace useful, so keep the basename only.
        for (const frame of entry.stacktrace?.frames ?? []) {
          if (frame.filename) frame.filename = frame.filename.replace(/^.*[\\/]/, '');
          delete frame.abs_path;
        }
      }

      // Belt and braces: whatever else ends up in extra, scrub its strings.
      if (event.extra) {
        for (const [k, v] of Object.entries(event.extra)) event.extra[k] = scrub(v);
      }

      return event;
    },
  });

  return true;
}

/** Report an error with only the context that is safe to leave the machine. */
function captureCliError(error, argv) {
  if (telemetryDisabled()) return;
  // Second line of defence behind handleError: a user's own mistake is never reported.
  if (error instanceof UserInputError) return;

  Sentry.withScope((scope) => {
    const safe = sanitizeArgv(argv);
    if (safe.project) scope.setTag('project', safe.project);
    if (argv && argv._) scope.setTag('command', argv._[0] || 'deploy');
    // The server-issued id is an opaque ULID/uuid: safe as a tag, and lets an
    // event be matched to the server-side trail.
    if (typeof error?.requestId === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(error.requestId)) {
      scope.setTag('request_id', error.requestId);
    }
    scope.setExtra('options', safe);
    Sentry.captureException(error);
  });
}

async function flushTelemetry(ms = 2000) {
  if (telemetryDisabled()) return;
  await Sentry.close(ms);
}

module.exports = {
  initTelemetry,
  captureCliError,
  flushTelemetry,
  telemetryDisabled,
  isAutomatedRun,
  sanitizeArgv,
  redactArgv,
  scrub,
  scrubBreadcrumb,
  SAFE_ARGV_FIELDS,
};
