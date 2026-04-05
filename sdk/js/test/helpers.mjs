/**
 * Shared test helpers for @boxsh/sdk tests.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the bundled boxsh binary.
 * Override with the BOXSH environment variable.
 */
export const BOXSH =
    process.env['BOXSH'] ?? path.resolve(__dir, '../src/exec/boxsh');

/**
 * Create a simple output collector compatible with BashOperations.onData.
 * @returns {{ onData(data: Buffer): void, text(): string }}
 */
export function collectOutput() {
    const chunks = [];
    return {
        onData(data) { chunks.push(data.toString()); },
        text()       { return chunks.join(''); },
    };
}
