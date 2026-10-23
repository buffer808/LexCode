import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { Project, Story, Store } from './store';
import { listSessions, sessionExists } from './sessions';

const EXT_ID = 'anthropic.claude-code';
// claude-vscode.primaryEditor.open(sessionId?, prompt?) — same entry the extension's vscode://…/open URI uses.
const EXT_OPEN = 'claude-vscode.primaryEditor.open';

const useExtension = () =>
  vscode.workspace.getConfiguration('lexCode').get('claudeLauncher') !== 'cli' && !!vscode.extensions.getExtension(EXT_ID);

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function terminal(project: Project, args: string) {
  const t = vscode.window.createTerminal({ name: `Claude · ${project.name}`, cwd: project.path });
  t.show();
  t.sendText(`${shellQuote(claudeBin())} ${args}`);
}

export async function resumeSession(project: Project, sessionId: string) {
  if (useExtension()) await vscode.commands.executeCommand(EXT_OPEN, sessionId);
  else terminal(project, `--resume ${sessionId}`);
}

// Interactive session in a terminal at the project root, whatever folder the editor has open.
export const terminalSession = (project: Project, prompt: string) => terminal(project, shellQuote(prompt));

// Opens an interactive session with `prompt`, no story link.
export async function startSession(project: Project, prompt: string) {
  if (useExtension()) await vscode.commands.executeCommand(EXT_OPEN, undefined, prompt);
  else terminal(project, shellQuote(prompt));
}

// attachDir: the story's attachments folder (Store.attachmentsDir(story.id)); it sits outside the project, hence --add-dir.
function storyPrompt(s: Story, attachDir: string) {
  const files = [...(s.refs ?? []), ...(s.attachments ?? []).map(a => path.join(attachDir, a.file))];
  return [s.title, s.description, files.length && `Related files (read them first):\n${files.map(f => `- ${f}`).join('\n')}`]
    .filter(Boolean).join('\n\n');
}
const addDir = (s: Story, attachDir: string) => s.attachments?.length ? ['--add-dir', attachDir] : [];

// Resumes the story's latest live session, or starts one. Returns the session id to link.
export async function openStorySession(project: Project, story: Story, attachDir: string, forceNew = false): Promise<string | undefined> {
  const latest = [...(story.sessionIds ?? [])].reverse().find(id => sessionExists(project.path, id));
  if (latest && !forceNew) {
    await resumeSession(project, latest);
    return latest;
  }
  if (!useExtension()) {
    const id = randomUUID();
    terminal(project, [...addDir(story, attachDir), '--session-id', id, storyPrompt(story, attachDir)].map(shellQuote).join(' '));
    return id;
  }
  // Extension can't take a session id up front: watch the project's session dir for the new file.
  // ponytail: assumes the extension runs in project.path (first/only workspace folder); else link is missed.
  const before = new Set(listSessions(project.path).map(s => s.id));
  await vscode.commands.executeCommand(EXT_OPEN, undefined, storyPrompt(story, attachDir));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const fresh = listSessions(project.path).find(s => !before.has(s.id));
    if (fresh) return fresh.id;
  }
  vscode.window.showWarningMessage(`Couldn't link Claude session to "${story.title}". Send the prompt, then retry.`);
}

/* ---------- background runs (claude --bg) ---------- */

// "manual" = Claude pauses as `blocked` until the user attaches and approves.
export const PERMISSION_MODES: Record<string, string> = {
  manual: 'Ask me (approve via Attach)',
  acceptEdits: 'Auto-approve file edits',
  plan: 'Plan only (no changes)',
  auto: 'Auto (Claude decides)',
  bypassPermissions: 'Bypass all permissions ⚠',
};

// GUI-launched IDEs often lack the shell PATH, so look in the usual install spots too.
function claudeBin(): string {
  const set = vscode.workspace.getConfiguration('lexCode').get<string>('claudePath');
  if (set) return set;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.map(d => path.join(d, 'claude')).find(f => fs.existsSync(f)) ?? 'claude';
}

const run = promisify(execFile);

// Starts a new background session for the story, or continues `sessionId` with `followUp`.
export async function runInBackground(project: Project, story: Story, attachDir: string, mode: string, sessionId?: string, followUp?: string) {
  if (!(mode in PERMISSION_MODES)) throw new Error(`Unknown permission mode ${mode}`);
  return launchBackground(project, ['--permission-mode', mode, ...addDir(story, attachDir), ...(sessionId ? ['--resume', sessionId] : []),
    sessionId ? followUp ?? 'Continue.' : storyPrompt(story, attachDir)]);
}

