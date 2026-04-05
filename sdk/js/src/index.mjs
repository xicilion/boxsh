/**
 * @boxsh/sdk — public API
 */

// Core RPC client
export { BoxshClient, shellQuote } from './client.mjs';

// Change detection (diff upper vs base on the host filesystem)
export { getChanges, formatChanges } from './changes.mjs';

/**
 * Create a BashOperations adapter backed by BoxshClient.
 * If the boxsh binary is unavailable, returns the provided fallback.
 *
 * @param {object}  [options]
 * @param {boolean} [options.sandbox]  Enable sandbox (default: true)
 * @param {object}  [options.fallback] Fallback BashOperations when boxsh is not found
 * @returns {object} BashOperations-compatible object
 */
export function createBashOperations(options = {}) {
    const { sandbox = true, fallback } = options;
    let client;
    try {
        client = new BoxshClient({ sandbox });
    } catch {
        if (fallback) {
            console.warn('[boxsh] binary not available, using fallback');
            return fallback;
        }
        throw new Error('boxsh binary not found and no fallback provided');
    }

    return {
        async exec(command, cwd, { onData, signal, timeout } = {}) {
            if (signal?.aborted) throw new Error('aborted');

            const result = await client.exec(command, cwd, timeout);

            const output = result.stdout + result.stderr;
            if (output && onData) {
                onData(Buffer.from(output));
            }

            return { exitCode: result.exitCode };
        },
    };
}
