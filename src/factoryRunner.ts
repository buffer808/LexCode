import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Epic, EpicStage, ModelChoice, ModelRole, Project, Sprint, Story, Store } from './store';
import { AgentWatcher, launchBackground } from './claude';
import { finalMessage } from './sessions';
import { discoverAgents, bundledRolePrompt, resolveRoles, worktreeArgs } from './agents';
import * as git from './git';
import {
  Action, EpicInput, NEXT_STAGE, PLANNING, STAGE_LABEL, STAGE_ROLE, applyPlan, builderPrompt, conflictIssue, criticalReasons,
  epicBranch, fixPrompt, nextActions, parseStageOutput, parseVerdict, planFile, readPlan, reviewPrompt, sessionArgs,
  sprintBranch, sprintFixPrompt, sprintReviewPrompt, stageArgs, stagePrompt, storiesOf, tryLock, worktreeDir, writePlan,
} from './factory';

export type Decision =
  | { decision: 'approve' | 'reject' | 'retry' | 'cancel' | 'pause' | 'resume' }
  | { decision: 'changes'; text: string }
  | { decision: 'start' | 'workers'; workers: number }
  | { decision: 'approveMerge' | 'retrySprint'; sprintId: string }
  | { decision: 'sendBack'; sprintId: string; text: string }
  | { decision: 'retryStory' | 'skipStory'; storyId: string }
  | { decision: 'createPr'; targetBranch?: string };

// Drives factory epics: plan → revalidate → security → plan gate → build/review loop → merges → PR gate.
// State lives on the epic/sprints/stories in board.json, so a reload picks up where it left off.
export class FactoryRunner implements vscode.Disposable {
  private owner = `${process.pid}-${randomUUID()}`; // this window, for the per-epic driver lock
  private launching = new Set<string>();             // epic/sprint/story ids with work in flight
  private ticking = false;
  private timer = setInterval(() => this.tick(), 15000); // also the lock heartbeat
  private sub: vscode.Disposable;

  constructor(private store: Store, private agents: AgentWatcher, private lockDir: string, private bundled: string,
              private refresh: () => void) {
    this.sub = agents.onDidChange(() => this.tick());
    this.tick();
  }

  private settings = () => vscode.workspace.getConfiguration('lexCode.factory');
  private models = () => this.settings().get<Partial<Record<ModelRole, ModelChoice>>>('models', {});
  private project = (e: Epic) => this.store.all().projects.find(p => p.id === e.projectId);
  private epic = (id: string) => { this.store.reload(); return this.store.all().epics.find(e => e.id === id); };
  private lock = (e: Epic) => tryLock(path.join(this.lockDir, `${e.id}.lock`), this.owner);

