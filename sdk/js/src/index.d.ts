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

export interface EditResult {
    diff: string;
    firstChangedLine: number;
}

export interface TerminalSession {
    id: string;
    command: string;
    alive: boolean;
    cols: number;
    rows: number;
}

export interface ReadResult {
    content: string;
    encoding: string;
    mime_type: string;
    line_count?: number;
    truncated?: boolean;
    size?: number;
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

export class BoxshClient {
    constructor(options?: BoxshClientOptions);
    exec(cmd: string, cwd?: string, timeout?: number): Promise<ExecResult>;
    read(filePath: string, offset?: number, limit?: number): Promise<ReadResult>;
    write(filePath: string, content: string): Promise<void>;
    edit(filePath: string, edits: EditOperation[]): Promise<EditResult>;
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
