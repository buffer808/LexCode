import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Epic, EpicStage, ModelChoice, ModelRole, PrVia, Project, Role, Sprint, SprintReview, Story, Store } from './store';
import { AgentWatcher, launchBackground, terminalSession } from './claude';
import { host } from './host';
import { finalMessage } from './sessions';
import { discoverAgents, bundledRolePrompt, resolveRoles, worktreeArgs } from './agents';
import * as git from './git';
import {
  Action, EpicInput, NEXT_STAGE, PLANNING, STAGE_LABEL, STAGE_ROLE, applyPlan, builderPrompt, conflictIssue, criticalReasons,
  epicBranch, epicRefs, finished, fixPrompt, mergeVerdicts, nextActions, parseStageOutput, parseVerdict, planFile, readPlan, reviewLabel, reviewPanel, reviewPrompt, sessionArgs,
  refArgs, sprintBranch, sprintFixPrompt, sprintReviewPrompt, stageArgs, stagePrompt, storiesOf, releaseLocks, tryLock, releaseLock, worktreeDir, writePlan,
} from './factory';

export type Decision =
  | { decision: 'approve' | 'reject' | 'retry' | 'cancel' | 'restart' | 'archive' | 'pause' | 'resume' }
  | { decision: 'changes'; text: string }
  | { decision: 'start' | 'workers'; workers: number }
  | { decision: 'approveMerge' | 'retrySprint'; sprintId: string }
  | { decision: 'sendBack'; sprintId: string; text: string }
  | { decision: 'retryStory' | 'skipStory'; storyId: string }
  | { decision: 'createPr'; targetBranch?: string; via?: PrVia | 'auto'; skill?: string }
  | { decision: 'prOpened'; url: string };

// Drives factory epics: plan → revalidate → security → plan gate → build/review loop → merges → PR gate.
// State lives on the epic/sprints/stories in board.json, so a reload picks up where it left off.
export class FactoryRunner {
  private owner = `${process.pid}-${randomUUID()}`; // this window, for the per-epic driver lock
  private launching = new Set<string>();             // epic/sprint/story ids with work in flight
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>; // also the lock heartbeat
  private held = new Set<string>();                  // epic ids whose driver lock this runner holds
  private sub?: { dispose(): void };

  // drive: false for one-shot commands (`lexcode epic new`): create() only, never advance or lock other epics.
  constructor(private store: Store, private agents: AgentWatcher, private lockDir: string, private bundled: string,
              private refresh: () => void, { drive = true } = {}) {
    if (!drive) return;
    // Heartbeat outside tick(): a tick can sit in slow awaits (launches, merges) past the lock's staleness.
    this.timer = setInterval(() => { this.heartbeat(); this.tick(); }, 15000);
    this.sub = agents.onDidChange(() => this.tick());
    this.tick();
  }

  private setting = <T>(key: string, fallback: T) => host().setting(`factory.${key}`, fallback);
  private models = () => this.setting<Partial<Record<ModelRole, ModelChoice>>>('models', {});
  private project = (e: Epic) => this.store.all().projects.find(p => p.id === e.projectId);
  private epic = (id: string) => { this.store.reload(); return this.store.all().epics.find(e => e.id === id); };
  private lockFile = (id: string) => path.join(this.lockDir, `${id}.lock`);
  private lock = (e: Epic) => {
    const ok = tryLock(this.lockFile(e.id), this.owner);
    if (ok) this.held.add(e.id); else this.held.delete(e.id);
    return ok;
  };

  // Keeps held locks fresh while this runner drives the epic; at a gate, error or end it lets go so the other
  // window (VS Code, TUI, `lexcode ui`) can act on the human's click right away.
  private heartbeat() {
    this.store.reload();
    for (const id of this.held) {
      const e = this.store.all().epics.find(x => x.id === id);
      const driving = e && !this.launching.has(id) ? (PLANNING.includes(e.stage!) && !e.error) || e.stage === 'building' : !!e;
      if (driving && tryLock(this.lockFile(id), this.owner)) continue;
      if (!driving) releaseLock(this.lockFile(id), this.owner);
      this.held.delete(id);
    }
  }

