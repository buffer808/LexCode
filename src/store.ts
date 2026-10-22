import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';

export type Status = 'todo' | 'doing' | 'review' | 'done';

export interface Project { id: string; name: string; path: string }
export interface Epic { id: string; projectId: string; title: string }
export interface Sprint { id: string; projectId: string; name: string; start?: string; end?: string; active: boolean }
export interface Attachment { id: string; name: string; file: string; mime: string }
export interface Story {
  id: string; projectId: string; title: string; status: Status;
  epicId?: string; sprintId?: string; points?: number; description?: string;
  sessionIds?: string[]; attachments?: Attachment[];
  archived?: boolean; // hidden from board/tree unless "Show archived"
  // Imported stories: line the story came from (status is written back there) and related task files.
  source?: SourceRef; refs?: string[];
}
export interface SourceRef { file: string; line: number }

export interface Board { projects: Project[]; epics: Epic[]; sprints: Sprint[]; stories: Story[] }

type Collection = keyof Board;

// Board persisted as one JSON file; shared by every window using the same globalStorage.
export class Store {
  private board: Board;

  // onStatus: called after a story's status changes (used to write imported stories back to their markdown).
  constructor(private file: string, private onStatus?: (s: Story) => void) {
    this.board = Store.load(file);
  }

  private static load(file: string): Board {
    const empty: Board = { projects: [], epics: [], sprints: [], stories: [] };
    try {
      const b: Board = { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      // v0.0.1 stored one session per story.
      for (const st of b.stories as (Story & { sessionId?: string })[]) {
        if (st.sessionId) { st.sessionIds = [...new Set([...(st.sessionIds ?? []), st.sessionId])]; delete st.sessionId; }
      }
      return b;
    } catch (e: any) {
      if (e.code === 'ENOENT') return empty;
      throw e; // corrupt file: don't silently overwrite user data
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.board, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Re-read before every mutation so concurrent windows don't clobber each other's writes.
  // ponytail: last-writer-wins within the same millisecond, add file lock if that bites.
  private mutate<T>(fn: (b: Board) => T): T {
    this.board = Store.load(this.file);
    const r = fn(this.board);
    this.save();
    return r;
  }

  // Attachment files live beside board.json: attachments/<storyId>/<file>.
  attachmentsDir(storyId?: string) {
    const root = path.join(path.dirname(this.file), 'attachments');
    return storyId ? path.join(root, storyId) : root;
  }

  // Tasks kept when a project is removed: archive/<hash of path>.json, restored when that path is re-added.
  private archiveFile(projectPath: string) {
    return path.join(path.dirname(this.file), 'archive', createHash('sha1').update(projectPath).digest('hex') + '.json');
  }

  reload() { this.board = Store.load(this.file); }

  all(): Board { return this.board; }

  add<C extends Collection>(c: C, item: Omit<Board[C][number], 'id'>): Board[C][number] {
    return this.mutate(b => {
      const created = { ...item, id: randomUUID() } as Board[C][number];
      (b[c] as Board[C][number][]).push(created);
      if (c === 'projects') this.restore(b, created as Project);
      return created;
    });
  }

  update<C extends Collection>(c: C, id: string, patch: Partial<Board[C][number]>) {
    const item = this.mutate(b => {
      const item = (b[c] as { id: string }[]).find(x => x.id === id);
      if (!item) throw new Error(`${c} ${id} not found`);
      return Object.assign(item, patch);
    });
    if (c === 'stories' && 'status' in patch) this.onStatus?.(item as Story);
  }

  private restore(b: Board, p: Project) {
    const file = this.archiveFile(p.path);
    if (!fs.existsSync(file)) return;
    const a: Pick<Board, 'epics' | 'sprints' | 'stories'> = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of ['epics', 'sprints', 'stories'] as const) {
      for (const x of a[c]) (b[c] as { projectId: string }[]).push({ ...x, projectId: p.id });
    }
    fs.rmSync(file);
  }

  // keepTasks (projects only): archive its epics/sprints/stories + attachments for a later re-add.
  remove(c: Collection, id: string, keepTasks = false) {
    this.mutate(b => {
      const project = c === 'projects' ? b.projects.find(p => p.id === id) : undefined;
      if (project && keepTasks) {
        const own = <T extends { projectId: string }>(xs: T[]) => xs.filter(x => x.projectId === id);
        const file = this.archiveFile(project.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ epics: own(b.epics), sprints: own(b.sprints), stories: own(b.stories) }, null, 2));
      }
      const gone = c === 'stories' ? [id] : project && !keepTasks ? b.stories.filter(s => s.projectId === id).map(s => s.id) : [];
      for (const s of gone) fs.rmSync(this.attachmentsDir(s), { recursive: true, force: true });
      (b[c] as { id: string }[]) = (b[c] as { id: string }[]).filter(x => x.id !== id);
      if (c === 'projects') {
        b.epics = b.epics.filter(x => x.projectId !== id);
        b.sprints = b.sprints.filter(x => x.projectId !== id);
        b.stories = b.stories.filter(x => x.projectId !== id);
      }
    });
  }
}