  // New factory epic (or an existing manual one, by id): freezes role → agent mapping and the base branch, then plans.
  async create(project: Project, input: EpicInput, existingId?: string): Promise<Epic> {
    let baseBranch: string;
    try { baseBranch = await git.currentBranch(project.path); } catch {
      throw new Error(`${project.name} is not a git repository; the factory needs git for epic branches and PRs.`);
    }
    await git.excludeLexcode(project.path);
    const fields = {
      title: input.title, description: input.description, stage: 'planning' as const,
      baseBranch, targetBranch: input.targetBranch ?? this.settings().get('targetBranch', 'main'),
      builderMode: input.builderMode, models: input.models, roleAgents: input.roleAgents,
    };
    if (existingId) this.store.update('epics', existingId, fields);
    const epic = existingId ? this.epic(existingId)! : this.store.add('epics', { projectId: project.id, ...fields });
    await this.launch(epic, 'planning');
    return epic;
  }

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
      const prompt = stagePrompt(stage, epic, { plan, feedback: epic.feedback, collaborators: defs,
        roleBody: agent ? undefined : bundledRolePrompt(this.bundled, role) });
      this.store.update('epics', epic.id, { stage, stageSessionId: undefined, stageStartedAt: Date.now(), stageAttempts: 0, error: undefined, pending: undefined });
      const sid = await launchBackground(project, stageArgs(stage, epic, prompt, this.models(), agent));
      this.store.update('epics', epic.id, sid ? { stageSessionId: sid } : { error: `Claude doesn't trust ${project.path} yet; accept the trust prompt, then Retry.` });
      this.agents.poll();
    } catch (e: any) {
      this.store.update('epics', epic.id, { error: `${STAGE_LABEL[stage]}: ${e.message}` });
      vscode.window.showErrorMessage(`LexCode factory · ${epic.title}: ${e.message}`);
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
          for (const a of nextActions(this.store.all(), epic, this.agents.agents, this.launching)) { await this.run(epic, a); acted = true; }
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
    try { plan = parseStageOutput(finalMessage(project.path, epic.stageSessionId!, undefined, epic.stageStartedAt)); }
    catch (e: any) {
      if ((epic.stageAttempts ?? 0) >= 1) {
        this.store.update('epics', epic.id, { error: `${STAGE_LABEL[stage]} returned an invalid plan: ${e.message}` });
        vscode.window.showErrorMessage(`LexCode factory · ${epic.title}: ${STAGE_LABEL[stage]} failed (${e.message}).`, 'Retry')
          .then(c => c && this.decide(epic.id, { decision: 'retry' }));
        return this.refresh();
      }
      // One correction round in the same session, then give up and let the human retry.
      this.launching.add(epic.id);
      try {
        const agent = discoverAgents(project.path).find(a => a.name === epic.roleAgents?.[STAGE_ROLE[stage]!]);
        const fix = `Your last reply could not be used: ${e.message}. Reply again with the complete plan as exactly one \`\`\`json block in the required shape.`;
        this.store.update('epics', epic.id, { stageAttempts: 1, stageStartedAt: Date.now() });
        const sid = await launchBackground(project, stageArgs(stage, epic, fix, this.models(), agent, epic.stageSessionId));
        this.store.update('epics', epic.id, sid ? { stageSessionId: sid } : { error: `Claude doesn't trust ${project.path}` });
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
    vscode.window.showInformationMessage(
      `Plan ready for "${epic.title}": ${plan.sprints.length} sprints, ${stories} stories${risky ? `, ${risky} medium/high security findings` : ''}.`,
      'View plan', 'Approve', 'Request changes', 'Reject').then(c => this.gateChoice(epic, c));
  }

  private async gateChoice(epic: Epic, c?: string) {
    if (c === 'View plan') this.openPlan(epic.id);
    else if (c === 'Approve') await this.decide(epic.id, { decision: 'approve' });
    else if (c === 'Request changes') {
      const text = await vscode.window.showInputBox({ prompt: `What should change in the plan for "${epic.title}"?`, ignoreFocusOut: true });
      if (text) await this.decide(epic.id, { decision: 'changes', text });
    } else if (c === 'Reject') await this.decide(epic.id, { decision: 'reject' });
  }

  // Rendered preview, or the markdown source in an editor.
  openPlan(epicId: string, source = false) {
    const epic = this.epic(epicId), project = epic && this.project(epic);
    if (!project) return;
    const file = planFile(project.path, epicId, 'md');
    if (!fs.existsSync(file)) return vscode.window.showInformationMessage(`"${epic!.title}" has no factory plan yet.`);
    const uri = vscode.Uri.file(file);
    return source ? vscode.window.showTextDocument(uri) : vscode.commands.executeCommand('markdown.showPreview', uri);
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
          if (!plan) { vscode.window.showErrorMessage(`Plan for "${epic.title}" is missing or invalid; request changes to re-plan.`); break; }
          applyPlan(this.store, project, epic, plan);
          vscode.window.showInformationMessage(`"${epic.title}": ${plan.sprints.length} sprints added to the board. Set the number of builders and start.`);
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
            ...(!fix && ['reviewing', 'fixing'].includes(sprint.state!) ? { state: 'reviewing' as const, sessionId: undefined } : {}) });
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
        case 'createPr': if (epic.stage === 'awaitingPrApproval') await this.createPr(epic, project, d.targetBranch); break;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`LexCode factory · ${epic.title}: ${e.message}`);
    }
    this.refresh();
    this.tick();
  }

  /* ---------- build loop ---------- */

  private storyById = (id: string) => { this.store.reload(); return this.store.all().stories.find(s => s.id === id); };
  private maxAttempts = () => Math.max(1, this.settings().get('maxReviewAttempts', 3));
  private agentFor(project: Project, epic: Epic, role: 'builder' | 'reviewer') {
    const defs = discoverAgents(project.path);
    const agent = defs.find(a => a.name === epic.roleAgents?.[role]);
    return { defs, agent, roleBody: agent ? undefined : bundledRolePrompt(this.bundled, role) };
  }
  private needsHuman(epic: Epic, what: string) {
    vscode.window.showWarningMessage(`LexCode factory · ${epic.title}: ${what}`, 'Open dashboard')
      .then(c => c && vscode.commands.executeCommand('lexCode.dashboard'));
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
          vscode.window.showInformationMessage(`"${epic.title}": every sprint is merged into ${epic.branch}. Create the PR?`, 'Create PR', 'Open dashboard')
            .then(c => c === 'Create PR' ? this.decide(epic.id, { decision: 'createPr' }) : c && vscode.commands.executeCommand('lexCode.dashboard'));
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
  private async launchIn(project: Project, sp: Sprint, args: string[]) {
    const sid = await launchBackground(project, args, sp.worktree);
    if (!sid) throw new Error(`Claude doesn't trust ${sp.worktree}; accept the trust prompt there, then Retry.`);
    this.agents.poll();
    return sid;
  }

  private async build(epic: Epic, project: Project, sp: Sprint, story: Story) {
    const { defs, agent, roleBody } = this.agentFor(project, epic, 'builder');
    const prompt = builderPrompt(epic, sp, story, { roleBody, collaborators: defs, projectPath: project.path });
    this.store.update('stories', story.id, { status: 'doing', baseCommit: await git.headCommit(sp.worktree!), runStartedAt: Date.now(),
      builderSessionId: undefined, reviewerSessionId: undefined, fixups: 0 });
    const sid = await this.launchIn(project, sp, sessionArgs(epic, 'builder', prompt, this.models(), {
      mode: epic.builderMode ?? 'acceptEdits', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${story.title} · build` }));
    this.store.update('stories', story.id, { builderSessionId: sid });
  }

  private async resumeBuilder(epic: Epic, project: Project, sp: Sprint, story: Story, issues: string[]) {
    const { agent } = this.agentFor(project, epic, 'builder');
    this.store.update('stories', story.id, { status: 'doing', runStartedAt: Date.now(), reviewerSessionId: undefined });
    const sid = await this.launchIn(project, sp, sessionArgs(epic, 'builder', fixPrompt(story, issues), this.models(), {
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
    const sid = await this.launchIn(project, sp, sessionArgs(epic, 'reviewer', reviewPrompt(epic, sp, story, diff, { roleBody, collaborators: defs, projectPath: project.path }),
      this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${story.title} · review` }));
    this.store.update('stories', story.id, { reviewerSessionId: sid });
  }

  // Unusable reviewer output: one correction round in the same session, then a human.
  private async correct(project: Project, sp: Sprint, epic: Epic, target: { coll: 'stories'; item: Story } | { coll: 'sprints'; item: Sprint }, err: string) {
    const sid = target.coll === 'stories' ? target.item.reviewerSessionId! : target.item.sessionId!;
    const save = (patch: Partial<Story & Sprint>) => this.store.update(target.coll, target.item.id, patch);
    if ((target.item.fixups ?? 0) >= 1) {
      save({ blocked: `Reviewer returned an unusable verdict: ${err}` });
      return this.needsHuman(epic, `reviewer output for ${sp.name} was unusable (${err}).`);
    }
    save({ fixups: 1, runStartedAt: Date.now() });
    const { agent } = this.agentFor(project, epic, 'reviewer');
    const next = await this.launchIn(project, sp, sessionArgs(epic, 'reviewer',
      `Your last reply could not be used: ${err}. Reply again with your verdict as exactly one \`\`\`json block in the required shape.`,
      this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), resumeId: sid }));
    save(target.coll === 'stories' ? { reviewerSessionId: next } : { sessionId: next });
  }

  private async verdict(epic: Epic, project: Project, sp: Sprint, story: Story) {
    let v;
    try { v = parseVerdict(finalMessage(sp.worktree!, story.reviewerSessionId!, undefined, story.runStartedAt)); }
    catch (e: any) { return this.correct(project, sp, epic, { coll: 'stories', item: story }, e.message); }
    if (!v.pass) return this.bounce(epic, project, sp, story, v.issues);
    this.store.update('stories', story.id, { status: 'done', reviewNotes: v.issues.join('\n') || undefined });
  }

  private async reviewSprint(epic: Epic, project: Project, sp: Sprint) {
    const diff = await git.diff(sp.worktree!, epic.branch!, sp.branch!);
    const { defs, agent, roleBody } = this.agentFor(project, epic, 'reviewer');
    this.store.update('sprints', sp.id, { state: 'reviewing', runStartedAt: Date.now(), sessionId: undefined, fixups: 0 });
    const sid = await this.launchIn(project, sp, sessionArgs(epic, 'reviewer',
      sprintReviewPrompt(epic, sp, storiesOf(this.store.all(), sp), diff, { roleBody, collaborators: defs, projectPath: project.path }),
      this.models(), { mode: 'plan', agent, extra: worktreeArgs(project.path, sp.worktree!), name: `LexCode · ${sp.name} · sprint review` }));
    this.store.update('sprints', sp.id, { sessionId: sid });
  }

  private async sprintVerdict(epic: Epic, project: Project, sp: Sprint) {
    let v;
    try { v = parseVerdict(finalMessage(sp.worktree!, sp.sessionId!, undefined, sp.runStartedAt)); }
    catch (e: any) { return this.correct(project, sp, epic, { coll: 'sprints', item: sp }, e.message); }
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
    const reasons = criticalReasons(sp, v, changed, this.settings().get<string[]>('sensitivePaths', []), readPlan(project.path, epic.id));
    if (reasons.length) {
      this.store.update('sprints', sp.id, { state: 'awaitingMerge', critical: reasons });
      return this.needsHuman(epic, `${sp.name} is reviewed; merging needs your approval (${reasons[0]}).`);
    }
    await this.merge(epic, project, sp);
  }

  private async fixSprint(epic: Epic, project: Project, sp: Sprint, issues: string[]) {
    const { agent } = this.agentFor(project, epic, 'builder');
    this.store.update('sprints', sp.id, { state: 'fixing', runStartedAt: Date.now(), sessionId: undefined, critical: undefined });
    const sid = await this.launchIn(project, sp, sessionArgs(epic, 'builder', sprintFixPrompt(epic, sp, issues), this.models(), {
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
    this.store.update('sprints', sp.id, { state: 'merged', worktree: undefined, critical: undefined, sessionId: undefined });
  }

  private async createPr(epic: Epic, project: Project, target?: string) {
    const base = target?.trim() || epic.targetBranch || 'main';
    const wt = worktreeDir(project.path, epic.id);
    const plan = readPlan(project.path, epic.id);
    const body = [epic.description, plan && `## Plan\n${plan.summary}`, plan && plan.sprints.map(s => `- **${s.key}: ${s.name}**: ${s.stories.map(t => t.title).join('; ')}`).join('\n'),
      '🏭 Built by the LexCode software factory'].filter(Boolean).join('\n\n');
    await git.push(wt, epic.branch!);
    const url = await git.createPr(wt, base, epic.branch!, epic.title, body);
    await git.removeWorktree(project.path, wt);
    this.store.update('epics', epic.id, { stage: 'done', pending: undefined, prUrl: url.split('\n').pop(), targetBranch: base });
    vscode.window.showInformationMessage(`PR opened for "${epic.title}"`, 'Open PR').then(c => c && vscode.env.openExternal(vscode.Uri.parse(url.split('\n').pop()!)));
  }

  dispose() { clearInterval(this.timer); this.sub.dispose(); }
}

const workerCount = (n: unknown) => Math.min(8, Math.max(1, Math.floor(Number(n)) || 1));