  // New factory epic (or an existing manual one, by id): freezes role → agent mapping, cuts the epic branch from the
  // PR target into its own worktree, then plans there, so plan, build and PR all start from the target branch.
  async create(project: Project, input: EpicInput, existingId?: string): Promise<Epic> {
    const targetBranch = input.targetBranch ?? this.setting('targetBranch', 'main');
    try { await git.headCommit(project.path); } catch { // not a repo, or no commits yet
      const ok = await host().message('warn', `${project.name} has no git history yet; the factory needs git for epic branches and PRs.`,
        { modal: true, detail: `Initialize git and make an empty initial commit on "${targetBranch}"?` }, 'Initialize git');
      if (!ok) throw new Error(`${project.name} is not a git repository with commits; the factory needs git for epic branches and PRs.`);
      await git.initRepo(project.path, targetBranch);
    }
    let baseBranch: string;
    try { baseBranch = await git.resolveBase(project.path, targetBranch); }
    catch (e: any) { throw new Error(`Can't cut the epic branch: ${e.message}. Pick an existing PR target branch.`); }
    await git.excludeLexcode(project.path);
    const fields = {
      title: input.title, description: input.description, stage: 'planning' as const,
      baseBranch, targetBranch,
      builderMode: input.builderMode, models: input.models, roleAgents: input.roleAgents, reviewers: input.reviewers,
    };
    if (existingId) this.store.update('epics', existingId, fields);
    const epic = existingId ? this.epic(existingId)! : this.store.add('epics', { projectId: project.id, ...fields });
    this.store.update('epics', epic.id, { branch: epic.branch ?? epicBranch(epic) }); // launch() creates its worktree
    await this.launch(this.epic(epic.id)!, 'planning');
    return this.epic(epic.id)!;
  }

  // Planning runs in the epic worktree (the target branch's code). Epics from before epic branches were cut at
  // creation have no branch until the build starts, so they plan in the project root as before.
  private async epicCwd(project: Project, epic: Epic) {
    if (!epic.branch) return project.path;
    const wt = worktreeDir(project.path, epic.id);
    await git.addWorktree(project.path, wt, epic.branch, epic.baseBranch ?? 'HEAD'); // no-op when it exists
    return wt;
  }
  private stageExtra = (project: Project, cwd: string) => cwd === project.path ? [] : worktreeArgs(project.path, cwd);
  private attachDir = (epic: Epic) => this.store.attachmentsDir(epic.id);
  private refs = (epic: Epic) => epicRefs(epic, this.attachDir(epic));

  detectedRoles = (project: Project) => resolveRoles(project.path);

  private async launch(epic: Epic, stage: EpicStage) {
    const project = this.project(epic);
    if (!project || this.launching.has(epic.id) || !this.lock(epic)) return;
    this.launching.add(epic.id);
    try {
      const role = STAGE_ROLE[stage]!;
      const defs = discoverAgents(project.path);
      const agent = defs.find(a => a.name === epic.roleAgents?.[role]); // renamed/deleted since creation → bundled prompt
      const plan = stage === 'planning' && !epic.feedback ? undefined : readPlan(project.path, epic.id);
      if (stage !== 'planning' && !plan) throw new Error('plan.json is missing; re-run planning');
      const prompt = stagePrompt(stage, epic, { plan, feedback: epic.feedback, collaborators: defs, refs: this.refs(epic),
        roleBody: agent ? undefined : bundledRolePrompt(this.bundled, role) });
      this.store.update('epics', epic.id, { stage, stageSessionId: undefined, stageStartedAt: Date.now(), stageAttempts: 0, error: undefined, pending: undefined });
      const cwd = await this.epicCwd(project, epic);
      const sid = await launchBackground(project, [...refArgs(epic, this.attachDir(epic)), ...stageArgs(stage, epic, prompt, this.models(), agent, undefined, this.stageExtra(project, cwd))], cwd);
      this.store.update('epics', epic.id, sid ? { stageSessionId: sid } : { error: `Claude doesn't trust ${cwd} yet; accept the trust prompt, then Retry.` });
      this.agents.poll();
    } catch (e: any) {
      this.store.update('epics', epic.id, { error: `${STAGE_LABEL[stage]}: ${e.message}` });
      host().message('error', `LexCode factory · ${epic.title}: ${e.message}`);
    } finally {
      this.launching.delete(epic.id);
      this.refresh();
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.store.reload();
      let acted = false;
      for (const epic of this.store.all().epics) {
        if (epic.stage === 'building' && this.lock(epic)) {
          for (const a of nextActions(this.store.all(), epic, this.agents.agents, this.launching)) {
            if (!this.lock(epic)) break; // lost it during an earlier slow action: the new driver takes over
            await this.run(epic, a); acted = true;
          }
          continue;
        }
        if (!PLANNING.includes(epic.stage!) || !epic.stageSessionId || epic.error || this.launching.has(epic.id)) continue;
        const a = this.agents.agents[epic.stageSessionId];
        // A resumed session can still show its previous run's `done` until the watcher catches up.
        if (a?.state !== 'done' || (a.startedAt ?? 0) < (epic.stageStartedAt ?? 0) || !this.lock(epic)) continue;
        await this.stageDone(epic);
      }
      if (acted) setTimeout(() => this.tick(), 0); // follow-ups (sprint started → first story) without waiting for a poll
    } finally { this.ticking = false; }
  }

