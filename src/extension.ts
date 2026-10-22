import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Store, Project, Status } from './store';
import { BoardTree, Node } from './tree';
import { resumeSession, openStorySession, startSession, AgentWatcher } from './claude';
import { showDashboard } from './dashboard';
import { FactoryRunner } from './factoryRunner';
import { parseEpicInput, validBranch, EFFORTS } from './factory';
import { findTasksFile, parseTasks, importInto, reviewPrompt, syncSource, syncFrom, syncSourceOf, Parsed, ParsedStory } from './importer';

const statuses: Status[] = ['todo', 'doing', 'review', 'done'];

export function activate(context: vscode.ExtensionContext) {
  const store = new Store(path.join(context.globalStorageUri.fsPath, 'board.json'), s => {
    try { if (s.source && !syncSource(s)) vscode.window.showWarningMessage(`Couldn't find "${s.title}" in ${path.basename(s.source.file)} to update its checkbox`); }
    catch (e: any) { vscode.window.showWarningMessage(`Couldn't update ${s.source!.file}: ${e.message}`); }
  });
  const tree = new BoardTree(store);
  const agents = new AgentWatcher(store);
  const factory = new FactoryRunner(store, agents, path.join(context.globalStorageUri.fsPath, 'locks'),
    context.asAbsolutePath('agents'), () => tree.refresh());

  // Other windows write the same file; refresh when it changes.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, 'board.json'));
  watcher.onDidChange(() => tree.refresh());
  watcher.onDidCreate(() => tree.refresh());

  // Commands run from palette get no node; ask for the project instead.
  const pickProject = async (node?: Node): Promise<Project | undefined> => {
    if (node && 'project' in node) return node.project;
    store.reload();
    const pick = await vscode.window.showQuickPick(
      store.all().projects.map(p => ({ label: p.name, description: p.path, p })), { placeHolder: 'Project' });
    return pick?.p;
  };

  const openFolder = (p: Project) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some(f => f.uri.fsPath === p.path)) return;
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(p.path), name: p.name });
  };

  // Ticked items get imported. Unticked epic/sprint: its ticked stories still import,
  // linked only if it already exists on the board.
  const pickAndImport = async (p: Project, parsed: Parsed, title: string) => {
    type Item = vscode.QuickPickItem & { epic?: string; sprint?: string; story?: ParsedStory };
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const items: Item[] = [
      sep('Epics'), ...parsed.epics.map(e => ({ label: e, epic: e, picked: true })),
      sep('Sprints'), ...parsed.sprints.map(s => ({ label: s, sprint: s, picked: true })),
      sep('Stories'), ...parsed.stories.map(s => ({
        label: s.title, story: s, picked: true,
        description: [s.status === 'doing' && 'doing', s.epic, s.sprint].filter(Boolean).join(' · '),
      })),
    ];
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true, matchOnDescription: true, ignoreFocusOut: true,
      title, placeHolder: 'Untick what you do not want to import',
    });
    if (!chosen?.length) return;
    const n = importInto(store, p.id, {
      epics: chosen.flatMap(i => i.epic ?? []),
      sprints: chosen.flatMap(i => i.sprint ?? []),
      stories: chosen.flatMap(i => i.story ?? []),
    });
    vscode.window.showInformationMessage(`Imported ${n.epics} epics, ${n.sprints} sprints, ${n.stories} stories (duplicates skipped)`);
    tree.refresh();
  };

  // Claude reviews TASKS.md against the code with the user, writes the keepers to .lexcode/import.md;
  // we poll for that file, then show the picker on it.
  // ponytail: 2s poll for up to 2h, no fs watcher (project may sit outside the workspace).
  const reviewWithClaude = async (p: Project, tasksFile: string) => {
    const out = path.join(p.path, '.lexcode', 'import.md');
    fs.rmSync(out, { force: true });
    await startSession(p, reviewPrompt(p.path, tasksFile, out));
    vscode.window.showInformationMessage(`Claude is reviewing ${p.name}'s tasks. The import picker opens when it writes .lexcode/import.md.`);
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 2 * 3600_000) return clearInterval(timer);
      if (!fs.existsSync(out)) return;
      clearInterval(timer);
      await new Promise(r => setTimeout(r, 1000)); // let the write finish
      // Refs point at the real task files, not Claude's scratch list.
      const parsed = parseTasks(out);
      for (const s of parsed.stories) s.refs = [...new Set([tasksFile, ...(s.refs ?? [])])].filter(f => f !== out);
      await pickAndImport(p, parsed, `Import Claude-reviewed tasks into ${p.name}`);
    }, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  };

  // quiet: on project add, say nothing when there is no TASKS.md / nothing open.
  const importTasks = async (p: Project, quiet: boolean) => {
    const file = findTasksFile(p.path, vscode.workspace.getConfiguration('lexCode').get<string[]>('tasksScanSkip'));
    if (!file) { if (!quiet) vscode.window.showInformationMessage(`No TASKS.md found in ${p.name}`); return; }
    const parsed = parseTasks(file);
    const rel = path.relative(p.path, file);
    if (!parsed.epics.length && !parsed.sprints.length && !parsed.stories.length) {
      if (!quiet) vscode.window.showInformationMessage(`${rel}: nothing open to import`);
      return;
    }
    const how = await vscode.window.showInformationMessage(
      `${p.name}: found ${rel} (${parsed.epics.length} epics, ${parsed.sprints.length} sprints, ${parsed.stories.length} open stories). ` +
      'Review with Claude to weed out work that is already done?', 'Review with Claude', 'Pick manually');
    if (how === 'Review with Claude') await reviewWithClaude(p, file);
    else if (how === 'Pick manually') await pickAndImport(p, parsed, `Import from ${p.name}/${rel}`);
  };

  // Asks how the factory should run a new epic and starts planning. existing: turn a manual epic into a factory epic.
  const factoryEpic = async (p: Project, title: string, existingId?: string) => {
    const cfg = vscode.workspace.getConfiguration('lexCode.factory');
    const modes = [
      { label: '$(shield) Accept edits', detail: 'Builders auto-approve file edits and pause for shell command approvals', mode: 'acceptEdits' },
      { label: '$(rocket) Full auto', detail: 'Builders run unattended (Claude Code auto mode)', mode: 'auto' },
    ].sort((a, b) => Number(b.mode === cfg.get('builderPermissionMode')) - Number(a.mode === cfg.get('builderPermissionMode')));
    const opts = { ignoreFocusOut: true };
    const pick = await vscode.window.showQuickPick(existingId ? modes
      : [...modes, { label: '$(layers) Manual epic', detail: 'No factory: just create the epic', mode: '' }],
      { ...opts, placeHolder: `${title}: how should builder agents run?` });
    if (!pick) return;
    if (!pick.mode) return store.add('epics', { projectId: p.id, title });
    const description = await vscode.window.showInputBox({ ...opts, prompt: `Describe "${title}" for the orchestrator: goal, constraints, acceptance criteria` });
    if (description === undefined) return;
    const targetBranch = await vscode.window.showInputBox({ ...opts, prompt: 'Pull request target branch', value: cfg.get('targetBranch', 'main'),
      validateInput: v => validBranch(v.trim()) ? undefined : 'Not a valid branch name' });
    if (targetBranch === undefined) return;
    const { agents: defs, roles } = factory.detectedRoles(p);
    const models: Record<string, { model?: string; effort?: string }> = {};
    const custom = await vscode.window.showQuickPick([
      { label: 'Default models', detail: 'Planner: Opus, high effort. Builder and reviewer: settings or Claude default', custom: false },
      { label: 'Customize models…', detail: 'Pick model and effort per role', custom: true }], { ...opts, placeHolder: 'Models' });
    if (!custom) return;
    if (custom.custom) for (const role of ['planner', 'builder', 'reviewer']) {
      const model = await vscode.window.showQuickPick(['(default)', 'opus', 'sonnet', 'haiku', 'fable'], { ...opts, placeHolder: `${role} model` });
      if (!model) return;
      const effort = await vscode.window.showQuickPick(['(default)', ...EFFORTS], { ...opts, placeHolder: `${role} effort` });
      if (!effort) return;
      models[role] = { model: model === '(default)' ? undefined : model, effort: effort === '(default)' ? undefined : effort };
    }
    let epic;
    try { epic = await factory.create(p, parseEpicInput({ title, description, targetBranch, builderMode: pick.mode, models }, defs, roles), existingId); }
    catch (e: any) { return vscode.window.showErrorMessage(e.message); }
    const lead = epic.roleAgents?.orchestrator;
    vscode.window.showInformationMessage(`Planning "${title}" with ${lead ? `your ${lead} agent` : 'the LexCode orchestrator'}. You'll be asked to approve the plan.`);
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args) => { await fn(...args); tree.refresh(); });

  context.subscriptions.push(
    watcher, agents, factory,
    vscode.window.createTreeView('lexCode.board', { treeDataProvider: tree }),

    cmd('lexCode.refresh', () => {}),

    vscode.commands.registerCommand('lexCode.dashboard', () => showDashboard(context, store, tree, agents, factory)),

    cmd('lexCode.addProject', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true });
      for (const uri of picked ?? []) {
        if (store.all().projects.some(p => p.path === uri.fsPath)) continue;
        const p = store.add('projects', { name: path.basename(uri.fsPath), path: uri.fsPath });
        await importTasks(p, true);
      }
    }),

    cmd('lexCode.importTasks', async (node?: Node) => {
      const p = await pickProject(node);
      if (p) await importTasks(p, false);
    }),

    cmd('lexCode.syncTasks', async (node?: Node) => {
      const p = await pickProject(node);
      if (!p) return;
      const src = syncSourceOf(p.path, vscode.workspace.getConfiguration('lexCode').get<string[]>('tasksScanSkip'));
      if (!src) return vscode.window.showInformationMessage(`No TASKS.md found in ${p.name}`);
      // Epic scope: every epic on the board or in the markdown.
      const epics = [...new Set([...store.all().epics.filter(e => e.projectId === p.id).map(e => e.title), ...src.parsed.epics])];
      const all = '$(layers) All epics';
      const pick = epics.length ? await vscode.window.showQuickPick([all, ...epics], { placeHolder: 'Sync which epic?' }) : all;
      if (!pick) return;
      const epic = pick === all ? undefined : pick;
      const r = syncFrom(store, p.id, src.parsed, { epic });
      vscode.window.showInformationMessage(`${p.name}${epic ? ` (${epic})` : ''}: ${r.added.length} added, ${r.updated.length} updated, ${r.archived.length} archived from ${path.relative(p.path, src.file)}`);
    }),

    cmd('lexCode.removeProject', async (node?: Node) => {
      const p = await pickProject(node);
      if (!p) return;
      const keep = 'Remove, keep tasks', del = 'Remove and delete tasks';
      const ok = await vscode.window.showWarningMessage(`Remove ${p.name} from LexCode?`, {
        modal: true, detail: 'Kept tasks (epics, sprints, stories, attachments) come back when this folder is added again.',
      }, keep, del);
      if (ok) store.remove('projects', p.id, ok === keep);
    }),

    cmd('lexCode.openProject', async (node?: Node) => {
      const p = await pickProject(node);
      if (p) openFolder(p);
    }),

    cmd('lexCode.openAllProjects', () => {
      // Single call: VS Code restarts extensions when the first folder changes, so batch them.
      const folders = vscode.workspace.workspaceFolders ?? [];
      const missing = store.all().projects.filter(p => !folders.some(f => f.uri.fsPath === p.path));
      vscode.workspace.updateWorkspaceFolders(folders.length, 0,
        ...missing.map(p => ({ uri: vscode.Uri.file(p.path), name: p.name })));
    }),

    cmd('lexCode.newEpic', async (node?: Node) => {
      const p = await pickProject(node);
      const title = p && (await vscode.window.showInputBox({ prompt: `New epic in ${p.name}` }))?.trim();
      if (!p || !title) return;
      if (vscode.workspace.getConfiguration('lexCode.factory').get('autoStart', true)) await factoryEpic(p, title);
      else store.add('epics', { projectId: p.id, title });
    }),

    vscode.commands.registerCommand('lexCode.openPlan', (node?: Node) => {
      if (node?.kind === 'epic' && node.epic) return factory.openPlan(node.epic.id);
    }),

    cmd('lexCode.runFactory', async (node?: Node) => {
      if (node?.kind !== 'epic' || !node.epic) return;
      if (node.epic.stage && !['cancelled', 'failed'].includes(node.epic.stage)) {
        return vscode.window.showInformationMessage(`"${node.epic.title}" is already a factory epic (${node.epic.stage}).`);
      }
      await factoryEpic(node.project, node.epic.title, node.epic.id);
    }),

    cmd('lexCode.newSprint', async (node?: Node) => {
      const p = await pickProject(node);
      if (!p) return;
      const n = store.all().sprints.filter(s => s.projectId === p.id).length + 1;
      const name = await vscode.window.showInputBox({ prompt: 'Sprint name', value: `Sprint ${n}` });
      if (!name) return;
      const dates = await vscode.window.showInputBox({ prompt: 'Dates (optional): YYYY-MM-DD YYYY-MM-DD' });
      const [start, end] = (dates ?? '').split(/\s+/).filter(Boolean);
      store.add('sprints', { projectId: p.id, name, start, end, active: false });
    }),

    cmd('lexCode.startSprint', (node: Node) => {
      if (node.kind !== 'sprint' || !node.sprint) return;
      for (const s of store.all().sprints.filter(s => s.projectId === node.project.id && !s.epicId)) {
        store.update('sprints', s.id, { active: s.id === node.sprint.id });
      }
    }),

    cmd('lexCode.newStory', async (node?: Node) => {
      const p = await pickProject(node);
      if (!p) return;
      const title = await vscode.window.showInputBox({ prompt: `New story in ${p.name}` });
      if (!title) return;
      const b = store.all();
      // Created under an epic/sprint node → inherits them; from palette → ask epic, use active sprint.
      const underEpic = node?.kind === 'epic' || node?.kind === 'sprint';
      const epics = b.epics.filter(e => e.projectId === p.id);
      const epicId = underEpic ? node.epic?.id : epics.length ? (await vscode.window.showQuickPick(
        [{ label: '(no epic)', id: undefined as string | undefined }, ...epics.map(e => ({ label: e.title, id: e.id }))],
        { placeHolder: 'Epic' }))?.id : undefined;
      const sprintId = node?.kind === 'sprint' ? node.sprint?.id
        : b.sprints.find(s => s.projectId === p.id && s.active)?.id;
      const pts = await vscode.window.showInputBox({ prompt: 'Points (optional)', validateInput: v => v && isNaN(+v) ? 'Number' : undefined });
      store.add('stories', { projectId: p.id, title, status: 'todo', epicId, sprintId, points: pts ? +pts : undefined });
    }),

    cmd('lexCode.editStory', async (node: Node) => {
      if (node.kind !== 'story') return;
      const s = node.story;
      const title = await vscode.window.showInputBox({ prompt: 'Title', value: s.title });
      if (title === undefined) return;
      const description = await vscode.window.showInputBox({ prompt: 'Description (sent to Claude)', value: s.description ?? '' });
      const b = store.all();
      const sprint = await vscode.window.showQuickPick(
        [{ label: 'Backlog', id: undefined as string | undefined },
          ...b.sprints.filter(x => x.projectId === s.projectId).map(x => ({ label: x.name, id: x.id }))],
        { placeHolder: 'Sprint' });
      store.update('stories', s.id, { title, description, sprintId: sprint ? sprint.id : s.sprintId });
    }),

    cmd('lexCode.setStatus', async (node: Node) => {
      if (node.kind !== 'story') return;
      const status = await vscode.window.showQuickPick(statuses, { placeHolder: `Status (now ${node.story.status})` });
      if (status) store.update('stories', node.story.id, { status: status as Status });
    }),

    cmd('lexCode.resumeSession', (node: Node) => {
      if (node.kind === 'session') return resumeSession(node.project, node.session.id);
    }),

    cmd('lexCode.claudeStory', async (node: Node, forceNew = false) => {
      if (node.kind !== 'story') return;
      const project = store.all().projects.find(p => p.id === node.story.projectId);
      if (!project) return;
      const sessionId = await openStorySession(project, node.story, store.attachmentsDir(node.story.id), forceNew);
      if (!sessionId) return;
      // Re-read: the extension path polls for up to 2 min while the story may have changed.
      store.reload();
      const story = store.all().stories.find(s => s.id === node.story.id);
      if (story) store.update('stories', story.id, {
        sessionIds: [...new Set([...(story.sessionIds ?? []), sessionId])],
        status: story.status === 'todo' ? 'doing' : story.status });
    }),

    cmd('lexCode.deleteItem', async (node: Node) => {
      if (node.kind === 'story') store.remove('stories', node.story.id);
      else if (node.kind === 'sprint' && node.sprint) {
        // Stories fall back to backlog rather than being deleted.
        for (const s of store.all().stories.filter(s => s.sprintId === node.sprint!.id)) store.update('stories', s.id, { sprintId: undefined });
        store.remove('sprints', node.sprint.id);
      } else if (node.kind === 'epic' && node.epic) {
        // Stories move to "No epic" rather than being deleted.
        for (const s of store.all().stories.filter(s => s.epicId === node.epic!.id)) store.update('stories', s.id, { epicId: undefined });
        store.remove('epics', node.epic.id);
      }
    }),
  );
}

export function deactivate() {}
