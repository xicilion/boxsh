/**
 * Shared test helpers for @boxsh/sdk tests.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the boxsh binary.
 * Resolution order: BOXSH env var → build/boxsh.
 */
function findBoxsh() {
    if (process.env['BOXSH']) return process.env['BOXSH'];
    return path.resolve(__dir, '../../../build/boxsh');
}

export const BOXSH = findBoxsh();

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