  private async stageDone(epic: Epic) {
    const project = this.project(epic)!;
    const stage = epic.stage!;
    let plan;
    const cwd = await this.epicCwd(project, epic);
    try { plan = parseStageOutput(finalMessage(cwd, epic.stageSessionId!, undefined, epic.stageStartedAt)); }
    catch (e: any) {
      if ((epic.stageAttempts ?? 0) >= 1) {
        this.store.update('epics', epic.id, { error: `${STAGE_LABEL[stage]} returned an invalid plan: ${e.message}` });
        host().message('error', `LexCode factory · ${epic.title}: ${STAGE_LABEL[stage]} failed (${e.message}).`, undefined, 'Retry')
          .then(c => { if (c) this.decide(epic.id, { decision: 'retry' }); });
        return this.refresh();
      }
      // One correction round in the same session, then give up and let the human retry.
      this.launching.add(epic.id);
      try {
        const agent = discoverAgents(project.path).find(a => a.name === epic.roleAgents?.[STAGE_ROLE[stage]!]);
        const fix = `Your last reply could not be used: ${e.message}. Reply again with the complete plan as exactly one \`\`\`json block in the required shape, in your reply text (not in a file).`;
        this.store.update('epics', epic.id, { stageAttempts: 1, stageStartedAt: Date.now() });
        const sid = await launchBackground(project, [...refArgs(epic, this.attachDir(epic)), ...stageArgs(stage, epic, fix, this.models(), agent, epic.stageSessionId, this.stageExtra(project, cwd))], cwd);
        this.store.update('epics', epic.id, sid ? { stageSessionId: sid } : { error: `Claude doesn't trust ${cwd}` });
        this.agents.poll();
      } catch (err: any) {
        this.store.update('epics', epic.id, { error: `${STAGE_LABEL[stage]}: ${err.message}` });
      } finally { this.launching.delete(epic.id); this.refresh(); }
      return;
    }

    writePlan(project.path, epic, plan);
    const next = NEXT_STAGE[stage]!;
    if (next !== 'awaitingPlanApproval') return this.launch(this.epic(epic.id)!, next);

    this.store.update('epics', epic.id, { stage: next, pending: { kind: 'plan' }, stageSessionId: undefined, feedback: undefined });
    this.refresh();
    const stories = plan.sprints.reduce((n, s) => n + s.stories.length, 0);
    const risky = plan.security.filter(f => f.severity !== 'low').length;
    // Not awaited: the toast can sit for hours and must not hold up tick().
    host().message('info',
      `Plan ready for "${epic.title}": ${plan.sprints.length} sprints, ${stories} stories${risky ? `, ${risky} medium/high security findings` : ''}.`,
      undefined, 'View plan', 'Approve', 'Request changes', 'Reject').then(c => this.gateChoice(epic, c));
  }

  private async gateChoice(epic: Epic, c?: string) {
    if (c === 'View plan') this.openPlan(epic.id);
    else if (c === 'Approve') await this.decide(epic.id, { decision: 'approve' });
    else if (c === 'Request changes') {
      const text = await host().input(`What should change in the plan for "${epic.title}"?`, undefined, { multiline: true });
      if (text) await this.decide(epic.id, { decision: 'changes', text });
    } else if (c === 'Reject') await this.decide(epic.id, { decision: 'reject' });
  }

  // Rendered preview, or the markdown source (in an editor, or the dashboard's viewer in the browser).
  openPlan(epicId: string, source = false) {
    const epic = this.epic(epicId), project = epic && this.project(epic);
    if (!project) return;
    const file = planFile(project.path, epicId, 'md');
    if (!fs.existsSync(file)) return host().message('info', `"${epic!.title}" has no factory plan yet.`);
    const h = host();
    if (h.showMarkdown) h.showMarkdown(`Plan: ${epic!.title}`, fs.readFileSync(file, 'utf8'), source);
    else h.openFile(file, source ? { line: 1 } : { preview: true });
  }

  // Project-relative plan.md path per epic that has one (dashboard links).
  planPaths(projectPath: string, epicIds: string[]) {
    return Object.fromEntries(epicIds.map(id => [id, planFile(projectPath, id, 'md')])
      .filter(([, f]) => fs.existsSync(f)).map(([id, f]) => [id, path.relative(projectPath, f)]));
  }

