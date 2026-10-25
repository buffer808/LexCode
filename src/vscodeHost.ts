import * as vscode from 'vscode';
import { Host } from './host';

const EXT_ID = 'anthropic.claude-code';
// claude-vscode.primaryEditor.open(sessionId?, prompt?) — same entry the extension's vscode://…/open URI uses.
const EXT_OPEN = 'claude-vscode.primaryEditor.open';

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const show = { info: vscode.window.showInformationMessage, warn: vscode.window.showWarningMessage, error: vscode.window.showErrorMessage };

export function vscodeHost(log: vscode.OutputChannel): Host {
  const cfg = () => vscode.workspace.getConfiguration('lexCode');
  return {
    message: (level, text, opts, ...actions) => Promise.resolve(opts ? show[level](text, opts, ...actions) : show[level](text, ...actions)),
    input: (prompt, value) => Promise.resolve(vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true })),
    setting: (key, fallback) => cfg().get(key, fallback),
    terminal(title, cwd, argv) {
      const t = vscode.window.createTerminal({ name: title, cwd });
      t.show();
      t.sendText(argv.map(shellQuote).join(' '));
    },
    openFile(file, opts) {
      const uri = vscode.Uri.file(file), l = (opts?.line ?? 1) - 1;
      if (opts?.preview) vscode.commands.executeCommand('markdown.showPreview', uri);
      else if (opts?.line) vscode.window.showTextDocument(uri, { selection: new vscode.Range(l, 0, l, 0) });
      else vscode.commands.executeCommand('vscode.open', uri);
    },
    openExternal: url => { vscode.env.openExternal(vscode.Uri.parse(url)); },
    log: line => log.appendLine(line),
    async claudeEditor(sessionId, prompt) {
      if (cfg().get('claudeLauncher') === 'cli' || !vscode.extensions.getExtension(EXT_ID)) return false;
      await vscode.commands.executeCommand(EXT_OPEN, sessionId, prompt);
      return true;
    },
  };
}
