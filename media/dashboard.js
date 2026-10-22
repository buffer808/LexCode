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
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
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
    const open = stories.filter(s => s.projectId === p.id && s.status !== 'done').length;
    const total = stories.filter(s => s.projectId === p.id).length;
    return h('button', { class: 'card' + (p.id === sel.projectId ? ' selected' : ''), onclick: () => select(p.id, active?.id ?? null) },
      h('strong', {}, p.name),
      h('span', { class: 'sub' }, `${active ? active.name : 'no active sprint'} · ${open} open`),
      h('div', { class: 'bar', title: `${total - open}/${total} done` }, fill(total ? (total - open) / total : 0)),
      h('span', { class: 'sub' }, ago(data.sessions[p.id]?.[0]?.mtime)));
  }), h('button', { class: 'card', onclick: () => vscode.postMessage({ type: 'addProject' }) }, h('strong', {}, '+ Add project'))));

  const project = projects.find(p => p.id === sel.projectId);
  if (!project) return;

  const epicMatch = s => sel.epicId === null || (s.epicId ?? NONE) === sel.epicId;
  // With an epic picked, only offer sprints holding its stories (plus the current one, so the select never lies).
  const projSprints = sprints.filter(sp => sp.projectId === project.id && (sel.epicId === null || sp.id === sel.sprintId
    || stories.some(s => s.sprintId === sp.id && epicMatch(s))));
  const picker = h('select', { onchange: e => select(project.id, e.target.value || null, sel.epicId) },
    h('option', { value: '' }, 'Backlog'),
    h('option', { value: ALL, selected: sel.sprintId === ALL }, 'All sprints'),
    projSprints.map(s => h('option', { value: s.id, selected: s.id === sel.sprintId }, s.name + (s.active ? ' (active)' : ''))));

  const projEpics = epics.filter(e => e.projectId === project.id);
  const epicFilter = h('select', { 'aria-label': 'Filter by epic', onchange: e => select(project.id, sel.sprintId, e.target.value || null) },
    h('option', { value: '' }, 'All epics'),
    h('option', { value: NONE, selected: sel.epicId === NONE }, '(no epic)'),
    projEpics.map(e => h('option', { value: e.id, selected: e.id === sel.epicId }, e.title)));

  app.append(h('h2', { class: 'project' }, project.name), h('header', {}, picker, projEpics.length ? epicFilter : null, h('span', { class: 'spacer' }),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: sel.showArchived,
      onchange: e => { sel.showArchived = e.target.checked; vscode.setState(sel); render(); } }), 'Show archived'),
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
        const epic = epics.find(e => e.id === s.epicId);
        const n = s.sessionIds?.length ?? 0;
        const blocked = [...(s.sessionIds ?? []), s.builderSessionId, s.reviewerSessionId].some(id => id && data.agents[id]?.state === 'blocked');
        const claude = claudeButton(s, n);
        return h('div', { class: 'story' + (blocked ? ' needs' : '') + (s.archived ? ' archived' : ''), draggable: 'true', tabindex: '0', role: 'button',
          onclick: () => openStory(s.id), onkeydown: e => { if (e.key === 'Enter') openStory(s.id); },
          ondragstart: e => e.dataTransfer.setData('text/plain', s.id) },
          h('div', {}, s.title),
          h('div', { class: 'meta' },
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
const ROLE_LABELS = { orchestrator: 'Orchestrator (plans)', revalidator: 'Revalidator', security: 'Security check', builder: 'Builder', reviewer: 'Reviewer' };
const STAGE_ROLE = { planning: 'orchestrator', revalidating: 'revalidator', securityCheck: 'security' };
const MODEL_ROLES = { planner: 'Planner (plan, revalidate, security)', builder: 'Builder', reviewer: 'Reviewer' };
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const drafts = {}; // epic id → unsent "request changes" text; survives board re-renders
const gate = (epicId, decision, text, extra) => { if (decision === 'changes') delete drafts[epicId]; vscode.postMessage({ type: 'factoryGate', epicId, decision, text, ...extra }); };

function epicStrip(e) {
  const f = data.factory;
  const role = STAGE_ROLE[e.stage];
  const agent = e.stageSessionId && data.agents[e.stageSessionId];
  const planning = !!role;
  const changes = h('textarea', { 'data-key': 'changes-' + e.id, rows: '2', placeholder: 'What should change? (sent back to the orchestrator)', 'aria-label': 'Requested plan changes',
    oninput: ev => { drafts[e.id] = ev.target.value; } });
  changes.value = drafts[e.id] ?? '';
  return h('div', { class: 'epic-strip' + (e.pending || e.error ? ' needs' : '') },
    h('div', { class: 'row' },
      f.plans[e.id]
        ? h('button', { class: 'link epic-title', title: `Open ${f.plans[e.id]}`, onclick: () => vscode.postMessage({ type: 'openPlan', epicId: e.id, source: true }) }, e.title)
        : h('strong', {}, e.title),
      h('span', { class: 'badge stage-' + e.stage }, f.stages[e.stage] ?? e.stage),
      h('span', { class: 'badge', title: e.builderMode === 'auto' ? 'Builders run unattended' : 'Builders pause for shell approvals' },
        e.builderMode === 'auto' ? '🤖 Full auto' : '🛡 Accept edits'),
      planning && !e.error && h('span', { class: 'muted' }, `${e.roleAgents?.[role] ? `agent: ${e.roleAgents[role]}` : 'LexCode ' + role}${agent ? ` · ${agent.state}` : ' · starting…'}`),
      h('span', { class: 'spacer' }),
      f.plans[e.id] && h('button', { class: 'link', title: 'Open the plan file in an editor', onclick: () => vscode.postMessage({ type: 'openPlan', epicId: e.id, source: true }) },
        h('small', {}, f.plans[e.id])),
      f.plans[e.id] && h('button', { onclick: () => vscode.postMessage({ type: 'openPlan', epicId: e.id }) }, 'View plan'),
      agent && planning && h('button', { class: agent.state === 'blocked' ? 'primary' : '', onclick: () => vscode.postMessage({ type: 'attachEpic', epicId: e.id }) },
        agent.state === 'blocked' ? 'Approve…' : 'Attach'),
      e.error && h('button', { class: 'primary', onclick: () => gate(e.id, 'retry') }, 'Retry'),
      !['done', 'cancelled', 'awaitingPlanApproval'].includes(e.stage) && h('button', { class: 'link', onclick: () => gate(e.id, 'cancel') }, 'Cancel')),
    e.error && h('p', { class: 'error' }, e.error),
    ['ready', 'building', 'paused'].includes(e.stage) && buildControls(e),
    ['building', 'paused', 'awaitingPrApproval'].includes(e.stage) && sprintRows(e),
    e.stage === 'awaitingPrApproval' && prGate(e),
    e.stage === 'done' && e.prUrl && h('p', {}, 'Pull request: ', h('a', { href: e.prUrl }, e.prUrl)),
    e.stage === 'awaitingPlanApproval' && h('div', { class: 'row gate' }, changes,
      h('button', { onclick: () => changes.value.trim() ? gate(e.id, 'changes', changes.value) : changes.focus() }, 'Request changes'),
      h('button', { class: 'danger', onclick: () => gate(e.id, 'reject') }, 'Reject'),
      h('button', { class: 'primary', onclick: () => gate(e.id, 'approve') }, 'Approve plan')));
}

const sessionState = sid => sid && data.agents[sid]?.state;
const attachBtn = (e, sid, label) => sessionState(sid) && h('button', { class: sessionState(sid) === 'blocked' ? 'primary' : '',
  onclick: () => vscode.postMessage({ type: 'attachEpic', epicId: e.id, sessionId: sid }) }, sessionState(sid) === 'blocked' ? '⚠ Approve…' : label);

function buildControls(e) {
  const workers = h('input', { type: 'number', min: '1', max: '8', value: e.workers ?? data.factory.workers ?? 1, class: 'pts', 'aria-label': 'Builders',
    onchange: ev => e.stage !== 'ready' && gate(e.id, 'workers', undefined, { workers: +ev.target.value }) });
  const { sprints, stories } = data.board;
  const sp = sprints.filter(s => s.epicId === e.id), st = stories.filter(s => s.epicId === e.id && !s.archived);
  return h('div', { class: 'row gate' },
    h('label', { class: 'inline' }, 'Builders', workers),
    e.stage === 'ready'
      ? h('button', { class: 'primary', onclick: () => gate(e.id, 'start', undefined, { workers: +workers.value }) }, '▶ Start build')
      : h('button', { onclick: () => gate(e.id, e.stage === 'paused' ? 'resume' : 'pause') }, e.stage === 'paused' ? '▶ Resume' : '⏸ Pause'),
    h('span', { class: 'muted' }, `${sp.filter(s => s.state === 'merged').length}/${sp.length} sprints merged · ${st.filter(s => s.status === 'done').length}/${st.length} stories done`
      + (e.stage === 'paused' ? ' · paused: no new sessions start' : '')));
}

const SPRINT_STATE = { waiting: 'waiting', building: 'building', reviewing: 'sprint review', fixing: 'fixing', awaitingMerge: 'merge needs approval', merged: 'merged' };

function sprintRows(e) {
  const { sprints, stories } = data.board;
  const rows = sprints.filter(s => s.epicId === e.id && s.state !== 'merged').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!rows.length) return null;
  return h('div', { class: 'sprints' }, rows.map(sp => {
    const own = stories.filter(s => s.sprintId === sp.id && !s.archived);
    const cur = own.find(s => s.status !== 'done');
    const curSid = cur && (cur.status === 'review' ? cur.reviewerSessionId : cur.builderSessionId);
    const note = h('textarea', { 'data-key': 'sendback-' + sp.id, rows: '2', placeholder: 'What should the builder fix before merging?', 'aria-label': 'Send back note',
      oninput: ev => { drafts[sp.id] = ev.target.value; } });
    note.value = drafts[sp.id] ?? '';
    return h('div', { class: 'sprint' + (sp.blocked || sp.state === 'awaitingMerge' || cur?.blocked ? ' needs' : '') },
      h('div', { class: 'row' },
        h('strong', {}, sp.name),
        h('span', { class: 'badge state-' + (sp.state ?? 'waiting') }, SPRINT_STATE[sp.state ?? 'waiting']),
        sp.parallel && h('span', { class: 'muted', title: 'Can run alongside other parallel sprints' }, '∥ parallel'),
        h('span', { class: 'muted' }, `${own.filter(s => s.status === 'done').length}/${own.length} stories`),
        sp.state === 'building' && cur && h('span', { class: 'muted' }, `${cur.status === 'review' ? 'reviewing' : 'building'}: ${cur.title}${cur.attempts ? ` (attempt ${cur.attempts + 1})` : ''}${sessionState(curSid) ? ` · ${sessionState(curSid)}` : ''}`),
        h('span', { class: 'spacer' }),
        sp.state === 'building' && attachBtn(e, curSid, 'Attach'),
        ['reviewing', 'fixing'].includes(sp.state) && attachBtn(e, sp.sessionId, 'Attach')),
      sp.blocked && h('div', { class: 'row' }, h('span', { class: 'error' }, sp.blocked), h('span', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: () => gate(e.id, 'retrySprint', undefined, { sprintId: sp.id }) }, 'Retry')),
      cur?.blocked && h('div', { class: 'row' },
        h('span', { class: 'error' }, `${cur.title}: ${cur.blocked}`),
        cur.reviewNotes && h('span', { class: 'muted', title: cur.reviewNotes }, 'ⓘ last review'),
        h('span', { class: 'spacer' }),
        attachBtn(e, cur.builderSessionId, 'Take over'),
        h('button', { onclick: () => gate(e.id, 'skipStory', undefined, { storyId: cur.id }) }, 'Skip'),
        h('button', { class: 'primary', onclick: () => gate(e.id, 'retryStory', undefined, { storyId: cur.id }) }, 'Retry')),
      sp.state === 'awaitingMerge' && [
        h('ul', { class: 'reasons' }, (sp.critical ?? []).map(r => h('li', {}, r))),
        h('div', { class: 'row gate' }, note,
          h('button', { onclick: () => note.value.trim() ? (delete drafts[sp.id], gate(e.id, 'sendBack', note.value, { sprintId: sp.id })) : note.focus() }, 'Send back'),
          h('button', { class: 'primary', onclick: () => gate(e.id, 'approveMerge', undefined, { sprintId: sp.id }) }, 'Approve merge'))]);
  }));
}