  // Human decisions from the dashboard or notifications. Each is only valid in its stage/state.
  async decide(epicId: string, d: Decision) {
    const epic = this.epic(epicId), project = epic && this.project(epic);
    if (!epic || !project) return;
    const b = this.store.all();
    const sprint = 'sprintId' in d ? b.sprints.find(s => s.id === d.sprintId && s.epicId === epic.id) : undefined;
    const story = 'storyId' in d ? b.stories.find(s => s.id === d.storyId && s.epicId === epic.id) : undefined;
    const atGate = epic.stage === 'awaitingPlanApproval';
    try {
      switch (d.decision) {
        case 'approve': {
          if (!atGate) break;
          const plan = readPlan(project.path, epic.id);
          if (!plan) { host().message('error', `Plan for "${epic.title}" is missing or invalid; request changes to re-plan.`); break; }
          applyPlan(this.store, project, epic, plan);
          host().message('info', `"${epic.title}": ${plan.sprints.length} sprints added to the board. Set the number of builders and start.`);
          break;
        }
        case 'changes':
          if (!atGate || !d.text.trim()) break;
          this.store.update('epics', epic.id, { feedback: d.text.trim().slice(0, 20000) });
          await this.launch(this.epic(epic.id)!, 'planning');
          break;
        case 'retry':
          if (epic.error && PLANNING.includes(epic.stage!)) await this.launch(epic, epic.stage!);
          break;
        case 'reject': case 'cancel':
          if ((d.decision === 'reject' && atGate) || (d.decision === 'cancel' && epic.stage && !['done', 'cancelled'].includes(epic.stage))) {
            this.store.update('epics', epic.id, { stage: 'cancelled', pending: undefined, stageSessionId: undefined });
          }
          break;
        case 'restart':
          // Re-plan from scratch with the same settings: the old run's sprints go, its stories are archived.
          // The epic branch and worktrees stay, like cancel left them.
          if (!['cancelled', 'failed'].includes(epic.stage!)) break;
          for (const s of b.stories.filter(s => s.epicId === epic.id && s.sprintId)) this.store.update('stories', s.id, { archived: true, sprintId: undefined });
          for (const sp of b.sprints.filter(s => s.epicId === epic.id)) this.store.remove('sprints', sp.id);
          this.store.update('epics', epic.id, { stage: 'planning', error: undefined, feedback: undefined, pending: undefined, prUrl: undefined,
            stageSessionId: undefined, stageStartedAt: undefined, stageAttempts: undefined });
          await this.launch(this.epic(epic.id)!, 'planning');
          break;
        case 'archive':
          if (epic.stage !== 'done') break;
          for (const s of b.stories.filter(s => s.epicId === epic.id)) this.store.update('stories', s.id, { archived: true });
          this.store.update('epics', epic.id, { archived: true });
          break;
        case 'start': await this.startBuild(epic, project, d.workers); break;
        case 'workers': this.store.update('epics', epic.id, { workers: workerCount(d.workers) }); break;
        case 'pause': if (epic.stage === 'building') this.store.update('epics', epic.id, { stage: 'paused' }); break;
        case 'resume': if (epic.stage === 'paused') this.store.update('epics', epic.id, { stage: 'building' }); break;
        case 'approveMerge': if (sprint?.state === 'awaitingMerge') await this.merge(epic, project, sprint); break;
        case 'sendBack':
          if (sprint?.state === 'awaitingMerge' && d.text.trim()) {
            const conflict = sprint.critical?.find(c => c.startsWith('merge conflict'));
            await this.fixSprint(epic, project, sprint, [d.text.trim(), ...(conflict ? [conflictIssue(epic, conflict.replace(/^merge conflict in: /, '').split(', '))] : [])]);
          }
          break;
        case 'retrySprint': {
          if (!sprint?.blocked) break;
          // Review kept failing → one more fix round with the last issues; anything else → redo the step that failed.
          const fix = sprint.state === 'reviewing' && sprint.issues?.length && (sprint.attempts ?? 0) >= this.maxAttempts();
          this.store.update('sprints', sprint.id, { blocked: undefined, attempts: 0, fixups: 0,
            ...(!fix && ['reviewing', 'fixing'].includes(sprint.state!) ? { state: 'reviewing' as const, sessionId: undefined, reviews: undefined } : {}) });
          if (fix) await this.fixSprint(epic, project, sprint, sprint.issues!);
          break;
        }
        case 'retryStory':
          if (!story?.blocked) break;
          this.store.update('stories', story.id, { blocked: undefined, attempts: 0, fixups: 0,
            ...(story.status === 'review' ? { reviewerSessionId: undefined } : {}) });
          // Review kept failing → builder gets the last notes again. Otherwise the scheduler redoes the step that failed
          // (missing builder session → build; finished builder → review; review status → new reviewer).
          if (story.status === 'doing' && story.builderSessionId && story.reviewNotes && (story.attempts ?? 0) >= this.maxAttempts()) {
            await this.resumeBuilder(epic, project, b.sprints.find(s => s.id === story.sprintId)!, this.storyById(story.id)!, story.reviewNotes.split('\n'));
          }
          break;
        case 'skipStory':
          if (story?.blocked) this.store.update('stories', story.id, { status: 'done', blocked: undefined, reviewNotes: 'Skipped by a human.' });
          break;
        case 'createPr': if (epic.stage === 'awaitingPrApproval' && !this.launching.has(epic.id)) await this.createPr(epic, project, d); break;
        case 'prOpened': if (epic.stage === 'awaitingPrApproval') await this.prOpened(epic, project, d.url); break;
      }
    } catch (e: any) {
      host().message('error', `LexCode factory · ${epic.title}: ${e.message}`);
    }
    this.refresh();
    this.tick();
  }

