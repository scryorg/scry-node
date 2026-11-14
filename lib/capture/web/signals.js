/**
 * Ctrl-C and SIGTERM during a capture: close what the run started (browser, dev server), then
 * exit with the conventional code. A second signal exits at once.
 */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
/** How long the clean-up may take before the process exits anyway. */
const CLEANUP_TIMEOUT_MS = 5000;

/**
 * @param {(signal: string) => Promise<void>} cleanup
 * @param {{on: Function, removeListener: Function, exit: Function}} [proc]
 * @returns {() => void} removes the handlers
 */
function onSignals(cleanup, proc = process) {
    let stopping = false;
    const handlers = {};
    for (const [signal, code] of Object.entries(EXIT_CODES)) {
        handlers[signal] = () => {
            if (stopping) {
                proc.exit(code);
                return;
            }
            stopping = true;
            const timer = setTimeout(() => proc.exit(code), CLEANUP_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
            Promise.resolve()
                .then(() => cleanup(signal))
                .catch(() => {})
                .then(() => {
                    clearTimeout(timer);
                    proc.exit(code);
                });
        };
        proc.on(signal, handlers[signal]);
    }
    return () => {
        for (const [signal, handler] of Object.entries(handlers)) proc.removeListener(signal, handler);
    };
}

module.exports = { onSignals, EXIT_CODES };
