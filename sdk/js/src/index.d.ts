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
    /** Total lines in the file (only when truncated). */
    total_lines?: number;
    /** Offset to pass back to read() to continue (only when truncated). */
    next_offset?: number;
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
    /** Model-facing text such as "[Image: image/png, 200x133]". */
    text: string;
}

export interface RunInTerminalOptions {
    explanation?: string;
    goal?: string;
    cols?: number;
    rows?: number;
}

export interface TerminalOutputResult {
    output: string;
    exited: boolean;
    exitCode: number | null;
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
