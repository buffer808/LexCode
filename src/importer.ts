import * as fs from 'fs';
import * as path from 'path';
import { Store, Status, Story, SourceRef } from './store';

export interface ParsedStory {
  title: string; status: Status; epic?: string; sprint?: string; description?: string;
  source?: SourceRef; refs?: string[];
}
export interface Parsed { epics: string[]; sprints: string[]; stories: ParsedStory[] }

export const DEFAULT_SKIP = ['node_modules', '.git', 'out', 'dist', 'build', '.next', 'vendor', '.venv', 'target'];

// Breadth-first so the shallowest TASKS.md wins.
export function findTasksFile(root: string, skip: string[] = DEFAULT_SKIP, maxDepth = 6): string | undefined {
  const SKIP = new Set(skip);
  let level = [root];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const hit = entries.find(e => e.isFile() && e.name.toLowerCase() === 'tasks.md');
      if (hit) return path.join(dir, hit.name);
      for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, '').trim();
// Done/archived markers: struck through, ✅, or a word like "(done)", "[archived]", "status: closed".
const CLOSED = /^~~.*~~$|✅|\b(done|completed?|closed|archived?|finished|cancell?ed|obsolete)\b/i;

// Markdown convention:
//   "## Epic: X" / "## Sprint 3" / "## Backlog" headings set context for the list items below them.
//   List items become stories when checkboxes ("- [ ]", "- [x]" = done), under an epic/sprint/backlog,
//   or inside a *stor*/*backlog* file. Indented items join the parent story's description.
//   In *epic* / *sprint* files every ##+ heading is an epic / sprint.
//   Local links to .md files are followed (once each), except *archive* / *done* files.
//   Only open work is kept: done/archived stories ([x], [-], CLOSED), everything under a closed
//   heading, and epics/sprints whose stories are all done are dropped. [~] / [/] = doing.
//   Each story records its file:line (or a trailing "<!-- src: /abs/file.md:12 -->" override) and
//   refs: the root task file, its own file, and the files defining its epic and sprint.
export function parseTasks(file: string): Parsed {
  const out: Parsed = { epics: [], sprints: [], stories: [] };
  const done: ParsedStory[] = []; // closed stories, only used to spot all-done epics/sprints
  const seen = new Set<string>();
  const queue = [path.resolve(file)];
  const addUnique = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  const root = path.resolve(file);
  const defined = new Map<string, string>(); // "e:<epic>" / "s:<sprint>" -> file it was first declared in
  const declare = (k: string, f: string) => { if (!defined.has(k)) defined.set(k, f); };

  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    let text: string;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }

    const base = path.basename(f).toLowerCase();
    const kind = /epic/.test(base) ? 'epic' : /sprint/.test(base) ? 'sprint' : /stor|backlog/.test(base) ? 'stories' : 'tasks';
    let epic: string | undefined, sprint: string | undefined, inBacklog = false;
    let last: ParsedStory | undefined;
    let closedLevel = 0; // inside a closed heading of this level until a heading at <= level

    for (const [i, line] of text.split(/\r?\n/).entries()) {
      for (const [, href] of line.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gi)) {
        if (!/^[a-z]+:/i.test(href) && !/archive|done/i.test(path.basename(href))) queue.push(path.resolve(path.dirname(f), decodeURI(href)));
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length, t = clean(h[2]);
        last = undefined;
        if (closedLevel && level > closedLevel) continue;
        closedLevel = CLOSED.test(h[2].trim()) ? level : 0;
        if (closedLevel) { epic = sprint = undefined; inBacklog = false; continue; }
        const em = t.match(/^epic\b[\s:#\d.-]*(.*)$/i), sm = /^sprint\b/i.test(t);
        if (em) { epic = clean(em[1]) || t; addUnique(out.epics, epic); declare('e:' + epic, f); inBacklog = false; }
        else if (sm) { sprint = t; addUnique(out.sprints, sprint); declare('s:' + sprint, f); inBacklog = false; }
        else if (/backlog/i.test(t)) { sprint = undefined; inBacklog = true; }
        else if (level >= 2 && kind === 'epic') { epic = t; addUnique(out.epics, epic); declare('e:' + epic, f); }
        else if (level >= 2 && kind === 'sprint') { sprint = t; addUnique(out.sprints, sprint); declare('s:' + sprint, f); }
        continue;
      }

      const li = line.match(/^(\s*)[-*+]\s+(?:\[([ xX~/-])\]\s+)?(.*)$/);
      if (!li || closedLevel) continue;
      const [, indent, box, raw] = li;
      const src = raw.match(/\s*<!--\s*src:\s*(.+):(\d+)\s*-->\s*$/);
      const rest = src ? raw.slice(0, src.index) : raw;
      const title = clean(rest.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
      if (!title) continue;
      if (indent.length >= 2 && last) {
        last.description = (last.description ? last.description + '\n' : '') + '- ' + title;
        continue;
      }
      const onlyLink = /^\[[^\]]*\]\([^)]*\)\s*$/.test(rest.trim());
      const isStory = !onlyLink && (box !== undefined || epic || sprint || inBacklog || kind === 'stories');
      if (!isStory) { last = undefined; continue; }
      const source = src ? { file: path.resolve(path.dirname(f), src[1].trim()), line: +src[2] } : { file: f, line: i + 1 };
      last = { title, status: box && /[~/]/.test(box) ? 'doing' : 'todo', epic, sprint, source,
        refs: [...new Set([root, source.file, epic && defined.get('e:' + epic), sprint && defined.get('s:' + sprint)]
          .filter((x): x is string => !!x))] };
      if (box && /[xX-]/.test(box) || CLOSED.test(rest.trim())) { done.push(last); last = undefined; continue; }
      out.stories.push(last);
    }
  }
  const allDone = (has: (s: ParsedStory) => boolean) => done.some(has) && !out.stories.some(has);
  out.epics = out.epics.filter(e => !allDone(s => s.epic === e));
  out.sprints = out.sprints.filter(n => !allDone(s => s.sprint === n));
  return out;
}