  /* ---------- build loop ---------- */

  private storyById = (id: string) => { this.store.reload(); return this.store.all().stories.find(s => s.id === id); };
  private maxAttempts = () => Math.max(1, this.setting('maxReviewAttempts', 3));
  // name: a specific agent (review panel); otherwise the epic's agent for `role`. No agent → bundled prompt for `bundled`.
  private agentFor(project: Project, epic: Epic, role: Role, name = epic.roleAgents?.[role], bundled: Role = role) {
    const defs = discoverAgents(project.path);
    const agent = defs.find(a => a.name === name);
    return { defs, agent, roleBody: agent ? undefined : bundledRolePrompt(this.bundled, bundled) };
  }
  private needsHuman(epic: Epic, what: string) {
    host().message('warn', `LexCode factory · ${epic.title}: ${what}`, undefined, ...dashboardAction())
      .then(c => c && host().showDashboard?.());
  }

  // Ready → building: cut the epic branch from the base and check it out in its own worktree (merges happen there).
  private async startBuild(epic: Epic, project: Project, workers: number) {
    if (epic.stage !== 'ready') return;
    const branch = epic.branch ?? epicBranch(epic);
    await git.addWorktree(project.path, worktreeDir(project.path, epic.id), branch, epic.baseBranch ?? 'HEAD');
    this.store.update('epics', epic.id, { stage: 'building', branch, workers: workerCount(workers) });
  }

  private async run(epic: Epic, a: Action) {
    const project = this.project(epic)!;
    const id = 'story' in a ? a.story.id : 'sprint' in a ? a.sprint.id : epic.id;
    this.launching.add(id);
    try {
      switch (a.kind) {
        case 'startSprint': {
          const branch = sprintBranch(epic, a.sprint), dir = worktreeDir(project.path, a.sprint.id);
          await git.addWorktree(project.path, dir, branch, epic.branch!);
          this.store.update('sprints', a.sprint.id, { state: 'building', branch, worktree: dir });
          break;
        }
        case 'build': await this.build(epic, project, a.sprint, a.story); break;
        case 'review': await this.review(epic, project, a.sprint, a.story); break;
        case 'verdict': await this.verdict(epic, project, a.sprint, a.story); break;
        case 'reviewSprint': await this.reviewSprint(epic, project, a.sprint); break;
        case 'sprintVerdict': await this.sprintVerdict(epic, project, a.sprint); break;
        case 'finish':
          this.store.update('epics', epic.id, { stage: 'awaitingPrApproval', pending: { kind: 'pr' } });
          host().message('info', `"${epic.title}": every sprint is merged into ${epic.branch}. Create the PR?`, undefined, 'Create PR', ...dashboardAction())
            .then(c => c === 'Create PR' ? this.decide(epic.id, { decision: 'createPr' }) : c && host().showDashboard?.());
          break;
      }
    } catch (e: any) {
      const msg = `${a.kind}: ${e.message}`;
      if ('story' in a) this.store.update('stories', a.story.id, { blocked: msg });
      else if ('sprint' in a) this.store.update('sprints', a.sprint.id, { blocked: msg });
      else this.store.update('epics', epic.id, { error: msg });
      this.needsHuman(epic, msg);
    } finally {
      this.launching.delete(id);
      this.refresh();
    }
  }