// `claude --bg <args>` in `cwd` (default: the project). Returns the real session id:
// --bg picks its own id (it ignores --session-id), printed as "backgrounded · <short id>".
// undefined = folder not trusted yet (user was shown how to fix it).
export async function launchBackground(project: Project, args: string[], cwd = project.path): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await run(claudeBin(), ['--bg', ...args], { cwd, timeout: 60000 }));
  } catch (e: any) {
    const err = String(e?.stderr || e?.message || e).trim();
    if (/not trusted/i.test(err)) {
      // --bg refuses untrusted folders; trusting is the user's call, so open claude there to show the prompt.
      const c = await vscode.window.showErrorMessage(`Claude doesn't trust ${cwd} yet. Accept the trust prompt once, then run again.`, 'Trust folder…');
      if (c) terminal({ ...project, path: cwd }, '');
      return undefined;
    }
    throw new Error(err);
  }
  const short = /backgrounded\s*·\s*([0-9a-f-]+)/i.exec(stdout)?.[1];
  if (!short) throw new Error(`Unexpected claude --bg output: ${stdout.trim().slice(0, 200)}`);
  // Agent registry may lag the launcher by a moment.
  for (let i = 0; i < 5; i++) {
    const hit = Object.values(await backgroundAgents()).find(a => a.id === short);
    if (hit) return hit.sessionId;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Background run ${short} started but isn't listed by \`claude agents\` yet; link it from the session list.`);
}

export interface Agent { id: string; sessionId: string; state: string; name?: string; startedAt?: number }

// Keyed by session id; a resumed session can be listed more than once, newest run wins.
export async function backgroundAgents(): Promise<Record<string, Agent>> {
  const { stdout } = await run(claudeBin(), ['agents', '--json', '--all'], { timeout: 15000 });
  const list: any[] = JSON.parse(stdout);
  const out: Record<string, Agent> = {};
  for (const a of list.filter(a => a.kind === 'background').sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))) {
    out[a.sessionId] = { id: a.id, sessionId: a.sessionId, state: a.state ?? a.status ?? 'unknown', name: a.name, startedAt: a.startedAt };
  }
  return out;
}

// Every session linked to a story: ones you started, plus the factory's builder and reviewer.
export const storySessions = (s: Story) =>
  [...(s.sessionIds ?? []), s.builderSessionId, s.reviewerSessionId].filter((id): id is string => !!id);

// The story's background run still in progress, preferring one that waits for approval.
export function liveRun(s: Story, agents: Record<string, Agent>): Agent | undefined {
  const live = storySessions(s).reverse().map(id => agents[id]).filter(a => a && !['done', 'stopped', 'failed'].includes(a.state));
  return live.find(a => a.state === 'blocked') ?? live[0];
}

export function attach(project: Project, agentId: string) {
  terminal(project, `attach ${agentId}`);
}

// Polls background agents linked to stories and factory epics; notifies on state changes (blocked = needs approval).
// ponytail: spawns `claude agents` every 5s while anything is linked; switch to a file watch if the CLI exposes one.
export class AgentWatcher implements vscode.Disposable {
  agents: Record<string, Agent> = {};
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer = setInterval(() => this.poll(), 5000);
  private busy = false;

  constructor(private store: Store) { this.poll(); }

  async poll() {
    if (this.busy) return;
    const b = this.store.all();
    // Factory stage sessions only alert when blocked; the factory announces its own progress.
    const tracked = new Map<string, { title: string; projectId: string; quiet: boolean }>([
      ...b.stories.flatMap(s => (s.sessionIds ?? []).map(id => [id, { title: s.title, projectId: s.projectId, quiet: false }] as const)),
      ...b.epics.flatMap(e => e.stageSessionId ? [[e.stageSessionId, { title: `${e.title} (${e.stage})`, projectId: e.projectId, quiet: true }] as const] : []),
      ...b.stories.flatMap(s => [s.builderSessionId, s.reviewerSessionId].flatMap(id => id ? [[id, { title: s.title, projectId: s.projectId, quiet: true }] as const] : [])),
      ...b.sprints.flatMap(s => [s.sessionId, ...(s.reviews ?? []).map(r => r.sessionId)].flatMap(id => id ? [[id, { title: s.name, projectId: s.projectId, quiet: true }] as const] : [])),
    ]);
    if (!tracked.size) return;
    this.busy = true;
    try {
      const all = await backgroundAgents();
      const next = Object.fromEntries(Object.entries(all).filter(([sid]) => tracked.has(sid)));
      let dirty = Object.keys(next).length !== Object.keys(this.agents).length;
      for (const [sid, a] of Object.entries(next)) {
        const prev = this.agents[sid];
        if (prev?.state === a.state) continue;
        dirty = true;
        const t = tracked.get(sid)!;
        const project = b.projects.find(p => p.id === t.projectId);
        if (!prev || !project) continue; // first sighting: no alert
        if (a.state === 'blocked') {
          vscode.window.showWarningMessage(`Claude needs your approval: "${t.title}"`, 'Attach')
            .then(c => c && attach(project, a.id));
        } else if (!t.quiet) {
          vscode.window.showInformationMessage(`Background run "${t.title}" is now ${a.state}`, 'Attach')
            .then(c => c && attach(project, a.id));
        }
      }
      this.agents = next;
      if (dirty) this.changed.fire();
    } catch { /* CLI missing or busy: try next tick */ }
    finally { this.busy = false; }
  }

  dispose() { clearInterval(this.timer); this.changed.dispose(); }
}
