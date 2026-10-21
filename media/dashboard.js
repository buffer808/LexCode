const vscode = acquireVsCodeApi();
const STATUSES = ['todo', 'doing', 'review', 'done'];
let data = { board: { projects: [], epics: [], sprints: [], stories: [] }, sessions: {}, agents: {}, starting: [], modes: {}, defaultMode: 'manual', attachBase: '' };
let bgMode = null; // per-dashboard choice, falls back to setting
let openStoryId = null;
let edits = { id: null, files: null }; // edited-files log for the open story, fetched on demand
// Selection survives webview reloads.
// sprintId: null = backlog, ALL = every sprint. epicId: null = all epics, NONE = no epic.
const ALL = '*', NONE = '-';
let sel = { projectId: null, sprintId: null, epicId: null, ...vscode.getState() };

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
  sel = { projectId, sprintId, epicId };
  vscode.setState(sel);
  render();
}

function render() {
  const { projects, epics, sprints, stories } = data.board;
  const app = document.getElementById('app');
  app.replaceChildren();

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
  const picker = h('select', { onchange: e => select(project.id, e.target.value || null) },
    h('option', { value: '' }, 'Backlog'),
    h('option', { value: ALL, selected: sel.sprintId === ALL }, 'All sprints'),
    projSprints.map(s => h('option', { value: s.id, selected: s.id === sel.sprintId }, s.name + (s.active ? ' (active)' : ''))));

  const projEpics = epics.filter(e => e.projectId === project.id);
  const epicFilter = h('select', { 'aria-label': 'Filter by epic', onchange: e => select(project.id, sel.sprintId, e.target.value || null) },
    h('option', { value: '' }, 'All epics'),
    h('option', { value: NONE, selected: sel.epicId === NONE }, '(no epic)'),
    projEpics.map(e => h('option', { value: e.id, selected: e.id === sel.epicId }, e.title)));

  app.append(h('h2', { class: 'project' }, project.name), h('header', {}, picker, projEpics.length ? epicFilter : null, h('span', { class: 'spacer' }),
    h('button', { onclick: () => vscode.postMessage({ type: 'openProject', id: project.id }) }, 'Open in workspace'),
    h('button', { onclick: () => vscode.postMessage({ type: 'importTasks', id: project.id }) }, 'Import tasks'),
    h('button', { onclick: () => vscode.postMessage({ type: 'removeProject', id: project.id }) }, 'Remove project')));

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
    && epicMatch(s));
  app.append(h('section', { class: 'kanban' }, STATUSES.map(status => {
    const col = h('div', { class: 'col', 'data-status': status,
      ondragover: e => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: e => {
        e.preventDefault();
        col.classList.remove('over');
        vscode.postMessage({ type: 'status', id: e.dataTransfer.getData('text/plain'), status });
      } },
      h('h3', {}, h('span', {}, status), h('span', {}, inView.filter(s => s.status === status).length)),
      !inView.some(s => s.status === status) && h('div', { class: 'none' }, 'Drop here'),
      inView.filter(s => s.status === status).map(s => {
        const epic = epics.find(e => e.id === s.epicId);
        const n = s.sessionIds?.length ?? 0;
        const blocked = (s.sessionIds ?? []).some(id => data.agents[id]?.state === 'blocked');
        return h('div', { class: 'story' + (blocked ? ' needs' : ''), draggable: 'true', tabindex: '0', role: 'button',
          onclick: () => openStory(s.id), onkeydown: e => { if (e.key === 'Enter') openStory(s.id); },
          ondragstart: e => e.dataTransfer.setData('text/plain', s.id) },
          h('div', {}, s.title),
          h('div', { class: 'meta' },
            epic && h('span', { class: 'tag' }, epic.title),
            s.points != null && h('span', {}, `${s.points}pt`),
            s.attachments?.length > 0 && h('span', { title: 'Attachments' }, `📎${s.attachments.length}`),
            n > 0 && h('span', {}, `${n} session${n > 1 ? 's' : ''}`)),
          h('div', { class: 'meta' },
            blocked && h('span', { class: 'approve', title: 'Background run needs your approval' }, '⚠ approve'),
            h('button', { class: n ? 'claude' : 'claude start', title: n ? 'Resume latest Claude session' : 'Start Claude session',
              onclick: e => { e.stopPropagation(); vscode.postMessage({ type: 'claude', id: s.id }); } }, n ? 'Claude ↻' : 'Claude ▶')));
      }));
    return col;
  })));
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
    r.onload = () => send('attach', { name: f.name, mime: f.type, data: String(r.result).split(',')[1] });
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
