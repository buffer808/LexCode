// Slash commands of `lexcode tui`, as data: the / menu, completion and /help all read this list.
// Epics-view commands run the selected epic's action of the same name (epicView keys, see EPIC_KEYS).
export type View = 'tasks' | 'epics';
export interface Command { name: string; args?: string; help: string; view?: View }

export const COMMANDS: Command[] = [
  { name: 'new', args: '<title>', help: 'New story in this project (or just type it)' },
  { name: 'attach', args: '[@task] [--new]', help: 'Open the task\'s Claude session; --new starts a fresh one' },
  { name: 'move', args: '<todo|doing|review|done> [@task]', help: 'Change a task\'s status', view: 'tasks' },
  { name: 'delete', args: '[@task]', help: 'Delete a task', view: 'tasks' },
  { name: 'epic', help: 'Start a factory epic' },
  { name: 'tasks', help: 'Tasks view' },
  { name: 'epics', help: 'Epics view' },
  { name: 'project', args: '<name>', help: 'Switch project' },
  { name: 'next', help: 'Jump to the next thing waiting on you' },
  { name: 'approve', help: 'Approve the plan', view: 'epics' },
  { name: 'changes', help: 'Request plan changes', view: 'epics' },
  { name: 'reject', help: 'Reject the plan', view: 'epics' },
  { name: 'plan', help: 'Read the plan', view: 'epics' },
  { name: 'plan-source', help: 'Plan as markdown source', view: 'epics' },
  { name: 'start', help: 'Start building', view: 'epics' },
  { name: 'pause', help: 'Pause building', view: 'epics' },
  { name: 'resume', help: 'Resume building', view: 'epics' },
  { name: 'builders', help: 'How many sprints build at once', view: 'epics' },
  { name: 'merge', help: 'Approve the sprint\'s merge', view: 'epics' },
  { name: 'send-back', help: 'Send the sprint back to its builder', view: 'epics' },
  { name: 'retry', help: 'Retry the failed step', view: 'epics' },
  { name: 'skip', help: 'Skip the stuck story', view: 'epics' },
  { name: 'pr', help: 'Open the PR', view: 'epics' },
  { name: 'pr-opened', help: 'Record the PR a skill opened', view: 'epics' },
  { name: 'open-pr', help: 'Open the PR in the browser', view: 'epics' },
  { name: 'cancel', help: 'Cancel the epic', view: 'epics' },
  { name: 'shell', help: 'Shell in the project folder' },
  { name: 'add-project', help: 'Track another project folder' },
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
  const ok = COMMANDS.filter(c => !c.view || c.view === view);
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
