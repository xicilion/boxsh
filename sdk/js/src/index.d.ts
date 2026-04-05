export interface BoxshOverlayOptions {
    lower: string;
    upper: string;
    work: string;
    dst: string;
}

export interface BoxshClientOptions {
    boxshPath?: string;
    workers?: number;
    sandbox?: boolean;
    newNetNs?: boolean;
    newPidNs?: boolean;
    overlay?: BoxshOverlayOptions;
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

export interface Change {
    path: string;
    type: 'added' | 'modified' | 'deleted';
}

export class BoxshClient {
    constructor(options?: BoxshClientOptions);
    exec(cmd: string, cwd?: string, timeout?: number): Promise<ExecResult>;
    read(filePath: string, offset?: number, limit?: number): Promise<string>;
    write(filePath: string, content: string): Promise<void>;
    edit(filePath: string, edits: EditOperation[]): Promise<EditResult>;
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
