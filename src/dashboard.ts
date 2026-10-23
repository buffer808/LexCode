import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Store, Story, Status } from './store';
import { BoardTree } from './tree';
import { listSessions, editedFiles } from './sessions';
import { discoverSkills } from './agents';
import { AgentWatcher, PERMISSION_MODES, runInBackground, attach, storySessions } from './claude';
import { FactoryRunner, Decision } from './factoryRunner';
import { parseEpicInput, validBranch, STAGE_LABEL, EFFORTS } from './factory';

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

// Webview input is untrusted: rebuild the decision from known fields only.
function gateDecision(m: any): Decision | undefined {
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 20000) : undefined;
  const text = str(m.text), sprintId = str(m.sprintId), storyId = str(m.storyId);
  switch (m.decision) {
    case 'approve': case 'reject': case 'retry': case 'cancel': case 'pause': case 'resume': return { decision: m.decision };
    case 'changes': return text ? { decision: 'changes', text } : undefined;
    case 'start': case 'workers': return typeof m.workers === 'number' ? { decision: m.decision, workers: m.workers } : undefined;
    case 'approveMerge': case 'retrySprint': return sprintId ? { decision: m.decision, sprintId } : undefined;
    case 'sendBack': return sprintId && text ? { decision: 'sendBack', sprintId, text } : undefined;
    case 'retryStory': case 'skipStory': return storyId ? { decision: m.decision, storyId } : undefined;
    case 'createPr': {
      const targetBranch = str(m.targetBranch), skill = str(m.skill);
      const via = ['auto', 'gh', 'tea', 'skill'].includes(m.via) ? m.via : 'auto';
      if (targetBranch && !validBranch(targetBranch) || skill && !/^[\w.:-]+$/.test(skill)) return;
      return { decision: 'createPr', targetBranch, via, skill: via === 'skill' ? skill : undefined };
    }
    case 'prOpened': return /^https?:\/\/\S+$/.test(str(m.url) ?? '') ? { decision: 'prOpened', url: str(m.url)! } : undefined;
  }
}

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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('dashboard.css')}"></head>
<body><div id="app"></div><dialog id="story"></dialog><dialog id="epic"></dialog><script nonce="${nonce}" src="${uri('dashboard.js')}"></script></body></html>`;

  const push = () => {
    const board = store.all();
    // Newest first; drives overview "last Claude activity" and the story modal's session list.
    const sessions = Object.fromEntries(board.projects.map(p => [p.id, listSessions(p.path)]));
    // Factory epic form: each project's agents and their detected roles, plus setting defaults.
    const cfg = vscode.workspace.getConfiguration('lexCode.factory');
    const roleAgents = Object.fromEntries(board.projects.map(p => {
      try { const r = factory.detectedRoles(p); return [p.id, { agents: r.agents.map(a => ({ name: a.name, description: a.description, scope: a.scope })), roles: r.roles }]; }
      catch (e: any) { return [p.id, { agents: [], roles: {}, error: e.message }]; }
    }));
    w.postMessage({ type: 'board', board, sessions, agents: agents.agents, starting: [...starting], modes: PERMISSION_MODES,
      defaultMode: vscode.workspace.getConfiguration('lexCode').get('backgroundPermissionMode', 'manual'),
      attachBase: w.asWebviewUri(attachRoot).toString(),
      factory: { roleAgents, stages: STAGE_LABEL,
        skills: Object.fromEntries(board.projects.map(p => [p.id, discoverSkills(p.path)])),
        plans: Object.fromEntries(board.projects.flatMap(p => Object.entries(factory.planPaths(p.path, board.epics.filter(e => e.projectId === p.id && e.stage).map(e => e.id))))), efforts: EFFORTS, targetBranch: cfg.get('targetBranch', 'main'),
        builderMode: cfg.get('builderPermissionMode', 'acceptEdits'), models: cfg.get('models', {}), workers: cfg.get('defaultWorkers', 1) } });
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
        try { id = await runInBackground(project, story, store.attachmentsDir(story.id), m.mode, sessionId, followUp); }
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
        if (a && project && story && storySessions(story).includes(m.sessionId)) attach(project, a.id);
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
      case 'addEpic': {
        const project = b.projects.find(p => p.id === m.id);
        if (!project) return;
        if (!m.start) {
          const title = typeof m.title === 'string' ? m.title.trim().slice(0, 200) : '';
          if (title) store.add('epics', { projectId: project.id, title });
          break;
        }
        const { agents: defs, roles } = factory.detectedRoles(project);
        try { await factory.create(project, parseEpicInput(m, defs, roles)); }
        catch (e: any) { return vscode.window.showErrorMessage(e.message); }
        break;
      }
      case 'factoryGate': {
        const e = b.epics.find(e => e.id === m.epicId);
        const d = e && gateDecision(m);
        if (!e || !d) return log.appendLine(`factoryGate rejected: ${JSON.stringify(m)}`);
        if (d.decision === 'reject' || d.decision === 'cancel') {
          const ok = await vscode.window.showWarningMessage(`Cancel the factory run for "${e.title}"?`, { modal: true,
            detail: 'Running sessions finish on their own; branches and worktrees are kept.' }, 'Cancel epic');
          if (!ok) return;
        }
        if (d.decision === 'skipStory') {
          const ok = await vscode.window.showWarningMessage('Mark this story done without passing review?', { modal: true }, 'Skip story');
          if (!ok) return;
        }
        return factory.decide(e.id, d);
      }
      case 'openPlan': if (b.epics.some(e => e.id === m.epicId)) factory.openPlan(m.epicId, m.source === true); return;
      case 'attachEpic': {
        // Only sessions this epic's factory started (planning stage, builders/reviewers, sprint review/fix).
        const e = b.epics.find(e => e.id === m.epicId);
        const project = e && b.projects.find(p => p.id === e.projectId);
        if (!e || !project) return;
        const own = [e.stageSessionId, ...b.stories.filter(s => s.epicId === e.id).flatMap(s => [s.builderSessionId, s.reviewerSessionId]),
          ...b.sprints.filter(s => s.epicId === e.id).flatMap(s => [s.sessionId, ...(s.reviews ?? []).map(r => r.sessionId)])];
        const sid = typeof m.sessionId === 'string' ? m.sessionId : e.stageSessionId;
        const a = sid && own.includes(sid) ? agents.agents[sid] : undefined;
        if (a) attach(project, a.id);
        return;
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
