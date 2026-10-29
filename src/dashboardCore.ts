// Dashboard message handling shared by the VS Code webview (dashboard.ts) and `lexcode ui` (server.ts).
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Store, Story, Status, Project, Attachment } from './store';
import { listSessions, editedFiles } from './sessions';
import { discoverSkills } from './agents';
import { AgentWatcher, PERMISSION_MODES, runInBackground, attach, storySessions, claudeStory, resumeSession } from './claude';
import { FactoryRunner, Decision } from './factoryRunner';
import { parseEpicInput, validBranch, STAGE_LABEL, EFFORTS } from './factory';
import { host } from './host';

const starting = new Set<string>(); // story ids with a background run launching

const STATUSES: Status[] = ['todo', 'doing', 'review', 'done'];
const MAX_ATTACHMENT = 25 * 1024 * 1024;

// Writes one uploaded file ({ name, mime, data: base64 }) into dir. Webview input is untrusted: size cap, sanitized name.
function saveAttachment(dir: string, raw: any): Attachment | undefined {
  if (typeof raw?.data !== 'string' || typeof raw?.name !== 'string') return;
  const bytes = Buffer.from(raw.data, 'base64');
  if (bytes.length > MAX_ATTACHMENT) { host().message('error', `${raw.name} is over 25 MB.`); return; }
  const id = randomUUID();
  const safe = path.basename(raw.name).replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file';
  const file = `${id.slice(0, 8)}-${safe}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), bytes);
  return { id, name: safe, file, mime: typeof raw.mime === 'string' ? raw.mime.slice(0, 100) : '' };
}

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
    case 'approve': case 'reject': case 'retry': case 'cancel': case 'restart': case 'archive': case 'pause': case 'resume': return { decision: m.decision };
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

// Project actions differ per app (folder picker, quick picks, workspace folders).
export interface ProjectActions {
  add(): unknown; remove(p: Project): unknown; importTasks(p: Project): unknown; open(p: Project): unknown;
}

// send: posts a message to the dashboard page. attachBase: URL the page loads attachments from.
// refresh: after a change; must end in push() (VS Code goes through the tree).
export function dashboardCore(store: Store, agents: AgentWatcher, factory: FactoryRunner,
  send: (m: unknown) => unknown, attachBase: string, refresh: () => void, projects: ProjectActions) {
  const push = () => {
    const board = store.all();
    // Newest first; drives overview "last Claude activity" and the story modal's session list.
    const sessions = Object.fromEntries(board.projects.map(p => [p.id, listSessions(p.path)]));
    // Factory epic form: each project's agents and their detected roles, plus setting defaults.
    const cfg = (key: string, fallback: unknown) => host().setting(`factory.${key}`, fallback);
    const roleAgents = Object.fromEntries(board.projects.map(p => {
      try { const r = factory.detectedRoles(p); return [p.id, { agents: r.agents.map(a => ({ name: a.name, description: a.description, scope: a.scope })), roles: r.roles }]; }
      catch (e: any) { return [p.id, { agents: [], roles: {}, error: e.message }]; }
    }));
    send({ type: 'board', board, sessions, agents: agents.agents, starting: [...starting], modes: PERMISSION_MODES,
      defaultMode: host().setting('backgroundPermissionMode', 'manual'),
      attachBase,
      factory: { roleAgents, stages: STAGE_LABEL,
        skills: Object.fromEntries(board.projects.map(p => [p.id, discoverSkills(p.path)])),
        plans: Object.fromEntries(board.projects.flatMap(p => Object.entries(factory.planPaths(p.path, board.epics.filter(e => e.projectId === p.id && e.stage).map(e => e.id))))), efforts: EFFORTS, targetBranch: cfg('targetBranch', 'main'),
        builderMode: cfg('builderPermissionMode', 'acceptEdits'), models: cfg('models', {}), workers: cfg('defaultWorkers', 1) } });
  };

  const handle = async (m: any) => {
    const b = store.all();
    const story = b.stories.find(s => s.id === m.id);
    const claude = (forceNew: boolean) => story && claudeStory(store, story, forceNew);

    switch (m.type) {
      case 'ready': return push();
      case 'add': {
        const title = typeof m.title === 'string' ? m.title.trim() : '';
        if (!title || !b.projects.some(p => p.id === m.id)) return host().log(`add rejected: ${JSON.stringify(m)}`);
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
        const ok = await host().message('warn', `Delete "${story.title}" and its attachments?`, { modal: true }, 'Delete');
        if (ok) store.remove('stories', story.id);
        break;
      }
      case 'claude': return claude(false);
      case 'newSession': return claude(true);
      case 'resume': {
        if (!story || !story.sessionIds?.includes(m.sessionId)) return;
        const project = b.projects.find(p => p.id === story.projectId);
        if (project) return resumeSession(project, m.sessionId);
        return;
      }
      case 'bgRun': {
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project || typeof m.mode !== 'string' || !(m.mode in PERMISSION_MODES)) return;
        if (starting.has(story.id)) return; // launch takes a few seconds; ignore repeat clicks
        if (m.mode === 'bypassPermissions') {
          const ok = await host().message('warn',
            `Run "${story.title}" with ALL permission checks bypassed? Claude can run any command in ${project.path} unattended.`,
            { modal: true }, 'Run anyway');
          if (!ok) return;
        }
        let sessionId: string | undefined, followUp: string | undefined;
        if (typeof m.sessionId === 'string') {
          if (!story.sessionIds?.includes(m.sessionId)) return;
          sessionId = m.sessionId;
          followUp = await host().input('Instructions for the background run', 'Continue.');
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
        host().message('info', `Started background Claude run for "${story.title}" (${PERMISSION_MODES[m.mode]}).`);
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
        return send({ type: 'edits', id: story.id, files });
      }
      case 'openFile': {
        // Only open the story's task files or paths its sessions edited (webview input is untrusted).
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project) return;
        if (story.refs?.includes(m.file)) {
          return host().openFile(m.file, { line: story.source?.file === m.file ? story.source!.line : 1 });
        }
        if (!editedFiles(project.path, story.sessionIds ?? []).some(f => f.file === m.file)) return;
        return host().openFile(m.file);
      }
      case 'link': {
        const project = b.projects.find(p => p.id === story?.projectId);
        if (!story || !project || !listSessions(project.path).some(s => s.id === m.sessionId)) return;
        store.update('stories', story.id, { sessionIds: [...new Set([...(story.sessionIds ?? []), m.sessionId])] });
        break;
      }
      case 'unlink': if (story) store.update('stories', story.id, { sessionIds: (story.sessionIds ?? []).filter(id => id !== m.sessionId) }); break;
      case 'addAttachment': {
        const a = story && saveAttachment(store.attachmentsDir(story.id), m);
        if (!a) return;
        store.reload(); // several files may arrive at once; append to the latest list
        const cur = store.all().stories.find(s => s.id === story!.id);
        store.update('stories', story!.id, { attachments: [...(cur?.attachments ?? []), a] });
        break;
      }
      case 'openAttachment': {
        const a = story?.attachments?.find(a => a.id === m.attachmentId);
        if (a) return host().openFile(path.join(store.attachmentsDir(story!.id), a.file));
        return;
      }
      case 'openEpicAttachment': {
        const a = b.epics.find(e => e.id === m.epicId)?.attachments?.find(a => a.id === m.attachmentId);
        if (a) return host().openFile(path.join(store.attachmentsDir(m.epicId), a.file));
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
        // Reference files go on the epic before planning starts, so the orchestrator sees them.
        const uploads: unknown[] = Array.isArray(m.attachments) ? m.attachments.slice(0, 20) : [];
        const withFiles = (epicId: string) => uploads.length && store.update('epics', epicId, {
          attachments: uploads.flatMap(u => saveAttachment(store.attachmentsDir(epicId), u) ?? []) });
        if (!m.start) {
          const title = typeof m.title === 'string' ? m.title.trim().slice(0, 200) : '';
          const description = typeof m.description === 'string' && m.description.trim() ? m.description : undefined;
          if (title) withFiles(store.add('epics', { projectId: project.id, title, description }).id);
          break;
        }
        const { agents: defs, roles } = factory.detectedRoles(project);
        let draft: string | undefined;
        try {
          const input = parseEpicInput(m, defs, roles);
          if (uploads.length) withFiles(draft = store.add('epics', { projectId: project.id, title: input.title }).id);
          await factory.create(project, input, draft);
        } catch (e: any) {
          if (draft) store.remove('epics', draft); // also deletes its files
          return host().message('error', e.message);
        }
        break;
      }
      case 'updateEpic': {
        const e = b.epics.find(e => e.id === m.epicId);
        const title = typeof m.title === 'string' ? m.title.trim().slice(0, 200) : '';
        if (!e || !title || typeof m.description !== 'string') return host().log(`updateEpic rejected: ${JSON.stringify(m)}`);
        store.update('epics', e.id, { title, description: m.description.trim() ? m.description : undefined });
        break;
      }
      case 'factoryGate': {
        const e = b.epics.find(e => e.id === m.epicId);
        const d = e && gateDecision(m);
        if (!e || !d) return host().log(`factoryGate rejected: ${JSON.stringify(m)}`);
        if (d.decision === 'reject' || d.decision === 'cancel') {
          const ok = await host().message('warn', `Cancel the factory run for "${e.title}"?`, { modal: true,
            detail: 'Running sessions finish on their own; branches and worktrees are kept.' }, 'Cancel epic');
          if (!ok) return;
        }
        if (d.decision === 'skipStory') {
          const ok = await host().message('warn', 'Mark this story done without passing review?', { modal: true }, 'Skip story');
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
      case 'addProject': return projects.add();
      case 'removeProject': case 'importTasks': case 'openProject': {
        const project = b.projects.find(p => p.id === m.id);
        if (project) return projects[m.type === 'removeProject' ? 'remove' : m.type === 'importTasks' ? 'importTasks' : 'open'](project);
        return;
      }
    }
    refresh(); // fires push
  };


  return { push, handle: async (m: any) => {
    host().log(`dashboard → ${m?.type === 'addAttachment' ? `addAttachment ${m.name}` : JSON.stringify(m)}`);
    try { await handle(m); } catch (e: any) {
      host().log(`error: ${e?.stack ?? e}`);
      host().message('error', `LexCode dashboard: ${e?.message ?? e}`);
    }
  } };
}