  // Launches a session in the sprint worktree; returns its id or throws (untrusted folder included).
  private async launchIn(epic: Epic, project: Project, sp: Sprint, args: string[]) {
    const sid = await launchBackground(project, [...refArgs(epic, this.attachDir(epic)), ...args], sp.worktree);
    if (!sid) throw new Error(`Claude doesn't trust ${sp.worktree}; accept the trust prompt there, then Retry.`);
    this.agents.poll();
    return sid;
  }

  private async build(epic: Epic, project: Project, sp: Sprint, story: Story) {
    const { defs, agent, roleBody } = this.agentFor(project, epic, 'builder');
    const prompt = builderPrompt(epic, sp, story, { roleBody, collaborators: defs, projectPath: project.path, refs: this.refs(epic) });
    this.store.update('stories', story.id, { status: 'doing', baseCommit: await git.headCommit(sp.worktree!), runStartedAt: Date.now(),
      builderSessionId: undefined, reviewerSessionId: undefined, fixups: 0 });
    const sid = await this.launchIn(epic, project, sp, sessionArgs(epic, 'builder', prompt, this.models(), {
      mode: epic.builderMode ?? 'acceptEdits', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${story.title} · build` }));
    this.store.update('stories', story.id, { builderSessionId: sid });
  }

  private async resumeBuilder(epic: Epic, project: Project, sp: Sprint, story: Story, issues: string[]) {
    const { agent } = this.agentFor(project, epic, 'builder');
    this.store.update('stories', story.id, { status: 'doing', runStartedAt: Date.now(), reviewerSessionId: undefined });
    const sid = await this.launchIn(epic, project, sp, sessionArgs(epic, 'builder', fixPrompt(story, issues), this.models(), {
      mode: epic.builderMode ?? 'acceptEdits', agent, extra: worktreeArgs(project.path, sp.worktree!), resumeId: story.builderSessionId }));
    this.store.update('stories', story.id, { builderSessionId: sid });
  }

  // Review failed (or nothing was committed): back to the builder, or to a human after maxReviewAttempts.
  private async bounce(epic: Epic, project: Project, sp: Sprint, story: Story, issues: string[]) {
    const attempts = (story.attempts ?? 0) + 1;
    this.store.update('stories', story.id, { attempts, reviewNotes: issues.join('\n') });
    if (attempts >= this.maxAttempts()) {
      this.store.update('stories', story.id, { status: 'doing', blocked: `Review failed ${attempts} times` });
      return this.needsHuman(epic, `"${story.title}" failed review ${attempts} times.`);
    }
    await this.resumeBuilder(epic, project, sp, this.storyById(story.id)!, issues);
  }

  private async review(epic: Epic, project: Project, sp: Sprint, story: Story) {
    if (await git.headCommit(sp.worktree!) === story.baseCommit) {
      return this.bounce(epic, project, sp, story, ['No commits were made on the branch. Implement the story and commit your changes.']);
    }
    const diff = await git.diff(sp.worktree!, story.baseCommit!, 'HEAD');
    const { defs, agent, roleBody } = this.agentFor(project, epic, 'reviewer');
    this.store.update('stories', story.id, { status: 'review', runStartedAt: Date.now(), reviewerSessionId: undefined, fixups: 0 });
    const sid = await this.launchIn(epic, project, sp, sessionArgs(epic, 'reviewer', reviewPrompt(epic, sp, story, diff, { roleBody, collaborators: defs, projectPath: project.path, refs: this.refs(epic) }),
      this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${story.title} · review` }));
    this.store.update('stories', story.id, { reviewerSessionId: sid });
  }

