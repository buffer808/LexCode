// What the shared modules need from the app they run in: the VS Code extension (vscodeHost.ts) or `lexcode ui` (server.ts).
export interface Host {
  // Like vscode.window.show*Message: resolves to the clicked action, undefined when dismissed.
  message(level: 'info' | 'warn' | 'error', text: string, opts?: { modal?: boolean; detail?: string }, ...actions: string[]): Promise<string | undefined>;
  input(prompt: string, value?: string): Promise<string | undefined>;
  // key under lexCode.*, e.g. 'claudePath' or 'factory.models'.
  setting<T>(key: string, fallback: T): T;
  // Interactive program (argv[0] is the binary) in cwd, shown to the user.
  terminal(title: string, cwd: string, argv: string[]): void;
  // line: open in an editor at that 1-based line; preview: rendered markdown.
  openFile(file: string, opts?: { line?: number; preview?: boolean }): void;
  openExternal(url: string): void;
  log(line: string): void;
  // VS Code only: opens the Claude Code extension's editor instead of a terminal; false = not available.
  claudeEditor?(sessionId?: string, prompt?: string): Promise<boolean>;
  // Shows markdown inside the dashboard (source: raw text first); absent = openFile instead.
  showMarkdown?(title: string, markdown: string, source?: boolean): void;
  // Brings the dashboard to front; absent where the dashboard already is the app (browser).
  showDashboard?(): void;
}

let current: Host | undefined;
export const setHost = (h: Host) => { current = h; };
export function host(): Host {
  if (!current) throw new Error('LexCode host not set');
  return current;
}
