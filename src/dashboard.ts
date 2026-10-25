import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { Store, Project } from './store';
import { BoardTree } from './tree';
import { AgentWatcher } from './claude';
import { FactoryRunner } from './factoryRunner';
import { dashboardCore } from './dashboardCore';

let panel: vscode.WebviewPanel | undefined;

// `restored`: a tab VS Code brought back after a reload/extension-host restart; it is rewired, otherwise its clicks go nowhere.
export function showDashboard(context: vscode.ExtensionContext, store: Store, tree: BoardTree, agents: AgentWatcher, factory: FactoryRunner, restored?: vscode.WebviewPanel) {
  if (panel && !restored) return panel.reveal();
  if (panel && restored) panel.dispose();
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const attachRoot = vscode.Uri.file(store.attachmentsDir());
  const options = { enableScripts: true, localResourceRoots: [media, attachRoot] };
  panel = restored ?? vscode.window.createWebviewPanel('lexCode.dashboard', 'LexCode', vscode.ViewColumn.One, { ...options, retainContextWhenHidden: true });
  const w = panel.webview;
  w.options = options;
  const nonce = randomUUID().replace(/-/g, '');
  const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
  w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('dashboard.css')}"></head>
<body><div id="app"></div><dialog id="story"></dialog><dialog id="epic"></dialog>
${['vendor/marked.umd.js', 'markdown.js', 'dashboard.js'].map(f => `<script nonce="${nonce}" src="${uri(f)}"></script>`).join('')}</body></html>`;

  const projectCmd = (id: string) => (project: Project) => vscode.commands.executeCommand(id, { kind: 'project', project });
  const { push, handle } = dashboardCore(store, agents, factory, m => w.postMessage(m), w.asWebviewUri(attachRoot).toString(), () => tree.refresh(), {
    add: () => vscode.commands.executeCommand('lexCode.addProject'),
    remove: projectCmd('lexCode.removeProject'), importTasks: projectCmd('lexCode.importTasks'), open: projectCmd('lexCode.openProject'),
  });

  const subs = [
    tree.onDidChangeTreeData(push),
    agents.onDidChange(push),
    w.onDidReceiveMessage(handle),
  ];
  panel.onDidDispose(() => { subs.forEach(s => s.dispose()); panel = undefined; });
}