  // Unusable reviewer output: resume the same session once asking for the verdict again (the caller blocks after that).
  private reprompt(project: Project, sp: Sprint, epic: Epic, role: Role, name: string | undefined, sid: string, err: string) {
    const { agent } = this.agentFor(project, epic, role, name);
    return this.launchIn(epic, project, sp, sessionArgs(epic, role,
      `Your last reply could not be used: ${err}. Reply again with your verdict as exactly one \`\`\`json block in the required shape.`,
      this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), resumeId: sid }));
  }

  private async verdict(epic: Epic, project: Project, sp: Sprint, story: Story) {
    let v;
    try { v = parseVerdict(finalMessage(sp.worktree!, story.reviewerSessionId!, undefined, story.runStartedAt)); }
    catch (e: any) {
      if ((story.fixups ?? 0) >= 1) {
        this.store.update('stories', story.id, { blocked: `Reviewer returned an unusable verdict: ${e.message}` });
        return this.needsHuman(epic, `reviewer output for "${story.title}" was unusable (${e.message}).`);
      }
      this.store.update('stories', story.id, { fixups: 1, runStartedAt: Date.now() });
      const sid = await this.reprompt(project, sp, epic, 'reviewer', epic.roleAgents?.reviewer, story.reviewerSessionId!, e.message);
      return this.store.update('stories', story.id, { reviewerSessionId: sid });
    }
    if (!v.pass) return this.bounce(epic, project, sp, story, v.issues);
    this.store.update('stories', story.id, { status: 'done', reviewNotes: v.issues.join('\n') || undefined });
  }

  // Sprint review panel: revalidator, security and every picked reviewer look at the sprint diff in parallel.
  private async reviewSprint(epic: Epic, project: Project, sp: Sprint) {
    const diff = await git.diff(sp.worktree!, epic.branch!, sp.branch!);
    const stories = storiesOf(this.store.all(), sp);
    const reviews = reviewPanel(epic);
    this.store.update('sprints', sp.id, { state: 'reviewing', sessionId: undefined, reviews });
    for (const r of reviews) {
      // Mapped project agent runs as itself; otherwise the bundled reviewer prompt with this lens's focus.
      const { defs, agent, roleBody } = this.agentFor(project, epic, r.lens, r.agent, 'reviewer');
      r.startedAt = Date.now();
      r.sessionId = await this.launchIn(epic, project, sp, sessionArgs(epic, r.lens,
        sprintReviewPrompt(epic, sp, stories, diff, r.lens, { roleBody, collaborators: defs, projectPath: project.path, refs: this.refs(epic), self: r.agent }),
        this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${sp.name} · ${reviewLabel(r)}` }));
      this.store.update('sprints', sp.id, { reviews });
    }
  }

  // Reads each finished panel reviewer's verdict; once all are in, merge, gate or send back to a fix round.
  private async sprintVerdict(epic: Epic, project: Project, sp: Sprint) {
    const reviews: SprintReview[] = sp.reviews!.map(r => ({ ...r }));
    for (const r of reviews) {
      if (r.verdict || !finished(this.agents.agents, r.sessionId, r.startedAt)) continue;
      try { r.verdict = parseVerdict(finalMessage(sp.worktree!, r.sessionId!, undefined, r.startedAt)); }
      catch (e: any) {
        if ((r.fixups ?? 0) >= 1) {
          this.store.update('sprints', sp.id, { reviews, blocked: `${reviewLabel(r)} returned an unusable verdict: ${e.message}` });
          return this.needsHuman(epic, `${reviewLabel(r)} output for ${sp.name} was unusable (${e.message}).`);
        }
        r.fixups = 1;
        r.startedAt = Date.now();
        r.sessionId = await this.reprompt(project, sp, epic, r.lens, r.agent, r.sessionId!, e.message);
      }
    }
    this.store.update('sprints', sp.id, { reviews });
    if (!reviews.every(r => r.verdict)) return;
    const v = mergeVerdicts(reviews);
    this.store.update('sprints', sp.id, { risk: v.risk, issues: v.issues });
    if (!v.pass) {
      const attempts = (sp.attempts ?? 0) + 1;
      this.store.update('sprints', sp.id, { attempts });
      if (attempts >= this.maxAttempts()) {
        this.store.update('sprints', sp.id, { blocked: `Sprint review failed ${attempts} times` });
        return this.needsHuman(epic, `${sp.name} failed sprint review ${attempts} times.`);
      }
      return this.fixSprint(epic, project, sp, v.issues);
    }
    const changed = await git.changedFiles(sp.worktree!, epic.branch!, sp.branch!);
    const reasons = criticalReasons(sp, reviews, changed, this.setting<string[]>('sensitivePaths', []), readPlan(project.path, epic.id));
    if (reasons.length) {
      this.store.update('sprints', sp.id, { state: 'awaitingMerge', critical: reasons });
      return this.needsHuman(epic, `${sp.name} is reviewed; merging needs your approval (${reasons[0]}).`);
    }
    await this.merge(epic, project, sp);
  }

  private async fixSprint(epic: Epic, project: Project, sp: Sprint, issues: string[]) {
    const { agent } = this.agentFor(project, epic, 'builder');
    this.store.update('sprints', sp.id, { state: 'fixing', runStartedAt: Date.now(), sessionId: undefined, critical: undefined, reviews: undefined });
    const sid = await this.launchIn(epic, project, sp, sessionArgs(epic, 'builder', sprintFixPrompt(epic, sp, issues), this.models(), {
      mode: epic.builderMode ?? 'acceptEdits', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${sp.name} · fix` }));
    this.store.update('sprints', sp.id, { sessionId: sid });
  }

  private async merge(epic: Epic, project: Project, sp: Sprint) {
    const r = await git.merge(worktreeDir(project.path, epic.id), sp.branch!, `Merge ${sp.name} into ${epic.branch}`);
    if (r.conflict) {
      this.store.update('sprints', sp.id, { state: 'awaitingMerge', critical: [`merge conflict in: ${r.files.join(', ')}`] });
      return this.needsHuman(epic, `${sp.name} conflicts with ${epic.branch}. Send it back to a builder to resolve, or resolve it yourself and approve.`);
    }
    await git.removeWorktree(project.path, sp.worktree!);
    await this.dropBranch(epic, project, sp);
    this.store.update('sprints', sp.id, { state: 'merged', worktree: undefined, critical: undefined, sessionId: undefined });
  }

  // Merged sprint branch is no longer needed; `-d` from the epic worktree only deletes it if it really is merged there.
  private async dropBranch(epic: Epic, project: Project, sp: Sprint) {
    if (!sp.branch || !await git.branchExists(project.path, sp.branch)) return;
    try { await git.deleteBranch(worktreeDir(project.path, epic.id), sp.branch); }
    catch (e: any) { console.warn(`LexCode: kept ${sp.branch}: ${e.message}`); }
  }

  private async createPr(epic: Epic, project: Project, d: { targetBranch?: string; via?: PrVia | 'auto'; skill?: string }) {
    const base = d.targetBranch?.trim() || epic.targetBranch || 'main';
    const via: PrVia = d.via && d.via !== 'auto' ? d.via
      : /github\.com/.test(await git.remoteUrl(project.path).catch(() => '')) ? 'gh' : 'tea';
    if (via === 'skill' && !d.skill) throw new Error('Pick the skill that opens the PR.');
    this.store.update('projects', project.id, { pr: { via, skill: d.skill ?? project.pr?.skill } }); // preselected next time
    this.store.update('epics', epic.id, { targetBranch: base, pending: { kind: 'pr', busy: Date.now() } });
    this.refresh();
    this.launching.add(epic.id);
    try {
      if (via === 'skill') {
        // Skills draft the PR with you and ask before creating it, so they run interactively; you hand back the URL.
        // No push here: ssh from the extension host gets "Connection reset" where the user's terminal works, so the skill pushes.
        terminalSession(project, `/${d.skill} ${base} ${epic.branch}. Push the branch to origin first if it is not there yet.`);
        this.store.update('epics', epic.id, { pending: { kind: 'pr', skill: d.skill } });
        return;
      }
      // Push and open the PR from the main checkout: branches are shared, and pushes from the epic worktree have failed.
      await git.push(project.path, epic.branch!);
      const plan = readPlan(project.path, epic.id);
      const body = [epic.description, plan && `## Plan\n${plan.summary}`, plan && plan.sprints.map(s => `- **${s.key}: ${s.name}**: ${s.stories.map(t => t.title).join('; ')}`).join('\n'),
        '🏭 Built by the LexCode software factory'].filter(Boolean).join('\n\n');
      await this.prOpened(epic, project, await git.createPr(project.path, via, base, epic.branch!, epic.title, body));
    } catch (e: any) {
      this.store.update('epics', epic.id, { pending: { kind: 'pr', reason: e.message } }); // shown in the PR gate
    } finally { this.launching.delete(epic.id); }
  }

  private async prOpened(epic: Epic, project: Project, url: string) {
    // Sprint branches merged before branch cleanup existed; then the epic worktree (the epic branch stays: it's the PR head).
    for (const sp of this.store.all().sprints.filter(s => s.epicId === epic.id && s.state === 'merged')) await this.dropBranch(epic, project, sp);
    await git.removeWorktree(project.path, worktreeDir(project.path, epic.id));
    this.store.update('epics', epic.id, { stage: 'done', pending: undefined, prUrl: url });
    host().message('info', `PR opened for "${epic.title}"`, undefined, 'Open PR').then(c => c && host().openExternal(url));
  }

  dispose() { clearInterval(this.timer); this.sub?.dispose(); releaseLocks(this.lockDir, this.owner); }
}

const dashboardAction = () => host().showDashboard ? ['Open dashboard'] : [];
const workerCount = (n: unknown) => Math.min(8, Math.max(1, Math.floor(Number(n)) || 1));
