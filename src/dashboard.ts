import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Store, Story, Status } from './store';
import { BoardTree } from './tree';
import { listSessions, editedFiles } from './sessions';
import { AgentWatcher, PERMISSION_MODES, runInBackground, attach } from './claude';

let panel: vscode.WebviewPanel | undefined;
const starting = new Set<string>(); // story ids with a background run launching
const log = vscode.window.createOutputChannel('LexCode');

const STATUSES: Status[] = ['todo', 'doing', 'review', 'done'];
const MAX_ATTACHMENT = 25 * 1024 * 1024;

// Webview input is untrusted: whitelist editable fields and their types.
function storyPatch(b: ReturnType<Store['all']>, story: Story, raw: any): Partial<Story> {
  const patch: Partial<Story> = {};
  if (typeof raw?.title === 'string' && raw.title.trim()) patch.title = raw.title.trim();
  if (typeof raw?.description === 'string') patch.description = raw.description;
  if (STATUSES.includes(raw?.status)) patch.status = raw.status;
  if (typeof raw?.archived === 'boolean') patch.archived = raw.archived || undefined;
  if ('points' in (raw ?? {})) patch.points = typeof raw.points === 'number' && isFinite(raw.points) ? raw.points : undefined;
  if ('sprintId' in (raw ?? {})) patch.sprintId = b.sprints.find(s => s.id === raw.sprintId && s.projectId === story.projectId)?.id;
  if ('epicId' in (raw ?? {})) patch.epicId = b.epics.find(e => e.id === raw.epicId && e.projectId === story.projectId)?.id;
  return patch;
}

export function showDashboard(context: vscode.ExtensionContext, store: Store, tree: BoardTree, agents: AgentWatcher) {
  if (panel) return panel.reveal();
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const attachRoot = vscode.Uri.file(store.attachmentsDir());
  panel = vscode.window.createWebviewPanel('lexCode.dashboard', 'LexCode', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, attachRoot] });
  const w = panel.webview;
  const nonce = randomUUID().replace(/-/g, '');
  const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
  w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('dashboard.css')}"></head>
