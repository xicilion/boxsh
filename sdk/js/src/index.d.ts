export type BoxshBindOption =
    | { mode: 'ro'; path: string }
    | { mode: 'wr'; path: string }
    | { mode: 'cow'; src: string; dst: string };

export interface BoxshClientOptions {
    boxshPath?: string;
    workers?: number;
    sandbox?: boolean;
    newNetNs?: boolean;
    binds?: BoxshBindOption[];
}

export interface ExecResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export interface EditOperation {
    oldText: string;
    newText: string;
}

export interface TerminalSession {
    id: string;
    command: string;
    alive: boolean;
    exited: boolean;
    exit_code: number | null;
    cols: number;
    rows: number;
}

/** Result of the read tool (text files only). */
export interface ReadResult {
    /** File text (model-facing representation). */
    content: string;
    /** Always 'text' — binary/image reads fail instead. */
    encoding: string;
    /** Detected MIME type of a text file (e.g. text/plain). */
    mime_type: string;
    line_count?: number;
    truncated?: boolean;
    /** Size of the file in bytes (always present). */
    file_size?: number;
    /** Total lines in the file (only when truncated, or when offset is past the end). */
    total_lines?: number;
    /** Offset to pass back to read() to continue (only when a further line exists). */
    next_offset?: number;
    /** Why the body is empty (only when line_count is 0). */
    empty_reason?: 'empty_file' | 'offset_beyond_eof';
}

/** Result of the view_image tool. */
export interface ViewImageResult {
    /** base64-encoded image data (first frame only for animated sources). */
    data: string;
    /** MIME type of the returned image (may differ from the file's). */
    mimeType: string;
    width: number;
    height: number;
    original_width: number;
    original_height: number;
    was_resized: boolean;
    /** Size of the original file in bytes. */
    size: number;
    /** True when the source was animated (only the first frame is returned). */
    animated: boolean;
    /**
     * True when the file was re-encoded (e.g. BMP/TIFF → PNG/JPEG) so the
     * returned format is one multimodal models ingest natively
     * (jpeg/png/gif/webp pass through unchanged).
     */
    converted: boolean;
    /** Model-facing text such as "[Image: image/png, 200x133]". */
    text: string;
}

export interface RunInTerminalOptions {
    explanation?: string;
    goal?: string;
    cols?: number;
    rows?: number;
    /** How long to wait before returning, in ms (default 500; 60000 with waitFor "exit"). */
    waitMs?: number;
    /** "output" (default), "exit" (wait for the process to finish) or "none". */
    waitFor?: 'output' | 'exit' | 'none';
}

/** Options shared by the terminal read calls (getTerminalOutput). */
export interface TerminalReadOptions {
    /** Raw-log cursor from a previous result's nextCursor (0 = everything still retained). */
    cursor?: number;
    /** How long to wait before returning, in ms. */
    waitMs?: number;
    /** What to wait for before returning. */
    waitFor?: 'output' | 'exit' | 'none';
}

export interface TerminalOutputResult {
    output: string;
    exited: boolean;
    exitCode: number | null;
    /** Bytes received from the PTY since the session started. */
    totalBytes?: number;
    /** Raw output bytes (present when a cursor was passed or waitFor is "exit"). */
    stream?: string;
    /** Cursor the stream starts at. */
    firstCursor?: number;
    /** Pass as `cursor` to read only what comes after this result. */
    nextCursor?: number;
    /** The requested cursor had already scrolled out of the raw log. */
    truncatedBefore?: boolean;
    /** Bytes dropped from the front of the raw log so far. */
    droppedBytes?: number;
    /** `output` is only a partial view: the session produced more lines than the screen shows. */
    screenPartial?: boolean;
    /** Exit code of the command just submitted (sendToTerminal with captureStatus). */
    commandExitCode?: number;
}

export interface RunInTerminalResult extends TerminalOutputResult {
    id: string;
}

export interface Change {
    path: string;
    type: 'added' | 'modified' | 'deleted';
}

/** Error thrown for MCP tool failures; `code` is one of the stable E_* codes. */
export class BoxshToolError extends Error {
    code?: string;
    detail?: unknown;
}

export class BoxshClient {
    constructor(options?: BoxshClientOptions);
    exec(cmd: string, cwd?: string, timeout?: number): Promise<ExecResult>;
    read(filePath: string, offset?: number, limit?: number): Promise<ReadResult>;
    viewImage(filePath: string, detail?: 'auto' | 'low'): Promise<ViewImageResult>;
    write(filePath: string, content: string): Promise<void>;
    edit(filePath: string, edits: EditOperation[]): Promise<void>;
    runInTerminal(command: string, opts?: RunInTerminalOptions): Promise<RunInTerminalResult>;
    sendToTerminal(id: string, command: string): Promise<TerminalOutputResult>;
    getTerminalOutput(id: string): Promise<TerminalOutputResult>;
    killTerminal(id: string): Promise<string>;
    listTerminals(): Promise<TerminalSession[]>;
    close(): Promise<void>;
    terminate(): void;
}

export function shellQuote(s: string): string;

export function getChanges(options: { upper: string; base: string }): Change[];

export function formatChanges(changes: Change[]): string;

export interface BashExecOptions {
    onData?: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
}

export interface BashOperations {
    exec(command: string, cwd: string, options: BashExecOptions): Promise<{ exitCode: number | null }>;
}

export interface CreateBashOperationsOptions {
    sandbox?: boolean;
    fallback?: BashOperations;
}

export function createBashOperations(options?: CreateBashOperationsOptions): BashOperations;
