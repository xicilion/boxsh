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
 * Protocol (response, MCP CallToolResult):
 *   shell:  { id, exit_code, stdout, stderr, duration_ms }
 *   tool:   { id, content: [{ type: 'text', text } | { type: 'image', ... }],
 *             structuredContent?, isError? }
 *
 * Tool errors are rejected with a BoxshToolError carrying the stable `code`
 * from structuredContent (see the README's "Error model" section).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Error thrown for MCP tool failures (isError:true). */
export class BoxshToolError extends Error {
    /**
     * @param {string} message  self-describing message from the server
     * @param {object} [opts]
     * @param {string} [opts.code]    stable error code (E_*)
     * @param {unknown} [opts.detail] machine-readable extra information
     */
    constructor(message, { code, detail } = {}) {
        super(message);
        this.name = 'BoxshToolError';
        this.code = code;
        this.detail = detail;
    }
}

/** First text block of a CallToolResult, or ''. */
function textOf(result) {
    if (!Array.isArray(result?.content)) return '';
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

/** All image blocks of a CallToolResult. */
function imagesOf(result) {
    if (!Array.isArray(result?.content)) return [];
    return result.content.filter(c => c.type === 'image');
}

/**
 * Add the terminal read options (`cursor` / `waitMs` / `waitFor`) to a tool
 * argument object, using the wire names the server expects.
 * @param {object} args  tool arguments (mutated)
 * @param {{cursor?: number, waitMs?: number, waitFor?: string}} opts
 */
function applyTerminalReadOptions(args, opts) {
    if (opts.cursor !== undefined)  args.cursor   = opts.cursor;
    if (opts.waitMs !== undefined)  args.wait_ms  = opts.waitMs;
    if (opts.waitFor !== undefined) args.wait_for = opts.waitFor;
}

/**
 * Map a terminal tool's structuredContent onto the SDK result shape.  The four
 * historical fields are always present; the raw-stream fields appear when the
 * call asked for the stream (cursor / waitFor:"exit" / captureStatus).
 * @param {object} sc  structuredContent
 * @returns {object}
 */
function terminalResultFrom(sc) {
    /** @type {Record<string, unknown>} */
    const out = {
        output:   sc.output ?? '',
        exited:   sc.exited ?? false,
        exitCode: sc.exit_code ?? null,
    };
    if (sc.total_bytes      !== undefined) out.totalBytes      = sc.total_bytes;
    if (sc.stream           !== undefined) out.stream           = sc.stream;
    if (sc.first_cursor     !== undefined) out.firstCursor      = sc.first_cursor;
    if (sc.next_cursor      !== undefined) out.nextCursor       = sc.next_cursor;
    if (sc.truncated_before !== undefined) out.truncatedBefore  = sc.truncated_before;
    if (sc.dropped_bytes    !== undefined) out.droppedBytes     = sc.dropped_bytes;
    if (sc.screen_partial   !== undefined) out.screenPartial    = sc.screen_partial;
    if (sc.command_exit_code !== undefined) out.commandExitCode = sc.command_exit_code;
    return out;
}

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
     * Throw if the MCP CallToolResult indicates a tool failure.
     * @param {Record<string, unknown>} result
     */
    #checkToolError(result) {
        if (!result.isError) return;
        const sc = result.structuredContent ?? {};
        throw new BoxshToolError(
            typeof sc.message === 'string' ? sc.message : (textOf(result) || 'tool error'),
            { code: sc.code, detail: sc.detail },
        );
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
     * @param {number} [timeout]    Timeout in seconds; omitting it (or passing 0)
     *                              leaves the server default (--command-timeout,
     *                              60s) in charge
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
            // A timed-out command exits with -1 and a `timeout` marker in
            // stderr; these flags say so outright instead of leaving the caller
            // to parse the streams (the MCP result also carries isError:true).
            timedOut: sc.timed_out === true,
            truncated: sc.stdout_truncated === true || sc.stderr_truncated === true
                       || sc.result_truncated === true,
        };
    }

    /**
     * Read a text file using boxsh's built-in read tool.
     *
     * Images and other binary files are rejected by the server — use
     * viewImage() for images.
     *
     * @param {string} filePath    Absolute path to the file
     * @param {number} [offset]   1-based line number to start reading from
     * @param {number} [limit]    Maximum number of lines to return
     * @returns {Promise<{ content: string, encoding: string, mime_type: string, line_count?: number, truncated?: boolean, file_size?: number, total_lines?: number, next_offset?: number, empty_reason?: 'empty_file'|'offset_beyond_eof' }>}
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
        const sc = result.structuredContent ?? {};
        return {
            content:    textOf(result),
            encoding:   sc.encoding ?? 'text',
            mime_type:  sc.mime_type ?? '',
            ...(sc.line_count   !== undefined ? { line_count: sc.line_count }     : {}),
            ...(sc.truncated    !== undefined ? { truncated: sc.truncated }       : {}),
            ...(sc.file_size    !== undefined ? { file_size: sc.file_size }       : {}),
            ...(sc.total_lines  !== undefined ? { total_lines: sc.total_lines }   : {}),
            ...(sc.next_offset  !== undefined ? { next_offset: sc.next_offset }   : {}),
            ...(sc.empty_reason !== undefined ? { empty_reason: sc.empty_reason } : {}),
        };
    }

    /**
     * View an image file (png, jpeg, gif, bmp, tiff, webp).
     * Other image formats (avif, heic, jxl, …) are rejected with
     * E_UNSUPPORTED_FORMAT.  Formats outside the model-native set
     * (jpeg/png/gif/webp) are converted to PNG/JPEG before being returned
     * (`converted: true`, e.g. BMP/TIFF → PNG/JPEG).
     *
     * @param {string} filePath          Absolute path to the image
     * @param {'auto'|'low'} [detail]    'low' returns a 512px preview
     * @returns {Promise<{ data: string, mimeType: string, width: number, height: number, original_width: number, original_height: number, was_resized: boolean, size: number, animated: boolean, converted: boolean, text: string }>}
     */
    async viewImage(filePath, detail) {
        const args = { path: filePath };
        if (detail !== undefined) args.detail = detail;

        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'view_image', arguments: args },
        });
        this.#checkToolError(result);
        const sc = result.structuredContent ?? {};
        const [image] = imagesOf(result);
        return {
            data:            image?.data ?? '',
            mimeType:        image?.mimeType ?? sc.mime_type ?? '',
            width:           sc.width ?? 0,
            height:          sc.height ?? 0,
            original_width:  sc.original_width ?? 0,
            original_height: sc.original_height ?? 0,
            was_resized:     sc.was_resized ?? false,
            size:            sc.size ?? 0,
            animated:        sc.animated ?? false,
            converted:       sc.converted ?? false,
            text:            textOf(result),
        };
    }

    /**
     * Write a file using boxsh's built-in write tool (creates or overwrites).
     * Parent directories are created automatically.
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
     */
    async edit(filePath, edits) {
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'edit', arguments: { path: filePath, edits } },
        });
        this.#checkToolError(result);
    }

    // -----------------------------------------------------------------
    // Terminal tools
    // -----------------------------------------------------------------

    /**
     * Start a persistent PTY session.
     *
     * @param {string} command   Command to run (e.g. "bash")
     * @param {object} [opts]
     * @param {string} [opts.explanation]  Why this terminal is needed
     * @param {string} [opts.goal]         What you intend to accomplish
     * @param {number} [opts.cols]         Terminal columns (default: 220)
     * @param {number} [opts.rows]         Terminal rows (default: 50)
     * @param {number} [opts.waitMs]       How long to wait before returning (default: 500)
     * @param {string} [opts.waitFor]      "output" (default), "exit" or "none"
     * @returns {Promise<{ id: string, output: string, exited: boolean, exitCode: number|null }>}
     */
    async runInTerminal(command, opts = {}) {
        const args = { command };
        if (opts.explanation) args.explanation = opts.explanation;
        if (opts.goal)        args.goal        = opts.goal;
        if (opts.cols)        args.cols         = opts.cols;
        if (opts.rows)        args.rows         = opts.rows;
        applyTerminalReadOptions(args, opts);

        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'run_in_terminal', arguments: args },
        });
        this.#checkToolError(result);
        const sc = result.structuredContent ?? {};
        return { id: sc.id ?? '', ...terminalResultFrom(sc) };
    }

    /**
     * Send text to a terminal session's PTY stdin, and/or signal it.
     *
     * @param {string} id        Session id
     * @param {string} [command] Text to write (append \n for execution); omit to signal only
     * @param {object} [opts]
     * @param {string} [opts.signal]          Signal for the session's process group:
     *   "INT" aborts the running command and the rest of its command line,
     *   "KILL" ends the session (an interactive shell ignores TERM/QUIT by POSIX)
     * @param {boolean} [opts.captureStatus]  Submit the text as a shell command line and report its exit code
     * @param {number} [opts.waitMs]          How long to wait (default 500; 60000 with captureStatus)
     * @param {string} [opts.waitFor]         "output" (default), "exit" or "none"
     * @param {number} [opts.cursor]          Return the raw stream from this cursor
     * @returns {Promise<{ output: string, exited: boolean, exitCode: number|null }>}
     */
    async sendToTerminal(id, command, opts = {}) {
        const args = { id };
        if (command)                  args.command        = command;
        if (opts.signal)              args.signal         = opts.signal;
        if (opts.captureStatus)       args.capture_status = true;
        applyTerminalReadOptions(args, opts);
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'send_to_terminal', arguments: args },
        });
        this.#checkToolError(result);
        return terminalResultFrom(result.structuredContent ?? {});
    }

    /**
     * Read from a terminal session without writing to it.
     *
     * Without `cursor` this returns the rendered screen; with one it returns the
     * raw byte delta from that position (0 = everything still retained), which is
     * how output that scrolled off the screen is recovered.
     *
     * @param {string} id   Session id
     * @param {object} [opts]
     * @param {number} [opts.cursor]  Raw-log cursor (from a previous result's nextCursor)
     * @param {number} [opts.waitMs]  How long to wait before returning
     * @param {string} [opts.waitFor] "output" (default), "exit" or "none"
     * @returns {Promise<{ output: string, exited: boolean, exitCode: number|null }>}
     */
    async getTerminalOutput(id, opts = {}) {
        const args = { id };
        applyTerminalReadOptions(args, opts);
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'get_terminal_output', arguments: args },
        });
        this.#checkToolError(result);
        return terminalResultFrom(result.structuredContent ?? {});
    }

    /**
     * Kill a terminal session and free its resources.
     *
     * @param {string} id   Session id
     * @returns {Promise<string>}  Final screen snapshot
     */
    async killTerminal(id) {
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'kill_terminal', arguments: { id } },
        });
        this.#checkToolError(result);
        const sc = result.structuredContent ?? {};
        return sc.output ?? '';
    }

    /**
     * List terminal sessions.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.includeExited]  Also list sessions whose process exited
     * @returns {Promise<Array<{ id: string, command: string, alive: boolean, cols: number, rows: number }>>}
     */
    async listTerminals(opts = {}) {
        const args = {};
        if (opts.includeExited) args.include_exited = true;
        const result = await this.#send({
            method: 'tools/call',
            params: { name: 'list_terminals', arguments: args },
        });
        this.#checkToolError(result);
        const sc = result.structuredContent ?? {};
        return sc.sessions ?? [];
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