<body><div id="app"></div><dialog id="story"></dialog><script nonce="${nonce}" src="${uri('dashboard.js')}"></script></body></html>`;

  const push = () => {
    const board = store.all();
    // Newest first; drives overview "last Claude activity" and the story modal's session list.
    const sessions = Object.fromEntries(board.projects.map(p => [p.id, listSessions(p.path)]));
    w.postMessage({ type: 'board', board, sessions, agents: agents.agents, starting: [...starting], modes: PERMISSION_MODES,
      defaultMode: vscode.workspace.getConfiguration('lexCode').get('backgroundPermissionMode', 'manual'),
      attachBase: w.asWebviewUri(attachRoot).toString() });
  };

  const handle = async (m: any) => {
    const b = store.all();
    const story = b.stories.find(s => s.id === m.id);
    const claude = (forceNew: boolean) => story && vscode.commands.executeCommand('lexCode.claudeStory', { kind: 'story', story }, forceNew);

    switch (m.type) {
      case 'ready': return push();
      case 'add': {
        const title = typeof m.title === 'string' ? m.title.trim() : '';
        if (!title || !b.projects.some(p => p.id === m.id)) return log.appendLine(`add rejected: ${JSON.stringify(m)}`);
        const s = store.add('stories', { projectId: m.id, title, status: 'todo' });
        store.update('stories', s.id, storyPatch(b, s, m));
        break;
      }
      case 'status': if (story && STATUSES.includes(m.status)) store.update('stories', story.id, { status: m.status }); break;
      case 'archiveDone':
        for (const s of b.stories.filter(s => Array.isArray(m.ids) && m.ids.includes(s.id) && s.status === 'done')) store.update('stories', s.id, { archived: true });
        break;
      case 'update': if (story) store.update('stories', story.id, storyPatch(b, story, m.patch)); break;
      case 'delete': {
        if (!story) return;
        const ok = await vscode.window.showWarningMessage(`Delete "${story.title}" and its attachments?`, { modal: true }, 'Delete');
        if (ok) store.remove('stories', story.id);
        break;
      }
      case 'claude': return claude(false);
      case 'newSession': return claude(true);
      case 'resume': {
        if (!story || !story.sessionIds?.includes(m.sessionId)) return;
        const project = b.projects.find(p => p.id === story.projectId);
        if (project) return vscode.commands.executeCommand('lexCode.resumeSession', { kind: 'session', project, session: { id: m.sessionId } });
        return;
      }
      case 'bgRun': {
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project || typeof m.mode !== 'string' || !(m.mode in PERMISSION_MODES)) return;
        if (starting.has(story.id)) return; // launch takes a few seconds; ignore repeat clicks
        if (m.mode === 'bypassPermissions') {
          const ok = await vscode.window.showWarningMessage(
            `Run "${story.title}" with ALL permission checks bypassed? Claude can run any command in ${project.path} unattended.`,
            { modal: true }, 'Run anyway');
          if (!ok) return;
        }
        let sessionId: string | undefined, followUp: string | undefined;
        if (typeof m.sessionId === 'string') {
          if (!story.sessionIds?.includes(m.sessionId)) return;
          sessionId = m.sessionId;
          followUp = await vscode.window.showInputBox({ prompt: 'Instructions for the background run', value: 'Continue.' });
          if (followUp === undefined) return;
        }
        starting.add(story.id);
        push();
        let id: string | undefined;
        try { id = await runInBackground(project, story, m.mode, sessionId, followUp); }
        finally { starting.delete(story.id); push(); }
        if (!id) return;
        store.reload();
        const cur = store.all().stories.find(s => s.id === story.id);
        if (cur) store.update('stories', cur.id, { sessionIds: [...new Set([...(cur.sessionIds ?? []), id])],
          status: cur.status === 'todo' ? 'doing' : cur.status });
        vscode.window.showInformationMessage(`Started background Claude run for "${story.title}" (${PERMISSION_MODES[m.mode]}).`);
        agents.poll();
        break;
      }
      case 'attach': {
        const a = agents.agents[m.sessionId];
        const project = b.projects.find(p => p.id === story?.projectId);
        if (a && project && story?.sessionIds?.includes(m.sessionId)) attach(project, a.id);
        return;
      }
      case 'edits': {
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project) return;
        const files = editedFiles(project.path, story.sessionIds ?? [])
          .map(f => ({ ...f, rel: path.relative(project.path, f.file) || f.file }));
        return w.postMessage({ type: 'edits', id: story.id, files });
      }
      case 'openFile': {
        // Only open the story's task files or paths its sessions edited (webview input is untrusted).
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project) return;
        if (story.refs?.includes(m.file)) {
          const line = story.source?.file === m.file ? story.source!.line - 1 : 0;
          return vscode.window.showTextDocument(vscode.Uri.file(m.file), { selection: new vscode.Range(line, 0, line, 0) });
        }
        if (!editedFiles(project.path, story.sessionIds ?? []).some(f => f.file === m.file)) return;
        return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.file));
      }
      case 'link': {
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project || !listSessions(project.path).some(s => s.id === m.sessionId)) return;
        store.update('stories', story.id, { sessionIds: [...new Set([...(story.sessionIds ?? []), m.sessionId])] });
        break;
      }
      case 'unlink': if (story) store.update('stories', story.id, { sessionIds: (story.sessionIds ?? []).filter(id => id !== m.sessionId) }); break;
      case 'addAttachment': {
        if (!story || typeof m.data !== 'string' || typeof m.name !== 'string') return;
        const bytes = Buffer.from(m.data, 'base64');
        if (bytes.length > MAX_ATTACHMENT) return vscode.window.showErrorMessage(`${m.name} is over 25 MB.`);
        const id = randomUUID();
        const safe = path.basename(m.name).replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file';
        const file = `${id.slice(0, 8)}-${safe}`;
        fs.mkdirSync(store.attachmentsDir(story.id), { recursive: true });
        fs.writeFileSync(path.join(store.attachmentsDir(story.id), file), bytes);
        const mime = typeof m.mime === 'string' ? m.mime.slice(0, 100) : '';
        store.reload(); // several files may arrive at once; append to the latest list
        const cur = store.all().stories.find(s => s.id === story.id);
        store.update('stories', story.id, { attachments: [...(cur?.attachments ?? []), { id, name: safe, file, mime }] });
        break;
      }
      case 'openAttachment': {
        const a = story?.attachments?.find(a => a.id === m.attachmentId);
        if (a) return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(store.attachmentsDir(story!.id), a.file)));
        return;
      }
      case 'removeAttachment': {
        const a = story?.attachments?.find(a => a.id === m.attachmentId);
        if (!a) return;
        fs.rmSync(path.join(store.attachmentsDir(story!.id), a.file), { force: true });
        store.update('stories', story!.id, { attachments: story!.attachments!.filter(x => x.id !== a.id) });
        break;
      }
      case 'addProject': return vscode.commands.executeCommand('lexCode.addProject');
      case 'removeProject': {
        const project = b.projects.find(p => p.id === m.id);
        if (project) return vscode.commands.executeCommand('lexCode.removeProject', { kind: 'project', project });
        return;
      }
      case 'importTasks': {
        const project = b.projects.find(p => p.id === m.id);
        if (project) return vscode.commands.executeCommand('lexCode.importTasks', { kind: 'project', project });
        return;
      }
      case 'openProject': {
        const project = b.projects.find(p => p.id === m.id);
        if (project) return vscode.commands.executeCommand('lexCode.openProject', { kind: 'project', project });
        return;
      }
    }
    tree.refresh(); // fires push
  };

  const subs = [
    tree.onDidChangeTreeData(push),
    agents.onDidChange(push),
    w.onDidReceiveMessage(async m => {
      log.appendLine(`dashboard → ${m?.type === 'addAttachment' ? `addAttachment ${m.name}` : JSON.stringify(m)}`);
      try { await handle(m); } catch (e: any) {
        log.appendLine(`error: ${e?.stack ?? e}`);
        vscode.window.showErrorMessage(`LexCode dashboard: ${e?.message ?? e}`);
      }
    }),
  ];
  panel.onDidDispose(() => { subs.forEach(s => s.dispose()); panel = undefined; });
}
