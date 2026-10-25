// Slash commands of `lexcode tui`, as data: the / menu, completion and /help all read this list.
// Epics-view commands run the selected epic's action of the same name (epicView keys, see EPIC_KEYS).
export type View = 'tasks' | 'board' | 'epics' | 'projects';
export const VIEWS: View[] = ['tasks', 'board', 'epics', 'projects']; // shift+tab order
export interface Command { name: string; args?: string; help: string; views?: View[] }

export const COMMANDS: Command[] = [
  { name: 'new', args: '<title>', help: 'New story in this project (or just type it)' },
  { name: 'attach', args: '[@task] [--new] [--tab]', help: 'Open the task\'s Claude session; --new starts a fresh one, --tab in a new terminal tab' },
  { name: 'split', args: '[@task]', help: 'Claude beside the list instead of over it (120+ columns)' },
  { name: 'move', args: '<todo|doing|review|done> [@task]', help: 'Change a task\'s status', views: ['tasks', 'board'] },
  { name: 'delete', args: '[@task]', help: 'Delete a task', views: ['tasks', 'board'] },
  { name: 'epic', help: 'Start a factory epic' },
  { name: 'tasks', help: 'Tasks view' },
  { name: 'board', help: 'Kanban board of this project' },
  { name: 'epics', help: 'Epics view' },
  { name: 'projects', help: 'Every project at a glance' },
  { name: 'project', args: '<name>', help: 'Switch project' },
  { name: 'next', help: 'Jump to the next thing waiting on you' },
  { name: 'approve', help: 'Approve the plan', views: ['epics'] },
  { name: 'changes', help: 'Request plan changes', views: ['epics'] },
  { name: 'reject', help: 'Reject the plan', views: ['epics'] },
  { name: 'plan', help: 'Read the plan', views: ['epics'] },
  { name: 'plan-source', help: 'Plan as markdown source', views: ['epics'] },
  { name: 'start', help: 'Start building', views: ['epics'] },
  { name: 'pause', help: 'Pause building', views: ['epics'] },
  { name: 'resume', help: 'Resume building', views: ['epics'] },
  { name: 'builders', help: 'How many sprints build at once', views: ['epics'] },
  { name: 'merge', help: 'Approve the sprint\'s merge', views: ['epics'] },
  { name: 'send-back', help: 'Send the sprint back to its builder', views: ['epics'] },
  { name: 'retry', help: 'Retry the failed step', views: ['epics'] },
  { name: 'skip', help: 'Skip the stuck story', views: ['epics'] },
  { name: 'pr', help: 'Open the PR', views: ['epics'] },
  { name: 'pr-opened', help: 'Record the PR a skill opened', views: ['epics'] },
  { name: 'open-pr', help: 'Open the PR in the browser', views: ['epics'] },
  { name: 'cancel', help: 'Cancel the epic', views: ['epics'] },
  { name: 'shell', help: 'Shell in the project folder' },
  { name: 'add-project', help: 'Track another project folder' },
  { name: 'remove-project', help: 'Stop tracking this project' },
  { name: 'import', help: 'Import TASKS.md' },
  { name: 'reload', help: 'Reload the board' },
  { name: 'help', help: 'List commands and keys' },
  { name: 'quit', help: 'Leave LexCode (sessions keep running)' },
];

// epicView key letter → command name. 'p' is pause or resume, by its label.
const EPIC_KEYS: Record<string, string> = { a: 'attach', v: 'plan', V: 'plan-source', y: 'approve', C: 'changes', X: 'reject', s: 'start',
  w: 'builders', m: 'merge', b: 'send-back', R: 'retry', S: 'skip', P: 'pr', u: 'pr-opened', o: 'open-pr', x: 'cancel' };
export const epicCommand = (key: string, label: string) => key === 'p' ? label : EPIC_KEYS[key];

// Menu entries for a partial "/na": prefix matches first, then substring, current view only.
export function complete(partial: string, view: View): Command[] {
  const q = partial.replace(/^\//, '').toLowerCase();
  const ok = COMMANDS.filter(c => !c.views || c.views.includes(view));
  return [...ok.filter(c => c.name.startsWith(q)), ...ok.filter(c => !c.name.startsWith(q) && c.name.includes(q))];
}

// "/move review @login" → { name: 'move', args: ['review'], refs: ['login'], flags: [] }
export function parse(text: string) {
  const [head, ...words] = text.trim().slice(1).split(/\s+/);
  return { name: head.toLowerCase(), args: words.filter(w => !/^[@-]/.test(w) || w === '-'), refs: words.filter(w => w.startsWith('@')).map(w => w.slice(1)),
    flags: words.filter(w => w.startsWith('--')).map(w => w.slice(2)) };
}

// Best match for "@log" among names: prefix of a word first, then anywhere, case-insensitive.
export function pick<T>(items: T[], name: (t: T) => string, q: string): T | undefined {
  const s = q.toLowerCase();
  return items.find(t => name(t).toLowerCase().split(/\s+/).some(w => w.startsWith(s))) ?? items.find(t => name(t).toLowerCase().includes(s));
}