function prGate(e) {
  const target = h('input', { value: e.targetBranch ?? data.factory.targetBranch, 'aria-label': 'PR target branch', 'data-key': 'pr-' + e.id });
  return h('div', { class: 'row gate' }, h('span', {}, `All sprints merged into ${e.branch}. Open a PR into`), target,
    h('button', { class: 'primary', onclick: () => gate(e.id, 'createPr', undefined, { targetBranch: target.value }) }, 'Create PR'));
}

const epicDialog = document.getElementById('epic');
epicDialog.addEventListener('click', e => { if (e.target === epicDialog) epicDialog.close(); });

function openEpicForm(project) {
  const f = data.factory;
  const ra = f.roleAgents[project.id] ?? { agents: [], roles: {} };
  const field = (label, el) => h('label', {}, label, el);
  const title = h('input', { class: 'title', placeholder: 'Epic title', 'aria-label': 'Epic title' });
  const desc = h('textarea', { placeholder: 'Goal, constraints, acceptance criteria. The orchestrator plans from this.', 'aria-label': 'Description' });
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
  const err = h('p', { class: 'error' });
  const submit = start => {
    if (!title.value.trim()) { err.textContent = 'Title is required.'; return title.focus(); }
    vscode.postMessage({ type: 'addEpic', id: project.id, start, title: title.value, description: desc.value, targetBranch: target.value, builderMode: mode.value,
      roleAgents: Object.fromEntries(Object.entries(roles).map(([r, el]) => [r, el.value])),
      models: Object.fromEntries(Object.entries(models).map(([r, m]) => [r, { model: m.model.value, effort: m.effort.value }])) });
    epicDialog.close();
  };
  epicDialog.replaceChildren(h('div', { class: 'modal' },
    h('header', {}, title, h('button', { class: 'x close', title: 'Close', 'aria-label': 'Close', onclick: () => epicDialog.close() }, '×')),
    h('div', { class: 'body' },
      h('main', {}, h('h4', {}, 'Description'), desc,
        h('details', { class: 'models' }, h('summary', {}, 'Models & effort'),
          h('div', { class: 'grid' }, Object.entries(models).map(([r, m]) => [h('span', {}, MODEL_ROLES[r]), m.model, m.effort])))),
      h('aside', {},
        field('Builder mode', mode),
        field('PR target branch', target),
        h('h4', {}, 'Agents'),
        ra.error ? h('p', { class: 'error' }, ra.error) : !ra.agents.length && h('p', { class: 'muted' }, 'No .claude/agents found: LexCode defaults are used.'),
        Object.entries(roles).map(([r, el]) => field(ROLE_LABELS[r], el)),
        err,
        h('button', { class: 'primary', onclick: () => submit(true) }, 'Create & plan'),
        h('button', { onclick: () => submit(false) }, 'Create without factory')))));
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
  const linked = (s.sessionIds ?? []).map(id => projSessions.find(x => x.id === id) ?? { id, title: '(session file missing)', mtime: 0 });
  const select = (key, opts, value, onchange) => h('select', { 'data-key': key, onchange },
    opts.map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));

  const title = h('input', { class: 'title', 'data-key': 'title', value: s.title, 'aria-label': 'Title',
    onchange: e => e.target.value.trim() && update({ title: e.target.value }) });
  const desc = h('textarea', { 'data-key': 'desc', placeholder: 'Add a description… (paste screenshots here)', 'aria-label': 'Description',
    onchange: e => update({ description: e.target.value }),
    onpaste: e => {
      const files = [...e.clipboardData.files].map((f, i) =>
        f.name === 'image.png' ? new File([f], `screenshot-${Date.now()}-${i}.png`, { type: f.type }) : f);
      if (files.length) { e.preventDefault(); upload(files); }
    } });
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
          h('div', { class: 'row' },
            h('button', { class: 'link', title: `Resume ${x.id}`, onclick: () => send('resume', { sessionId: x.id }) },
              h('span', {}, x.title), x.mtime ? h('small', {}, ago(x.mtime).replace('Claude ', '')) : null),
            h('button', { class: 'x', title: 'Unlink session', 'aria-label': `Unlink ${x.title}`, onclick: () => send('unlink', { sessionId: x.id }) }, '×')),
          h('div', { class: 'row actions' },
            agent && h('span', { class: 'state ' + agent.state }, agent.state === 'blocked' ? '⚠ needs approval' : agent.state),
            agent && h('button', { class: agent.state === 'blocked' ? 'primary' : '', title: 'Open in terminal to watch or approve',
              onclick: () => send('attach', { sessionId: x.id }) }, agent.state === 'blocked' ? 'Approve…' : 'Attach'),
            h('button', { title: 'Continue this session in the background', disabled: data.starting.includes(s.id),
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
      h('main', {}, h('h4', {}, 'Description'), desc, h('h4', {}, `Attachments (${s.attachments?.length ?? 0})`), files,
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