// Re-import safe: existing epics/sprints/stories with the same title (case-insensitive) are skipped.
export function importInto(store: Store, projectId: string, parsed: Parsed) {
  store.reload();
  const b = store.all();
  const key = (s: string) => s.toLowerCase();
  const epics = new Map(b.epics.filter(e => e.projectId === projectId).map(e => [key(e.title), e.id]));
  const sprints = new Map(b.sprints.filter(s => s.projectId === projectId).map(s => [key(s.name), s.id]));
  const stories = new Set(b.stories.filter(s => s.projectId === projectId).map(s => key(s.title)));
  const n = { epics: 0, sprints: 0, stories: 0 };

  for (const t of parsed.epics) if (!epics.has(key(t))) { epics.set(key(t), store.add('epics', { projectId, title: t }).id); n.epics++; }
  for (const t of parsed.sprints) if (!sprints.has(key(t))) { sprints.set(key(t), store.add('sprints', { projectId, name: t, active: false }).id); n.sprints++; }
  for (const s of parsed.stories) {
    if (stories.has(key(s.title))) continue;
    stories.add(key(s.title));
    store.add('stories', {
      projectId, title: s.title, status: s.status, description: s.description, source: s.source, refs: s.refs,
      epicId: s.epic && epics.get(key(s.epic)), sprintId: s.sprint && sprints.get(key(s.sprint)),
    });
    n.stories++;
  }
  return n;
}

// Instructions for the Claude session that vets TASKS.md before import; it writes `out` in the format parseTasks reads.
export const reviewPrompt = (root: string, tasksFile: string, out: string) => `Help me import this project's existing backlog into LexCode.

Project: ${root}
Task list: ${tasksFile} (also read the .md files it links to: epics, sprints, stories, backlogs).

1. Read the task files and list every epic, sprint and story.
2. For each one, check the codebase (and git log if useful) to judge whether it is already done, partly done, or not started. Cite the file or commit that shows it.
3. Show me a short table: item, your verdict, evidence. Ask me to confirm or correct it. Don't change any project files.
4. Once I agree, write ONLY the items still to do to ${out}, in this exact format:

## Epic: <epic title>
- [ ] <story title> <!-- src: /absolute/path/of/file/it/came/from.md:<line number> -->
  - <optional detail line>
## Sprint <number or name>
- [~] <story already in progress>
## Backlog
- [ ] <story with no sprint>

Keep the src comment on every story so LexCode can tick it off in the original file later. A story belongs to the nearest Epic heading above it and to the nearest Sprint heading above it. Leave out finished or obsolete work entirely. LexCode opens its import picker as soon as that file exists, so write it once, at the end.`;

const MARK: Record<Status, string> = { todo: ' ', doing: '~', review: '~', done: 'x' };

// Writes the story's status into its source checkbox. Looks at the recorded line first, then
// searches the file for the title (lines move as people edit). Missing file/line: no-op.
export function syncSource(s: Story): boolean {
  if (!s.source) return false;
  let lines: string[];
  try { lines = fs.readFileSync(s.source.file, 'utf8').split('\n'); } catch { return false; }
  const item = /^(\s*[-*+]\s+)(\[[ xX~/-]\]\s+)?(.*)$/;
  const matches = (l: string) => { const m = l.match(item); return !!m && clean(m[3].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).toLowerCase().startsWith(s.title.toLowerCase()); };
  const at = s.source.line - 1;
  const i = matches(lines[at] ?? '') ? at : lines.findIndex(matches);
  if (i < 0) return false;
  const next = lines[i].replace(item, (_, lead, _box, rest) => `${lead}[${MARK[s.status]}] ${rest}`);
  if (next === lines[i]) return true;
  lines[i] = next;
  fs.writeFileSync(s.source.file, lines.join('\n'));
  return true;
}
