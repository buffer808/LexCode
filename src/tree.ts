import * as vscode from 'vscode';
import { Store, Project, Epic, Sprint, Story } from './store';
import { listSessions, Session } from './sessions';
import { STAGE_LABEL, PLANNING } from './factory';
import { Agent, liveRun, storySessions } from './claude';

// epic undefined = "No epic" group; sprint undefined = backlog.
export type Node =
  | { kind: 'project'; project: Project }
  | { kind: 'epic'; project: Project; epic?: Epic }
  | { kind: 'sprint'; project: Project; epic?: Epic; sprint?: Sprint }
  | { kind: 'story'; story: Story }
  | { kind: 'sessions'; project: Project }
  | { kind: 'session'; project: Project; session: Session };

const statusIcon = { todo: 'circle-large-outline', doing: 'sync', review: 'eye', done: 'pass-filled' };

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export class BoardTree implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private store: Store, private agents: () => Record<string, Agent> = () => ({})) {}

  // Group icon: ⚠ if any story run waits for approval, spinner if one is running (or `busy`), else `icon`.
  private groupIcon(stories: Story[], icon: string, busy = false) {
    const runs = stories.map(s => liveRun(s, this.agents())).filter(Boolean);
    return runs.some(r => r!.state === 'blocked') ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : busy || runs.length ? new vscode.ThemeIcon('loading~spin') : new vscode.ThemeIcon(icon);
  }

  refresh() { this.store.reload(); this.changed.fire(); }

  getChildren(node?: Node): Node[] {
    const b = this.store.all();
    if (!node) return b.projects.map(project => ({ kind: 'project', project }));
    if (node.kind === 'project') {
      const p = node.project;
      const epics: Node[] = b.epics.filter(e => e.projectId === p.id && !e.archived).map(epic => ({ kind: 'epic', project: p, epic }));
      const hasLoose = b.stories.some(s => s.projectId === p.id && !s.epicId);
      return [...epics, ...(hasLoose || !epics.length ? [{ kind: 'epic', project: p } as Node] : []), { kind: 'sessions', project: p }];
    }
    if (node.kind === 'epic') {
      // Sprints are project-wide; show one under an epic if it holds that epic's stories,
      // is active, or is still empty (so "+ story" there sets both epic and sprint).
      const live = b.stories.filter(s => s.projectId === node.project.id && !s.archived);
      // Factory sprints belong to one epic and only show there.
      // A sprint whose stories are all archived is archived too; an empty one is still new.
      const spent = (sp: Sprint) => { const own = b.stories.filter(s => s.sprintId === sp.id); return own.length > 0 && own.every(s => s.archived); };
      const sprints = b.sprints.filter(sp => sp.projectId === node.project.id && !spent(sp) && (sp.epicId ? sp.epicId === node.epic?.id : sp.active
        || live.some(s => s.sprintId === sp.id && s.epicId === node.epic?.id)
        || !live.some(s => s.sprintId === sp.id)))
        .sort((x, y) => Number(y.active) - Number(x.active) || (x.order ?? 0) - (y.order ?? 0));
      return [...sprints.map(sprint => ({ kind: 'sprint' as const, project: node.project, epic: node.epic, sprint })),
        { kind: 'sprint', project: node.project, epic: node.epic }];
    }
    if (node.kind === 'sprint') {
      return b.stories
        .filter(s => s.projectId === node.project.id && s.sprintId === node.sprint?.id && s.epicId === node.epic?.id && !s.archived)
        .map(story => ({ kind: 'story', story }));
    }
    if (node.kind === 'sessions') {
      return listSessions(node.project.path).map(session => ({ kind: 'session', project: node.project, session }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    const b = this.store.all();
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.project.name, C.Expanded);
      item.tooltip = node.project.path;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'project';
      return item;
    }
    if (node.kind === 'epic') {
      const item = new vscode.TreeItem(node.epic ? `Epic: ${node.epic.title}` : 'No epic', C.Collapsed);
      const n = b.stories.filter(s => s.projectId === node.project.id && s.epicId === node.epic?.id);
      const stage = node.epic?.stage && STAGE_LABEL[node.epic.stage];
      item.description = `${stage ? `${stage}${node.epic!.error ? ' ⚠' : ''} · ` : ''}${n.filter(s => s.status === 'done').length}/${n.length} done`;
      if (node.epic?.error) item.tooltip = node.epic.error;
      const stg = node.epic?.stage;
      item.iconPath = this.groupIcon(n.filter(s => !s.archived), node.epic ? 'layers' : 'layers-dot', stg === 'building' || PLANNING.includes(stg!));
      item.contextValue = node.epic ? 'epic' : 'noEpic';
      return item;
    }
    if (node.kind === 'sprint') {
      const s = node.sprint;
      const item = new vscode.TreeItem(s ? s.name : 'Backlog', s?.active ? C.Expanded : C.Collapsed);
      item.description = s?.active ? 'active' : s && [s.start, s.end].filter(Boolean).join(' → ');
      item.iconPath = this.groupIcon(this.getChildren(node).map(c => (c as { story: Story }).story), s ? 'milestone' : 'inbox');
      item.contextValue = s ? 'sprint' : 'backlog';
      return item;
    }
    if (node.kind === 'sessions') {
      const item = new vscode.TreeItem('Claude sessions', C.Collapsed);
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      return item;
    }
    if (node.kind === 'session') {
      const item = new vscode.TreeItem(node.session.title, C.None);
      item.description = ago(node.session.mtime);
      item.tooltip = `${node.session.id}\n${new Date(node.session.mtime).toLocaleString()}`;
      item.iconPath = new vscode.ThemeIcon('history');
      item.command = { command: 'lexCode.resumeSession', title: 'Resume', arguments: [node] };
      return item;
    }
    const st = node.story;
    const item = new vscode.TreeItem(st.title, C.None);
    const n = storySessions(st).length, run = liveRun(st, this.agents());
    item.description = [st.status, st.points != null && `${st.points}pt`,
      run ? (run.state === 'blocked' ? '⚠ needs approval' : run.state) : n && `${n} session${n > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
    item.tooltip = st.description;
    item.iconPath = run?.state === 'blocked' ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : run ? new vscode.ThemeIcon('loading~spin') : new vscode.ThemeIcon(statusIcon[st.status]);
    item.contextValue = run ? 'story live' : n ? 'story linked' : 'story';
    return item;
  }
}
