/**
 * BoxshClient — manages a long-lived boxsh RPC process.
 *
 * Spawns boxsh with --rpc and optional --sandbox/--bind flags.
 * All commands and tool calls are sent as JSON lines to stdin and
 * responses are read back as JSON lines from stdout.
 *
 * Protocol (request):
 *   shell:  { id, cmd, timeout? }
 *   tool:   { id, tool: "read|write", path, ...opts }
 *
 * Protocol (response):
 *   shell:  { id, exit_code, stdout, stderr, duration_ms }
 *   tool:   { id, content: [{ text }] }  or  { id, error }
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * POSIX single-quote escaping.
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

export class BoxshClient {
    /** @type {import('node:child_process').ChildProcess} */
    #proc;
    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    #pending = new Map();
    #idCounter = 0;
    #closed = false;

    /**
     * @param {object} [options]
     * @param {string}  [options.boxshPath]   Path to boxsh binary (default: BOXSH env var → 'boxsh' in PATH)
     * @param {number}  [options.workers]     Worker count (default: 1)
     * @param {boolean} [options.sandbox]     Enable --sandbox flag
     * @param {boolean} [options.newNetNs]    Enable --new-net-ns flag
     * @param {Array<{ mode: 'ro'|'wr', path: string } | { mode: 'cow', src: string, dst: string }>} [options.binds]
     */
    constructor(options = {}) {
        const boxsh = options.boxshPath ?? process.env['BOXSH'] ?? 'boxsh';
        const args = ['--rpc', '--workers', String(options.workers ?? 1)];

        if (options.sandbox) args.push('--sandbox');
        if (options.newNetNs) args.push('--new-net-ns');
        if (options.binds) {
            for (const b of options.binds) {
                if (b.mode === 'cow') {
                    args.push('--bind', `cow:${b.src}:${b.dst}`);
                } else {
                    args.push('--bind', `${b.mode}:${b.path}`);
                }
            }
        }

        this.#proc = spawn(boxsh, args, { stdio: ['pipe', 'pipe', 'inherit'] });

        createInterface({ input: this.#proc.stdout }).on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            /** @type {Record<string, unknown>} */
            let resp;
            try {
                resp = JSON.parse(trimmed);
            } catch {
                return;
            }
            const id = String(resp.id ?? '');
            const entry = this.#pending.get(id);
            if (!entry) return;
            this.#pending.delete(id);
            // JSON-RPC 2.0: unwrap result or reject with error.
            if (resp.error) {
                entry.reject(new Error(resp.error.message || 'unknown error'));
            } else {
                entry.resolve(resp.result);
            }
        });

        this.#proc.on('error', (err) => this.#failAll(err));
        this.#proc.on('exit', () => {
            if (!this.#closed) {
                this.#failAll(new Error('boxsh process exited unexpectedly'));
            }
        });
    }

    #failAll(err) {
        for (const entry of this.#pending.values()) entry.reject(err);
        this.#pending.clear();
    }

    #nextId() {
        return String(++this.#idCounter);
    }

    /**
     * Throw if the MCP CallToolResult indicates a tool execution error.
     * @param {Record<string, unknown>} result
     */
    #checkToolError(result) {
        if (result.isError) {
            const text = Array.isArray(result.content)
                ? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                : 'tool error';
            throw new Error(text);
        }
    }

    /**
     * Send a raw request and return the parsed response.
     * @param {Record<string, unknown>} req
     * @returns {Promise<Record<string, unknown>>}
     */
    #send(req) {
        return new Promise((resolve, reject) => {
            if (this.#closed) {
                reject(new Error('BoxshClient is closed'));
                return;
            }
            const id = this.#nextId();
            this.#pending.set(id, { resolve, reject });
            // JSON-RPC 2.0 envelope.
            this.#proc.stdin.write(JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: req.method,
                params: req.params,
            }) + '\n');
        });
    }

    /**
     * Execute a shell command.
     *
     * @param {string} cmd          Shell command (passed to dash -c)
     * @param {string} [cwd]        Working directory inside the sandbox
     * @param {number} [timeout]    Timeout in seconds (0 or undefined = none)
     * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string }>}
     */
    async exec(cmd, cwd, timeout) {
        const command = cwd ? `(cd ${shellQuote(cwd)} && ${cmd})` : cmd;
        const args = { command };
        if (timeout !== undefined && timeout > 0) args.timeout = timeout;

        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'bash', arguments: args },
        });
        const sc = result.structuredContent ?? {};
        return {
            exitCode: typeof sc.exit_code === 'number' ? sc.exit_code : null,
            stdout:   typeof sc.stdout    === 'string' ? sc.stdout    : '',
            stderr:   typeof sc.stderr    === 'string' ? sc.stderr    : '',
        };
    }

    /**
     * Read a file using boxsh's built-in read tool.
     *
     * @param {string} filePath    Absolute path to the file
     * @param {number} [offset]   1-based line number to start reading from
     * @param {number} [limit]    Maximum number of lines to return
     * @returns {Promise<string>}
     */
    async read(filePath, offset, limit) {
        const args = { path: filePath };
        if (offset !== undefined) args.offset = offset;
        if (limit  !== undefined) args.limit  = limit;

        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'read', arguments: args },
        });
        this.#checkToolError(result);
        return result.content[0].text;
    }

    /**
     * Write a file using boxsh's built-in write tool.
     * Fails if the file already exists — use edit() to modify existing files.
     *
     * @param {string} filePath   Absolute path to the file
     * @param {string} content    Full file content to write
     */
    async write(filePath, content) {
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'write', arguments: { path: filePath, content } },
        });
        this.#checkToolError(result);
    }

    /**
     * Edit a file using boxsh's built-in edit tool.
     *
     * Each edit is matched against the original file content (not the result
     * of previous edits), and oldText must be unique in the file.
     *
     * @param {string} filePath   Absolute path to the file
     * @param {Array<{ oldText: string, newText: string }>} edits
     * @returns {Promise<{ diff: string, firstChangedLine: number }>}
     */
    async edit(filePath, edits) {
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'edit', arguments: { path: filePath, edits } },
        });
        this.#checkToolError(result);
        const sc = result.structuredContent ?? {};
        return {
            diff:             sc.diff ?? '',
            firstChangedLine: sc.firstChangedLine ?? 0,
        };
    }

    /**
     * Close stdin and wait for the boxsh process to exit.
     * @returns {Promise<void>}
     */
    close() {
        this.#closed = true;
        this.#proc.stdin.end();
        return new Promise((resolve) => {
            if (this.#proc.exitCode !== null) {
                resolve();
            } else {
                this.#proc.once('exit', () => resolve());
            }
        });
    }

    /**
     * Kill the boxsh process immediately.
     */
    terminate() {
        this.#closed = true;
        this.#failAll(new Error('BoxshClient terminated'));
        this.#proc.kill('SIGTERM');
    }
}
