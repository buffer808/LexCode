import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';

export type Status = 'todo' | 'doing' | 'review' | 'done';

export interface Project { id: string; name: string; path: string; pr?: { via: PrVia; skill?: string } } // pr: last way a PR was opened
// gh = GitHub CLI, tea = Gitea (with the `tea` login's token), skill = a Claude Code skill such as /git-release.
export type PrVia = 'gh' | 'tea' | 'skill';

/* ---------- software factory (epic → plan → build → review → PR) ---------- */
export type EpicStage = 'planning' | 'revalidating' | 'securityCheck' | 'awaitingPlanApproval'
  | 'ready' | 'building' | 'paused' | 'awaitingPrApproval' | 'done' | 'failed' | 'cancelled';
export type Role = 'orchestrator' | 'revalidator' | 'security' | 'builder' | 'reviewer';
export type ModelRole = 'planner' | 'builder' | 'reviewer'; // planner = orchestrator, revalidator, security
export interface ModelChoice { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
// Epic-level human decision. Merge and retry decisions live on the sprint/story (awaitingMerge, blocked).
// pr gate: busy = when pushing/creating started (stale after a reload, so it's a time); skill = a PR skill was started and LexCode waits for its URL; reason = last error.
export interface Gate { kind: 'plan' | 'pr'; reason?: string; busy?: number; skill?: string }

export interface Epic {
  id: string; projectId: string; title: string;
  description?: string;
  stage?: EpicStage; // undefined = manual epic (legacy/imported); the factory ignores it
  baseBranch?: string; targetBranch?: string; branch?: string;
  workers?: number;
  builderMode?: 'acceptEdits' | 'auto';
  models?: Partial<Record<ModelRole, ModelChoice>>;
  roleAgents?: Partial<Record<Role, string>>; // role → agent name, frozen at creation
  reviewers?: string[]; // sprint review panel next to revalidator + security; '' = LexCode reviewer
  stageSessionId?: string; stageStartedAt?: number; stageAttempts?: number;
  feedback?: string; // human "request changes" text for the next planning run
  pending?: Gate;
  prUrl?: string; error?: string;
  attachments?: Attachment[]; // reference files (screenshots, mockups) handed to every factory session
}
export interface Sprint {
  id: string; projectId: string; name: string; start?: string; end?: string; active: boolean;
  // Factory sprints belong to an epic; the single-active-sprint rule only applies to sprints without one.
  epicId?: string; key?: string; order?: number; dependsOn?: string[]; parallel?: boolean;
  branch?: string; worktree?: string;
  state?: SprintState;
  sessionId?: string; runStartedAt?: number; // fix session
  reviews?: SprintReview[];                   // sprint review panel, run in parallel; all must pass
  attempts?: number; fixups?: number;        // failed sprint reviews; invalid-output corrections
  issues?: string[]; risk?: 'minor' | 'critical';
  critical?: string[]; // reasons the merge waits for human approval (state awaitingMerge)
  blocked?: string;    // needs a human: retries exhausted, invalid output, launch error
}
// One reviewer of a sprint: the revalidator and security agents again (now on the code), plus each picked reviewer.
export interface SprintReview {
  lens: 'revalidator' | 'security' | 'reviewer'; agent?: string; // agent undefined = LexCode's bundled prompt
  sessionId?: string; startedAt?: number; fixups?: number;
  verdict?: { pass: boolean; risk: 'minor' | 'critical'; issues: string[] };
}
export type SprintState = 'waiting' | 'building' | 'reviewing' | 'fixing' | 'awaitingMerge' | 'merged';
export interface Attachment { id: string; name: string; file: string; mime: string }
export interface Story {
  id: string; projectId: string; title: string; status: Status;
  epicId?: string; sprintId?: string; points?: number; description?: string;
  sessionIds?: string[]; attachments?: Attachment[];
  archived?: boolean; // hidden from board/tree unless "Show archived"
  // Imported stories: line the story came from (status is written back there) and related task files.
  source?: SourceRef; refs?: string[];
  // Factory: builder → reviewer loop bookkeeping.
  attempts?: number; fixups?: number; reviewNotes?: string; builderSessionId?: string; reviewerSessionId?: string;
  baseCommit?: string; runStartedAt?: number;
  blocked?: string; // needs a human: retries exhausted, invalid output, launch error
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

  // Attachment files live beside board.json: attachments/<storyId or epicId>/<file>.
  attachmentsDir(ownerId?: string) {
    const root = path.join(path.dirname(this.file), 'attachments');
    return ownerId ? path.join(root, ownerId) : root;
  }

  // Tasks kept when a project is removed: archive/<hash of path>.json, restored when that path is re-added.
  private archiveFile(projectPath: string) {
    return path.join(path.dirname(this.file), 'archive', createHash('sha1').update(projectPath).digest('hex') + '.json');
  }

  reload() { this.board = Store.load(this.file); }

  all(): Board { return this.board; }

  // Deepest tracked project containing dir, so a subfolder works too.
  projectFor(dir: string): Project | undefined {
    const d = path.resolve(dir);
    return this.board.projects.filter(p => d === p.path || d.startsWith(p.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

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
      const gone = c === 'stories' || c === 'epics' ? [id] : project && !keepTasks ? [...b.stories, ...b.epics].filter(s => s.projectId === id).map(s => s.id) : [];
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
