const vscode = acquireVsCodeApi();
const STATUSES = ['todo', 'doing', 'review', 'done'];
let data = { board: { projects: [], epics: [], sprints: [], stories: [] }, sessions: {}, agents: {}, starting: [], modes: {}, defaultMode: 'manual', attachBase: '' };
let bgMode = null; // per-dashboard choice, falls back to setting
let openStoryId = null;
let edits = { id: null, files: null }; // edited-files log for the open story, fetched on demand
// Selection survives webview reloads.
// sprintId: null = backlog, ALL = every sprint. epicId: null = all epics, NONE = no epic.
const ALL = '*', NONE = '-';
let sel = { projectId: null, sprintId: null, epicId: null, showArchived: false, ...vscode.getState() };

// Tiny DOM builder; text always via textContent (no innerHTML → no injection).
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k);
  return el;
}

const ago = t => {
  if (!t) return 'no Claude sessions';
  const m = Math.round((Date.now() - t) / 60000);
  return 'Claude ' + (m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`) + ' ago';
};

// CSP forbids style attributes; the CSSOM is allowed.
function fill(frac) {
  const i = h('i');
  i.style.width = frac * 100 + '%';
  return i;
}

function select(projectId, sprintId, epicId = null) {
  sel = { projectId, sprintId, epicId, showArchived: sel.showArchived };
  vscode.setState(sel);
  render();
}

function render() {
  const { projects, epics, sprints, stories } = data.board;
  const app = document.getElementById('app');
  // Board pushes rebuild everything; put focus back where the user was typing.
  const act = app.contains(document.activeElement) && document.activeElement.dataset.key ? document.activeElement : null;
  const caret = act && { key: act.dataset.key, start: act.selectionStart, end: act.selectionEnd };
  app.replaceChildren();
  queueMicrotask(() => {
    const el = caret && app.querySelector(`[data-key="${caret.key}"]`);
    if (el) { el.focus(); try { el.setSelectionRange(caret.start, caret.end); } catch {} }
  });

  if (!projects.length) {
    app.append(h('p', { class: 'empty' }, 'No projects yet.'), h('button', { class: 'card', onclick: () => vscode.postMessage({ type: 'addProject' }) }, h('strong', {}, '+ Add project')));
    return;
  }

  app.append(h('section', { class: 'cards' }, projects.map(p => {
    const active = sprints.find(s => s.projectId === p.id && s.active);
    // No manual sprint running: open on the factory epic that is building, so its stories are on the board.
    const running = !active && epics.find(e => e.projectId === p.id && RUNNING.includes(e.stage));
    const archivedEpics = new Set(epics.filter(e => e.archived).map(e => e.id));
    const live = stories.filter(s => s.projectId === p.id && !s.archived && !archivedEpics.has(s.epicId));
    const open = live.filter(s => s.status !== 'done').length;
    const total = live.length;
    return h('button', { class: 'card' + (p.id === sel.projectId ? ' selected' : ''),
      onclick: () => running ? select(p.id, ALL, running.id) : select(p.id, active?.id ?? null) },
      h('strong', {}, p.name),
      h('span', { class: 'sub' }, `${active ? active.name : running ? `⚙ ${running.title}` : 'no active sprint'} · ${open} open`),
      h('div', { class: 'bar', title: `${total - open}/${total} done` }, fill(total ? (total - open) / total : 0)),
      h('span', { class: 'sub' }, ago(data.sessions[p.id]?.[0]?.mtime)));
  }), h('button', { class: 'card', onclick: () => vscode.postMessage({ type: 'addProject' }) }, h('strong', {}, '+ Add project'))));

  const project = projects.find(p => p.id === sel.projectId);
  if (!project) return;

  const epicMatch = s => sel.epicId === null || (s.epicId ?? NONE) === sel.epicId;
  // With an epic picked, only offer sprints holding its stories (plus the current one, so the select never lies).
  const hidden = new Set(epics.filter(e => e.archived && !sel.showArchived).map(e => e.id)); // archived epics take their sprints along
  const spent = sp => { const own = stories.filter(s => s.sprintId === sp.id); return own.length > 0 && own.every(s => s.archived); }; // all stories archived
  const projSprints = sprints.filter(sp => sp.projectId === project.id && !hidden.has(sp.epicId) && (sel.showArchived || !spent(sp)) && (sel.epicId === null || sp.id === sel.sprintId
    || stories.some(s => s.sprintId === sp.id && epicMatch(s))));
  const picker = h('select', { onchange: e => select(project.id, e.target.value || null, sel.epicId) },
    h('option', { value: '' }, 'Backlog'),
    h('option', { value: ALL, selected: sel.sprintId === ALL }, 'All sprints'),
    projSprints.map(s => h('option', { value: s.id, selected: s.id === sel.sprintId },
      s.name + (s.active ? ' (active)' : !['waiting', 'merged', undefined].includes(s.state) ? ` · ${SPRINT_STATE[s.state]}` : ''))));

  const projEpics = epics.filter(e => e.projectId === project.id && (sel.showArchived || !e.archived));
  const epicFilter = h('select', { 'aria-label': 'Filter by epic', onchange: e => select(project.id, sel.sprintId, e.target.value || null) },
    h('option', { value: '' }, 'All epics'),
    h('option', { value: NONE, selected: sel.epicId === NONE }, '(no epic)'),
    projEpics.map(e => h('option', { value: e.id, selected: e.id === sel.epicId }, e.title)));

  const filtered = projEpics.find(e => e.id === sel.epicId);
  app.append(h('h2', { class: 'project' }, project.name), h('header', {}, picker, projEpics.length ? epicFilter : null, h('span', { class: 'spacer' }),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: sel.showArchived,
      onchange: e => { sel.showArchived = e.target.checked; vscode.setState(sel); render(); } }), 'Show archived'),
    filtered && h('button', { onclick: () => openEpicEdit(filtered) }, 'Edit epic'),
    h('button', { class: 'primary', onclick: () => openEpicForm(project) }, '+ Epic'),
    h('button', { onclick: () => vscode.postMessage({ type: 'openProject', id: project.id }) }, 'Open in workspace'),
    h('button', { onclick: () => vscode.postMessage({ type: 'importTasks', id: project.id }) }, 'Import tasks'),
    h('button', { onclick: () => vscode.postMessage({ type: 'removeProject', id: project.id }) }, 'Remove project')));

  // Factory epics in flight (or just the filtered one): stage, mode, and the human decisions they wait on.
  const live = projEpics.filter(e => e.stage && (sel.epicId ? e.id === sel.epicId : !['done', 'cancelled'].includes(e.stage)));
  if (live.length) app.append(h('section', { class: 'epics' }, live.map(epicStrip)));

  // Add story to whatever is shown: backlog or selected sprint.
  const title = h('input', { placeholder: 'New story title', 'aria-label': 'Story title', required: '' });
  const points = h('input', { type: 'number', min: '0', placeholder: 'pts', 'aria-label': 'Points', class: 'pts' });
  const epic = h('select', { 'aria-label': 'Epic' }, h('option', { value: '' }, '(no epic)'),
    projEpics.map(e => h('option', { value: e.id, selected: e.id === sel.epicId }, e.title)));
  // No <form>: webview iframe sandbox lacks allow-forms, so submit never fires.
  const add = () => {
    if (!title.value.trim()) return title.focus();
    vscode.postMessage({ type: 'add', id: project.id, sprintId: sel.sprintId === ALL ? undefined : sel.sprintId, title: title.value.trim(),
      points: points.value === '' ? undefined : +points.value, epicId: epic.value || undefined });
  };
  const onEnter = e => { if (e.key === 'Enter') add(); };
  title.addEventListener('keydown', onEnter);
  points.addEventListener('keydown', onEnter);
  app.append(h('div', { class: 'add' }, title, points, projEpics.length ? epic : null,
    h('button', { class: 'primary', onclick: add }, sel.sprintId && sel.sprintId !== ALL ? '+ Add to sprint' : '+ Add to backlog')));

  const inView = stories.filter(s => s.projectId === project.id
    && (sel.sprintId === ALL || (s.sprintId ?? null) === sel.sprintId)
    && epicMatch(s) && (sel.showArchived || !s.archived));
  app.append(h('section', { class: 'kanban' }, STATUSES.map(status => {
    const col = h('div', { class: 'col', 'data-status': status,
      ondragover: e => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: e => {
        e.preventDefault();
        col.classList.remove('over');
        vscode.postMessage({ type: 'status', id: e.dataTransfer.getData('text/plain'), status });
      } },
      h('h3', {}, h('span', {}, status), h('span', {}, inView.filter(s => s.status === status).length,
        status === 'done' && inView.some(s => s.status === 'done' && !s.archived) && h('button', { class: 'link', title: 'Archive all done stories in view',
          onclick: () => vscode.postMessage({ type: 'archiveDone', ids: inView.filter(s => s.status === 'done' && !s.archived).map(s => s.id) }) }, ' · archive'))),
      !inView.some(s => s.status === status) && h('div', { class: 'none' }, 'Drop here'),
      inView.filter(s => s.status === status).map(s => {
        const epic = s.epicId !== sel.epicId && epics.find(e => e.id === s.epicId); // no tag when the board is already that epic
        const sprint = s.sprintId && sprints.find(x => x.id === s.sprintId && x.epicId);
        const run = liveRun(s), live = sessionState(run?.id);
        const n = storySessions(s).length;
        const blocked = live === 'blocked';
        const claude = run
          ? h('button', { class: 'claude' + (blocked ? ' start' : ''), title: 'Open the background run in a terminal to watch or approve',
              onclick: e => { e.stopPropagation(); vscode.postMessage({ type: 'attach', id: s.id, sessionId: run.id }); } }, blocked ? '⚠ Approve…' : 'Attach')
          : claudeButton(s, s.sessionIds?.length ?? 0);
        return h('div', { class: 'story' + (blocked ? ' needs' : '') + (s.archived ? ' archived' : ''), draggable: 'true', tabindex: '0', role: 'button',
          onclick: () => openStory(s.id), onkeydown: e => { if (e.key === 'Enter') openStory(s.id); },
          ondragstart: e => e.dataTransfer.setData('text/plain', s.id) },
          h('div', {}, s.title),
          run && !blocked && h('div', { class: 'live' }, dot(live), run.role || 'Background run', ` · ${live}`),
          h('div', { class: 'meta' },
            sprint && h('span', { class: 'tag key', title: sprint.name }, sprint.key ?? sprint.name),
            epic && h('span', { class: 'tag' }, epic.title),
            s.points != null && h('span', {}, `${s.points}pt`),
            s.blocked && h('span', { class: 'error', title: s.blocked }, '⛔ needs you'),
            s.attempts > 0 && s.status !== 'done' && h('span', { title: s.reviewNotes ?? '' }, `↩ ${s.attempts}`),
            s.attachments?.length > 0 && h('span', { title: 'Attachments' }, `📎${s.attachments.length}`),
            n > 0 && h('span', {}, `${n} session${n > 1 ? 's' : ''}`),
            !blocked && claude),
          blocked && h('div', { class: 'meta' },
            h('span', { class: 'approve', title: 'Background run needs your approval' }, '⚠ approve'), claude));
      }));
    return col;
  })));
}

/* ---------- software factory ---------- */
const ROLE_LABELS = { orchestrator: 'Orchestrator (plans)', revalidator: 'Revalidator', security: 'Security', builder: 'Builder' };
const STAGE_ROLE = { planning: 'orchestrator', revalidating: 'revalidator', securityCheck: 'security' };
const MODEL_ROLES = { planner: 'Planner (plan, revalidate, security)', builder: 'Builder', reviewer: 'Reviewer' };
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const drafts = {}; // epic id → unsent "request changes" text; survives board re-renders
const gate = (epicId, decision, text, extra) => { if (decision === 'changes') delete drafts[epicId]; vscode.postMessage({ type: 'factoryGate', epicId, decision, text, ...extra }); };

const STAGE_VERB = { planning: 'is planning sprints and stories', revalidating: 'is revalidating the plan', securityCheck: 'is checking security' };
const RUNNING = ['building', 'paused', 'awaitingPrApproval'];
const LENS = { revalidator: 'Revalidate', security: 'Security', reviewer: 'Review' };
const ORDER = ['planning', 'revalidating', 'securityCheck', 'awaitingPlanApproval', 'ready', 'building', 'paused', 'awaitingPrApproval', 'done'];
const reviewerNames = e => (e.reviewers?.length ? e.reviewers : [e.roleAgents?.reviewer ?? '']).map(n => n || 'LexCode reviewer');

const dot = state => h('i', { class: 'dot ' + (state ?? 'starting'), 'aria-hidden': 'true' });
const sessionState = sid => sid && data.agents[sid]?.state;
// Every session on a story: ones you started or linked, plus the factory's builder and reviewer.
const storySessions = s => [...(s.sessionIds ?? []).map(id => ({ id, role: '' })),
  { id: s.builderSessionId, role: 'Builder' }, { id: s.reviewerSessionId, role: 'Reviewer' }].filter(x => x.id);
// The story's background run still in progress, preferring one that waits for approval.
const liveRun = s => {
  const live = storySessions(s).reverse().filter(x => data.agents[x.id] && !['done', 'stopped', 'failed'].includes(data.agents[x.id].state));
  return live.find(x => data.agents[x.id].state === 'blocked') ?? live[0];
};
const attachBtn = (e, sid, label) => sessionState(sid) && h('button', { class: sessionState(sid) === 'blocked' ? 'primary' : '',
  onclick: () => vscode.postMessage({ type: 'attachEpic', epicId: e.id, sessionId: sid }) }, sessionState(sid) === 'blocked' ? '⚠ Approve…' : label);
const activity = (state, text, ...actions) => h('div', { class: 'activity' + (state === 'blocked' ? ' needs' : '') },
  dot(state), h('span', { class: 'what' }, text), h('span', { class: 'muted' }, state === 'blocked' ? 'needs approval' : state ?? 'starting…'),
  h('span', { class: 'spacer' }), actions);

// Planning (plan → revalidate → security) → Approval → Build → Review (revalidate + security + reviewers, per sprint) → PR.
// Build and Review overlap: each sprint is reviewed as soon as its stories are built.
function stepper(e) {
  const at = ORDER.indexOf(e.stage); // -1: failed / cancelled
  const sp = data.board.sprints.filter(s => s.epicId === e.id);
  const inBuild = ['ready', 'building', 'paused'].includes(e.stage);
  const built = sp.length > 0 && sp.every(s => ['reviewing', 'awaitingMerge', 'merged'].includes(s.state));
  const reviewing = sp.some(s => ['reviewing', 'awaitingMerge'].includes(s.state));
  const needs = e.error || e.stage.startsWith('awaiting') || sp.some(s => s.blocked || s.state === 'awaitingMerge');
  const steps = [
    ['Planning', at > 2 ? 'done' : at >= 0 ? 'current' : '',
      h('small', {}, ['Plan', 'Revalidate', 'Security'].map((l, i) => [i ? ' → ' : '', h('span', { class: at > i ? 'done' : at === i ? 'current' : '' }, l)]))],
    ['Approval', at > 3 ? 'done' : at === 3 ? 'current' : ''],
    ['Build', at > 6 || built ? 'done' : inBuild ? 'current' : ''],
    ['Review', at > 6 ? 'done' : inBuild && (reviewing || built) ? 'current' : '',
      h('small', {}, ['Revalidate', 'Security', ...reviewerNames(e)].join(' + '))],
    ['PR', e.stage === 'done' ? 'done' : e.stage === 'awaitingPrApproval' ? 'current' : ''],
  ];
  return h('ol', { class: 'steps' + (at < 0 ? ' off' : ''), 'aria-label': 'Pipeline progress' }, steps.map(([label, st, detail]) =>
    h('li', { class: st + (st === 'current' && needs ? ' needs' : ''), 'aria-current': st === 'current' ? 'step' : undefined },
      h('span', { class: 'label' }, label), detail)));
}

// Sprint review panel: one line per reviewer with its live state or verdict.
function reviewPanel(e, sp) {
  return h('ul', { class: 'panel', 'aria-label': 'Sprint reviewers' }, (sp.reviews ?? []).map(r => {
    const state = sessionState(r.sessionId);
    const v = r.verdict;
    return h('li', { class: v ? (v.pass ? 'pass' : 'fail') : '' },
      v ? h('span', { class: 'mark', 'aria-hidden': 'true' }, v.pass ? '✓' : '✗') : dot(state),
      h('span', { class: 'what' }, h('strong', {}, LENS[r.lens]), ' · ', r.agent ?? 'LexCode ' + r.lens),
      v ? h('span', { class: 'muted', title: v.issues.join('\n') }, (v.pass ? 'passed' : `${v.issues.length} issue${v.issues.length === 1 ? '' : 's'}`) + (v.risk === 'critical' ? ' · ⚠ critical' : ''))
        : h('span', { class: 'muted' }, state === 'blocked' ? 'needs approval' : state ?? 'starting…'),
      h('span', { class: 'spacer' }),
      !v && attachBtn(e, r.sessionId, 'Attach'));
  }));
}

function epicStrip(e) {
  const f = data.factory;
  const role = STAGE_ROLE[e.stage];
  const plan = f.plans[e.id];
  const own = data.board.sprints.some(s => s.epicId === e.id);
  const onBoard = sel.epicId === e.id && sel.sprintId === ALL;
  const openPlan = source => vscode.postMessage({ type: 'openPlan', epicId: e.id, source });
  const changes = h('textarea', { 'data-key': 'changes-' + e.id, rows: '2', placeholder: 'What should change? (sent back to the orchestrator)', 'aria-label': 'Requested plan changes',
    oninput: ev => { drafts[e.id] = ev.target.value; } });
  changes.value = drafts[e.id] ?? '';
  return h('article', { class: 'epic-strip stage-' + e.stage + (e.pending || e.error || e.stage.startsWith('awaiting') ? ' needs' : '') },
    h('div', { class: 'head' },
      h('div', { class: 'titles' },
        plan ? h('button', { class: 'link epic-title', title: `Open ${plan}`, onclick: () => openPlan(true) }, e.title) : h('strong', { class: 'epic-title' }, e.title),
        h('div', { class: 'facts' },
          h('span', { class: 'badge stage-' + e.stage }, f.stages[e.stage] ?? e.stage),
          h('span', { title: e.builderMode === 'auto' ? 'Builders run unattended' : 'Builders pause for shell approvals' }, e.builderMode === 'auto' ? '🤖 Full auto' : '🛡 Accept edits'),
          e.branch && h('span', { title: 'Epic branch → PR target' }, h('code', {}, e.branch), ` → ${e.targetBranch ?? f.targetBranch}`),
          e.attachments?.length > 0 && h('span', { title: 'Reference files given to every factory session' }, '📎 ',
            e.attachments.map(a => h('button', { class: 'link', title: `Open ${a.name}`,
              onclick: () => vscode.postMessage({ type: 'openEpicAttachment', epicId: e.id, attachmentId: a.id }) }, a.name))))),
      h('div', { class: 'actions' },
        own && h('button', { class: onBoard ? 'on' : '', 'aria-pressed': String(onBoard), title: 'Show this epic\'s stories on the board below',
          onclick: () => onBoard ? select(e.projectId, null, null) : select(e.projectId, ALL, e.id) }, onBoard ? '✓ On board' : 'Show on board'),
        plan && h('button', { onclick: () => openPlan(false) }, 'View plan'),
        !['done', 'cancelled', 'awaitingPlanApproval'].includes(e.stage) && h('button', { class: 'quiet', onclick: () => gate(e.id, 'cancel') }, 'Cancel'),
        e.stage === 'done' && !e.archived && h('button', { class: 'quiet', onclick: () => gate(e.id, 'archive') }, 'Archive'),
        ['cancelled', 'failed'].includes(e.stage) && h('button', { class: 'primary', onclick: () => gate(e.id, 'restart') }, 'Restart'))),
    stepper(e),
    role && !e.error && activity(sessionState(e.stageSessionId), `${e.roleAgents?.[role] ?? `LexCode ${role}`} ${STAGE_VERB[e.stage]}`,
      attachBtn(e, e.stageSessionId, 'Attach')),
    e.error && h('div', { class: 'alert' }, h('span', {}, e.error), h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => gate(e.id, 'retry') }, 'Retry')),
    ['ready', 'building', 'paused'].includes(e.stage) && buildControls(e),
    RUNNING.includes(e.stage) && sprintRows(e),
    e.stage === 'awaitingPrApproval' && prGate(e),
    e.stage === 'done' && e.prUrl && h('p', {}, 'Pull request: ', h('a', { href: e.prUrl }, e.prUrl)),
    e.stage === 'awaitingPlanApproval' && h('div', { class: 'gate' },
      h('p', { class: 'prompt' }, 'The plan is ready. ', plan && h('button', { class: 'link', onclick: () => openPlan(false) }, 'Read it'), ', then approve or ask for changes.'),
      h('div', { class: 'row' }, changes,
        h('div', { class: 'stack' },
          h('button', { class: 'primary', onclick: () => gate(e.id, 'approve') }, 'Approve plan'),
          h('button', { onclick: () => changes.value.trim() ? gate(e.id, 'changes', changes.value) : changes.focus() }, 'Request changes'),
          h('button', { class: 'quiet', onclick: () => gate(e.id, 'reject') }, 'Reject')))));
}

function buildControls(e) {
  const workers = h('input', { type: 'number', min: '1', max: '8', value: e.workers ?? data.factory.workers ?? 1, class: 'pts', 'aria-label': 'Builders',
    onchange: ev => e.stage !== 'ready' && gate(e.id, 'workers', undefined, { workers: +ev.target.value }) });
  const { sprints, stories } = data.board;
  const sp = sprints.filter(s => s.epicId === e.id), st = stories.filter(s => s.epicId === e.id && !s.archived);
  const done = st.filter(s => s.status === 'done').length;
  return h('div', { class: 'row progress' },
    h('div', { class: 'bar', title: `${done}/${st.length} stories done` }, fill(st.length ? done / st.length : 0)),
    h('span', { class: 'muted' }, `${done}/${st.length} stories · ${sp.filter(s => s.state === 'merged').length}/${sp.length} sprints merged`
      + (e.stage === 'paused' ? ' · paused: no new sessions start' : '')),
    h('span', { class: 'spacer' }),
    h('label', { class: 'inline', title: 'How many sprints may build at the same time' }, 'Builders', workers),
    e.stage === 'ready'
      ? h('button', { class: 'primary', onclick: () => { gate(e.id, 'start', undefined, { workers: +workers.value }); select(e.projectId, ALL, e.id); } }, '▶ Start build')
      : h('button', { onclick: () => gate(e.id, e.stage === 'paused' ? 'resume' : 'pause') }, e.stage === 'paused' ? '▶ Resume' : '⏸ Pause'));
}

const SPRINT_STATE = { waiting: 'waiting', building: 'building', reviewing: 'sprint review', fixing: 'fixing', awaitingMerge: 'merge needs approval', merged: 'merged' };

function sprintRows(e) {
  const { sprints, stories } = data.board;
  const rows = sprints.filter(s => s.epicId === e.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!rows.length) return null;
  return h('ol', { class: 'sprints' }, rows.map(sp => {
    const own = stories.filter(s => s.sprintId === sp.id && !s.archived);
    const done = own.filter(s => s.status === 'done').length;
    const cur = own.find(s => s.status !== 'done');
    const curSid = cur && (cur.status === 'review' ? cur.reviewerSessionId : cur.builderSessionId);
    const name = sp.key && sp.name.startsWith(sp.key + ': ') ? sp.name.slice(sp.key.length + 2) : sp.name;
    const after = (sp.dependsOn ?? []).map(id => sprints.find(x => x.id === id)).filter(d => d && d.state !== 'merged').map(d => d.key ?? d.name);
    const note = h('textarea', { 'data-key': 'sendback-' + sp.id, rows: '2', placeholder: 'What should the builder fix before merging?', 'aria-label': 'Send back note',
      oninput: ev => { drafts[sp.id] = ev.target.value; } });
    note.value = drafts[sp.id] ?? '';
    const state = sp.state ?? 'waiting';
    return h('li', { class: `sprint state-${state}` + (sp.blocked || state === 'awaitingMerge' || cur?.blocked ? ' needs' : '') + (sel.sprintId === sp.id ? ' selected' : '') },
      h('div', { class: 'row' },
        sp.key && h('span', { class: 'key' }, sp.key),
        h('button', { class: 'link sprint-name', title: 'Show this sprint on the board', onclick: () => select(e.projectId, sp.id, e.id) }, name),
        h('span', { class: 'badge state-' + state }, SPRINT_STATE[state]),
        sp.parallel && h('span', { class: 'muted', title: 'Can run alongside other parallel sprints' }, '⇉ parallel'),
        state === 'waiting' && after.length > 0 && h('span', { class: 'muted' }, `after ${after.join(', ')}`),
        h('span', { class: 'spacer' }),
        h('div', { class: 'bar mini', title: `${done}/${own.length} stories done` }, fill(own.length ? done / own.length : 0)),
        h('span', { class: 'muted count' }, `${done}/${own.length}`)),
      state === 'building' && cur && !cur.blocked && activity(sessionState(curSid),
        `${cur.status === 'review' ? 'Reviewing' : 'Building'} “${cur.title}”${cur.attempts ? ` · attempt ${cur.attempts + 1}` : ''}`, attachBtn(e, curSid, 'Attach')),
      state === 'reviewing' && reviewPanel(e, sp),
      state === 'fixing' && activity(sessionState(sp.sessionId), 'Fixing sprint review issues', attachBtn(e, sp.sessionId, 'Attach')),
      state === 'fixing' && sp.issues?.length > 0 && h('ul', { class: 'issues' }, sp.issues.map(i => h('li', {}, i))),
      sp.blocked && h('div', { class: 'alert' }, h('span', {}, sp.blocked), h('span', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: () => gate(e.id, 'retrySprint', undefined, { sprintId: sp.id }) }, 'Retry')),
      cur?.blocked && h('div', { class: 'alert' },
        h('span', {}, `“${cur.title}”: ${cur.blocked}`),
        cur.reviewNotes && h('span', { class: 'muted', title: cur.reviewNotes }, 'ⓘ last review'),
        h('span', { class: 'spacer' }),
        attachBtn(e, cur.builderSessionId, 'Take over'),
        h('button', { onclick: () => gate(e.id, 'skipStory', undefined, { storyId: cur.id }) }, 'Skip'),
        h('button', { class: 'primary', onclick: () => gate(e.id, 'retryStory', undefined, { storyId: cur.id }) }, 'Retry')),
      state === 'awaitingMerge' && h('div', { class: 'gate' },
        h('p', { class: 'prompt' }, 'This merge needs your approval:'),
        h('ul', { class: 'reasons' }, (sp.critical ?? []).map(r => h('li', {}, r))),
        h('div', { class: 'row' }, note,
          h('div', { class: 'stack' },
            h('button', { class: 'primary', onclick: () => gate(e.id, 'approveMerge', undefined, { sprintId: sp.id }) }, 'Approve merge'),
            h('button', { onclick: () => note.value.trim() ? (delete drafts[sp.id], gate(e.id, 'sendBack', note.value, { sprintId: sp.id })) : note.focus() }, 'Send back')))));
  }));
}

const PR_VIA = [['auto', 'Auto (GitHub → gh, else Gitea)'], ['gh', 'GitHub (gh)'], ['tea', 'Gitea (tea login)'], ['skill', 'Claude skill…']];
function prGate(e) {
  const p = data.board.projects.find(x => x.id === e.projectId), pend = e.pending ?? {};
  const busy = pend.busy && Date.now() - pend.busy < 120000; // older: the window reloaded mid-way
  const box = (...kids) => h('div', { class: 'gate' }, h('p', { class: 'prompt' }, 'All sprints are merged into ', h('code', {}, e.branch), '.'), kids);
  if (pend.skill) {
    const url = h('input', { placeholder: 'https://…/pulls/123', 'aria-label': 'PR URL', 'data-key': 'prurl-' + e.id });
    return box(h('p', {}, `/${pend.skill} is running in a terminal. Once it has opened the PR, paste its URL to finish the epic.`),
      h('div', { class: 'row' }, url,
        h('button', { class: 'primary', onclick: () => /^https?:\/\/\S+$/.test(url.value.trim()) ? gate(e.id, 'prOpened', undefined, { url: url.value.trim() }) : url.focus() }, 'PR opened'),
        h('button', { class: 'quiet', onclick: () => gate(e.id, 'createPr', undefined, { targetBranch: e.targetBranch, via: 'skill', skill: pend.skill }) }, 'Run again')));
  }
  const target = h('input', { value: e.targetBranch ?? data.factory.targetBranch, 'aria-label': 'PR target branch', 'data-key': 'pr-' + e.id });
  const skills = data.factory.skills?.[e.projectId] ?? [];
  const skill = h('select', { 'aria-label': 'PR skill', 'data-key': 'prskill-' + e.id },
    skills.length ? skills.map(n => h('option', { value: n, selected: n === p?.pr?.skill }, '/' + n)) : h('option', { value: '' }, 'No skills found'));
  const hint = h('p', { class: 'muted' }, 'Runs the skill in a terminal at the project root with the target and the epic branch, e.g. ',
    h('code', {}, `/${p?.pr?.skill ?? skills[0] ?? 'git-release'} ${e.targetBranch ?? data.factory.targetBranch} ${e.branch}`), '.');
  const via = h('select', { 'aria-label': 'Create the PR with', 'data-key': 'prvia-' + e.id, onchange: () => { skill.hidden = hint.hidden = via.value !== 'skill'; } },
    PR_VIA.map(([v, label]) => h('option', { value: v, selected: v === (p?.pr?.via ?? 'auto') }, label)));
  skill.hidden = hint.hidden = via.value !== 'skill';
  return box(
    h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Open a PR into', target), h('label', { class: 'inline' }, 'with', via), skill,
      h('button', { class: 'primary', disabled: busy || undefined, 'aria-busy': busy ? 'true' : undefined,
        onclick: () => gate(e.id, 'createPr', undefined, { targetBranch: target.value, via: via.value, skill: skill.value }) }, busy ? 'Creating…' : 'Create PR')),
    hint,
    pend.reason && !busy && h('div', { class: 'alert' }, h('span', {}, pend.reason)));
}

const epicDialog = document.getElementById('epic');
epicDialog.addEventListener('click', e => { if (e.target === epicDialog) epicDialog.close(); });

function openEpicForm(project) {
  const f = data.factory;
  const ra = f.roleAgents[project.id] ?? { agents: [], roles: {} };
  const field = (label, el) => h('label', {}, label, el);
  const title = h('input', { class: 'title', placeholder: 'Epic title', 'aria-label': 'Epic title' });
  const desc = h('textarea', { 'data-key': 'epic-desc', placeholder: 'Goal, constraints, acceptance criteria. The orchestrator plans from this. Paste screenshots here.', 'aria-label': 'Description',
    onpaste: e => { const fs = pasted(e); if (fs.length) { e.preventDefault(); addRefs(fs); } } });
  // Reference files (screenshots, mockups): held here until the epic is created, then sent with it.
  const refs = [];
  const refInput = h('input', { type: 'file', multiple: '', hidden: '', onchange: e => { addRefs(e.target.files); e.target.value = ''; } });
  const refBox = h('div', { class: 'files',
    ondragover: e => { e.preventDefault(); refBox.classList.add('over'); },
    ondragleave: () => refBox.classList.remove('over'),
    ondrop: e => { e.preventDefault(); refBox.classList.remove('over'); addRefs(e.dataTransfer.files); } });
  const drawRefs = () => refBox.replaceChildren(...refs.map((r, i) => h('div', { class: 'file' },
      h('span', { class: 'thumb', title: r.name }, r.mime.startsWith('image/') ? h('img', { src: r.url, alt: r.name }) : h('span', { class: 'ext' }, '📄'),
        h('span', { class: 'name' }, r.name)),
      h('button', { class: 'x', title: 'Remove', 'aria-label': `Remove ${r.name}`, onclick: () => { refs.splice(i, 1); drawRefs(); } }, '×'))),
    h('button', { class: 'drop', onclick: () => refInput.click() }, 'Drop screenshots or files, paste into the description, or click to attach'), refInput);
  function addRefs(files) {
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { err.textContent = `${f.name} is over 25 MB.`; continue; }
      const r = new FileReader();
      r.onload = () => { refs.push({ name: f.name, mime: f.type, url: String(r.result), data: String(r.result).split(',')[1] }); drawRefs(); };
      r.readAsDataURL(f);
    }
  }
  drawRefs();
  const mode = h('select', {}, h('option', { value: 'acceptEdits', selected: f.builderMode !== 'auto' }, '🛡 Accept edits: builders pause for shell approvals'),
    h('option', { value: 'auto', selected: f.builderMode === 'auto' }, '🤖 Full auto: builders run unattended'));
  const target = h('input', { value: f.targetBranch, 'aria-label': 'Target branch' });
  const roles = Object.fromEntries(Object.keys(ROLE_LABELS).map(r => [r, h('select', { 'aria-label': ROLE_LABELS[r] },
    h('option', { value: '' }, 'LexCode default'),
    ra.agents.map(a => h('option', { value: a.name, selected: ra.roles[r] === a.name, title: a.description }, `${a.name} (${a.scope})`)))]));
  const models = Object.fromEntries(Object.keys(MODEL_ROLES).map(r => {
    const d = { ...(r === 'planner' ? { model: 'opus', effort: 'high' } : {}), ...f.models[r] };
    return [r, {
      model: h('select', { 'aria-label': `${MODEL_ROLES[r]} model` }, h('option', { value: '' }, `Default (${d.model ?? 'Claude default'})`), MODELS.map(m => h('option', { value: m }, m))),
      effort: h('select', { 'aria-label': `${MODEL_ROLES[r]} effort` }, h('option', { value: '' }, `Default (${d.effort ?? 'Claude default'})`), f.efforts.map(x => h('option', { value: x }, x))),
    }];
  }));
  // Sprint review panel: any number of reviewers ('' = LexCode reviewer); the first checked one also reviews each story.
  const reviewers = [{ name: '', label: 'LexCode reviewer', description: 'Bundled general reviewer' },
    ...ra.agents.map(a => ({ name: a.name, label: `${a.name} (${a.scope})`, description: a.description }))]
    .map(a => h('input', { type: 'checkbox', value: a.name, checked: (ra.roles.reviewer ?? '') === a.name, 'data-label': a.label, title: a.description }));
  const err = h('p', { class: 'error' });
  const submit = start => {
    if (!title.value.trim()) { err.textContent = 'Title is required.'; return title.focus(); }
    vscode.postMessage({ type: 'addEpic', id: project.id, start, title: title.value, description: desc.value, targetBranch: target.value, builderMode: mode.value,
      roleAgents: Object.fromEntries(Object.entries(roles).map(([r, el]) => [r, el.value])),
      reviewers: reviewers.filter(c => c.checked).map(c => c.value),
      models: Object.fromEntries(Object.entries(models).map(([r, m]) => [r, { model: m.model.value, effort: m.effort.value }])),
      attachments: refs.map(({ name, mime, data }) => ({ name, mime, data })) });
    epicDialog.close();
  };
  epicDialog.replaceChildren(h('div', { class: 'modal' },
    h('header', {}, title, h('button', { class: 'x close', title: 'Close', 'aria-label': 'Close', onclick: () => epicDialog.close() }, '×')),
    h('div', { class: 'body' },
      h('main', {}, h('h4', {}, 'Description'), mdEditor(desc), h('h4', {}, 'Reference screenshots & files'), refBox,
        h('details', { class: 'models' }, h('summary', {}, 'Models & effort'),
          h('div', { class: 'grid' }, Object.entries(models).map(([r, m]) => [h('span', {}, MODEL_ROLES[r]), m.model, m.effort])))),
      h('aside', {},
        field('Builder mode', mode),
        field('Target branch', target),
        h('p', { class: 'muted hint' }, 'The epic branch is cut from it now, and the PR goes back into it.'),
        ra.error ? h('p', { class: 'error' }, ra.error) : !ra.agents.length && h('p', { class: 'muted' }, 'No .claude/agents found: LexCode defaults are used.'),
        h('h4', {}, 'Planning'),
        ['orchestrator', 'revalidator', 'security'].map(r => field(ROLE_LABELS[r], roles[r])),
        h('h4', {}, 'Build'),
        field(ROLE_LABELS.builder, roles.builder),
        h('h4', {}, 'Review'),
        h('p', { class: 'muted hint' }, 'Each sprint is reviewed by the Revalidator and Security agents above, plus every reviewer checked here. The first checked reviewer also checks each story.'),
        h('div', { class: 'checks' }, reviewers.map(c => h('label', { class: 'check', title: c.title }, c, c.dataset.label))),
        err,
        h('button', { class: 'primary', onclick: () => submit(true) }, 'Create & plan'),
        h('button', { onclick: () => submit(false) }, 'Create without factory')))));
  epicDialog.showModal();
  title.focus();
}

// Title and description only: the factory has already planned from the description, so editing it later doesn't replan.
function openEpicEdit(e) {
  const title = h('input', { class: 'title', value: e.title, 'aria-label': 'Epic title' });
  const desc = h('textarea', { 'data-key': 'epic-desc', placeholder: 'Goal, constraints, acceptance criteria.', 'aria-label': 'Description' });
  desc.value = e.description ?? '';
  const err = h('p', { class: 'error' });
  const save = () => {
    if (!title.value.trim()) { err.textContent = 'Title is required.'; return title.focus(); }
    vscode.postMessage({ type: 'updateEpic', epicId: e.id, title: title.value, description: desc.value });
    epicDialog.close();
  };
  epicDialog.replaceChildren(h('div', { class: 'modal' },
    h('header', {}, title, h('button', { class: 'x close', title: 'Close', 'aria-label': 'Close', onclick: () => epicDialog.close() }, '×')),
    h('div', { class: 'body' },
      h('main', {}, h('h4', {}, 'Description'), mdEditor(desc)),
      h('aside', {},
        e.stage && h('p', { class: 'muted hint' }, 'The factory has already planned from the description; edits here don\'t replan.'),
        err, h('button', { class: 'primary', onclick: save }, 'Save')))));
  epicDialog.showModal();
  title.focus();
}

function claudeButton(s, n) {
  return h('button', { class: n ? 'claude' : 'claude start', title: n ? 'Resume latest Claude session' : 'Start Claude session',
                        onclick: e => { e.stopPropagation(); vscode.postMessage({ type: 'claude', id: s.id }); } }, n ? 'Claude ↻' : 'Claude ▶');
}

/* ---------- story modal ---------- */
const dialog = document.getElementById('story');
dialog.addEventListener('close', () => { openStoryId = null; dialog.replaceChildren(); });
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // backdrop click

function openStory(id) {
  openStoryId = id;
  edits = { id, files: null };
  vscode.postMessage({ type: 'edits', id });
  renderStory();
  if (!dialog.open) dialog.showModal();
}

const send = (type, extra) => vscode.postMessage({ type, id: openStoryId, ...extra });
const update = patch => send('update', { patch });

// Clipboard files; pasted screenshots all arrive as image.png, so give them distinct names.
const pasted = e => [...e.clipboardData.files].map((f, i) =>
  f.name === 'image.png' ? new File([f], `screenshot-${Date.now()}-${i}.png`, { type: f.type }) : f);

function upload(files) {
  for (const f of files) {
    const r = new FileReader();
    r.onload = () => send('addAttachment', { name: f.name, mime: f.type, data: String(r.result).split(',')[1] });
    r.readAsDataURL(f);
  }
}

function renderStory() {
  const s = data.board.stories.find(x => x.id === openStoryId);
  if (!s) { if (dialog.open) dialog.close(); return; }
  // Board pushes rebuild the modal; keep whatever the user is typing.
  const active = document.activeElement;
  const keep = dialog.contains(active) && active.dataset.key ? { key: active.dataset.key, value: active.value,
    start: active.selectionStart, end: active.selectionEnd } : null;

  const { epics, sprints } = data.board;
  const projSessions = data.sessions[s.projectId] ?? [];
  // Factory sessions run in sprint worktrees (not in the project's session list) and belong to the runner: attach only.
  const linked = storySessions(s).map(({ id, role }) => role ? { id, role, title: `${role} session` }
    : projSessions.find(x => x.id === id) ?? { id, title: '(session file missing)', mtime: 0 });
  const select = (key, opts, value, onchange) => h('select', { 'data-key': key, onchange },
    opts.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));

  const title = h('input', { class: 'title', 'data-key': 'title', value: s.title, 'aria-label': 'Title',
    onchange: e => e.target.value.trim() && update({ title: e.target.value }) });
  const desc = h('textarea', { 'data-key': 'desc', placeholder: 'Add a description… (paste screenshots here)', 'aria-label': 'Description',
    onchange: e => update({ description: e.target.value }),
    onpaste: e => { const files = pasted(e); if (files.length) { e.preventDefault(); upload(files); } } });
  desc.value = s.description ?? '';

  const fileInput = h('input', { type: 'file', multiple: '', hidden: '', onchange: e => { upload(e.target.files); e.target.value = ''; } });
  const files = h('div', { class: 'files',
    ondragover: e => { e.preventDefault(); files.classList.add('over'); },
    ondragleave: () => files.classList.remove('over'),
    ondrop: e => { e.preventDefault(); files.classList.remove('over'); upload(e.dataTransfer.files); } },
    (s.attachments ?? []).map(a => h('div', { class: 'file' },
      h('button', { class: 'thumb', title: `Open ${a.name}`, onclick: () => send('openAttachment', { attachmentId: a.id }) },
        (a.mime || '').startsWith('image/') ? h('img', { src: `${data.attachBase}/${s.id}/${encodeURIComponent(a.file)}`, alt: a.name }) : h('span', { class: 'ext' }, '📄'),
        h('span', { class: 'name' }, a.name)),
      h('button', { class: 'x', title: 'Remove attachment', 'aria-label': `Remove ${a.name}`,
        onclick: () => send('removeAttachment', { attachmentId: a.id }) }, '×'))),
    h('button', { class: 'drop', onclick: () => fileInput.click() }, 'Drop files, paste screenshots, or click to attach'),
    fileInput);

  const mode = select('bgMode', Object.entries(data.modes), bgMode ?? data.defaultMode, e => { bgMode = e.target.value; });
  const unlinked = projSessions.filter(x => !(s.sessionIds ?? []).includes(x.id));
  const side = h('aside', {},
    h('label', {}, 'Status', select('status', [['todo', 'Todo'], ['doing', 'Doing'], ['review', 'Review'], ['done', 'Done']], s.status,
      e => update({ status: e.target.value }))),
    h('label', {}, 'Sprint', select('sprint', [['', 'Backlog'], ...sprints.filter(x => x.projectId === s.projectId).map(x => [x.id, x.name])],
      s.sprintId, e => update({ sprintId: e.target.value || undefined }))),
    h('label', {}, 'Epic', select('epic', [['', '(no epic)'], ...epics.filter(x => x.projectId === s.projectId).map(x => [x.id, x.title])],
      s.epicId, e => update({ epicId: e.target.value || undefined }))),
    h('label', {}, 'Points', h('input', { type: 'number', min: '0', 'data-key': 'points', value: s.points ?? '',
      onchange: e => update({ points: e.target.value === '' ? undefined : +e.target.value }) })),
    h('section', { class: 'sessions' },
      h('h4', {}, `Claude sessions (${linked.length})`),
      linked.length ? linked.map(x => {
        const agent = data.agents[x.id];
        return h('div', { class: 'session' },
          x.role
            ? h('div', { class: 'row' }, h('span', { class: 'link', title: x.id }, h('span', {}, x.title), h('small', {}, 'software factory')))
            : h('div', { class: 'row' },
              h('button', { class: 'link', title: `Resume ${x.id}`, onclick: () => send('resume', { sessionId: x.id }) },
                h('span', {}, x.title), x.mtime ? h('small', {}, ago(x.mtime).replace('Claude ', '')) : null),
              h('button', { class: 'x', title: 'Unlink session', 'aria-label': `Unlink ${x.title}`, onclick: () => send('unlink', { sessionId: x.id }) }, '×')),
          h('div', { class: 'row actions' },
            agent && h('span', { class: 'state ' + agent.state }, agent.state === 'blocked' ? '⚠ needs approval' : agent.state),
            agent && h('button', { class: agent.state === 'blocked' ? 'primary' : '', title: 'Open in terminal to watch or approve',
              onclick: () => send('attach', { sessionId: x.id }) }, agent.state === 'blocked' ? 'Approve…' : 'Attach'),
            !x.role && h('button', { title: 'Continue this session in the background', disabled: data.starting.includes(s.id),
              onclick: () => send('bgRun', { sessionId: x.id, mode: mode.value }) }, '⏵ bg')));
      }) : h('p', { class: 'muted' }, 'No sessions yet.'),
      h('button', { class: 'primary', onclick: () => send('newSession') }, '▶ New Claude session'),
      h('div', { class: 'bg' }, h('label', {}, 'Background permission', mode),
        data.starting.includes(s.id)
          ? h('button', { disabled: '', 'aria-busy': 'true' }, 'Starting… (a few seconds)')
          : h('button', { onclick: () => send('bgRun', { mode: mode.value }) }, '⏵ Run in background')),
      unlinked.length ? select('linkSel', [['', 'Link existing session…'], ...unlinked.map(x => [x.id, x.title])], '',
        e => e.target.value && send('link', { sessionId: e.target.value })) : null),
    h('button', { onclick: () => update({ archived: !s.archived }) }, s.archived ? 'Unarchive' : 'Archive'),
    h('button', { class: 'danger', onclick: () => send('delete') }, 'Delete story'));

  dialog.replaceChildren(h('div', { class: 'modal' },
    h('header', {}, title, h('button', { class: 'x close', title: 'Close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('div', { class: 'body' },
      h('main', {}, h('h4', {}, 'Description'), mdEditor(desc), h('h4', {}, `Attachments (${s.attachments?.length ?? 0})`), files,
        s.refs?.length ? [h('h4', {}, `Task files (${s.refs.length})`), h('ul', { class: 'edits' }, s.refs.map(f => {
          const root = data.board.projects.find(p => p.id === s.projectId)?.path ?? '';
          const rel = f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
          const here = s.source?.file === f;
          return h('li', {},
            h('button', { class: 'link', title: f, onclick: () => send('openFile', { file: f }) }, here ? `${rel}:${s.source.line}` : rel),
            h('small', {}, here ? 'story source · status synced' : f === s.refs[0] ? 'plan' : 'epic / sprint'));
        }))] : null,
        h('h4', {}, `Edited files${edits.files ? ` (${edits.files.length})` : ''}`),
        edits.files == null ? h('p', { class: 'muted' }, 'Loading…')
          : !edits.files.length ? h('p', { class: 'muted' }, 'No files edited by this story\'s Claude sessions yet.')
          : h('ul', { class: 'edits' }, edits.files.map(f => h('li', {},
              h('button', { class: 'link', title: f.file, onclick: () => send('openFile', { file: f.file }) }, f.rel),
              h('small', {}, `${f.edits} edit${f.edits > 1 ? 's' : ''} · ${ago(f.last).replace('Claude ', '')}${f.sessionIds.length > 1 ? ` · ${f.sessionIds.length} sessions` : ''}`))))),
      side)));

  if (keep) {
    const el = dialog.querySelector(`[data-key="${keep.key}"]`);
    if (el) { el.value = keep.value; el.focus(); if (keep.start != null) try { el.setSelectionRange(keep.start, keep.end); } catch {} }
  }
}

window.addEventListener('message', e => {
  if (e.data.type !== 'board' && e.data.type !== 'edits') return;
  if (e.data.type === 'edits') {
    if (e.data.id === openStoryId) { edits = e.data; renderStory(); }
    return;
  }
  data = e.data;
  render();
  if (openStoryId) { renderStory(); vscode.postMessage({ type: 'edits', id: openStoryId }); }
});
vscode.postMessage({ type: 'ready' });
