// Browser stand-in for the VS Code webview API so dashboard.js runs unchanged under `lexcode ui`,
// plus the dialogs, toasts and terminal tabs the server asks for (Host in src/server.ts).
(() => {
  let ws, queue = [], opened = false;
  const offline = document.getElementById('offline');
  const reply = (reqId, value) => send(JSON.stringify({ type: 'hostReply', reqId, value }));
  const send = s => ws && ws.readyState === 1 ? ws.send(s) : queue.push(s);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

  // done: gets the clicked action (undefined = dismissed); default answers the server.
  function toast(m, done = v => reply(m.reqId, v)) {
    let closed = false;
    const close = v => { if (closed) return; closed = true; t.remove(); done(v); };
    const t = el('div', { className: `toast ${m.level}` }, el('p', { textContent: m.text }),
      el('div', { className: 'acts' }, ...m.actions.map(a => el('button', { textContent: a, onclick: () => close(a) })),
        el('button', { textContent: '×', title: 'Dismiss', onclick: () => close() })));
    document.getElementById('toasts').append(t);
    if (!m.actions.length) setTimeout(close, 6000);
  }

  // Modal message (buttons) or input box; Esc/Cancel = undefined.
  function ask(m) {
    const d = document.getElementById('host-ask');
    const input = m.op === 'input' && el('input', { value: m.value ?? '' });
    const close = v => { d.onclose = null; d.close(); reply(m.reqId, v); };
    const acts = m.op === 'input' ? [el('button', { textContent: 'OK', onclick: () => close(input.value) })]
      : m.actions.map(a => el('button', { textContent: a, onclick: () => close(a) }));
    d.replaceChildren(el('p', { textContent: m.text ?? m.prompt }), ...(m.detail ? [el('p', { className: 'detail', textContent: m.detail })] : []),
      ...(input ? [input] : []), el('div', { className: 'acts' }, ...acts, el('button', { textContent: 'Cancel', onclick: () => close() })));
    if (input) input.onkeydown = e => { if (e.key === 'Enter') close(input.value); };
    d.onclose = () => reply(m.reqId);
    d.showModal();
    (input || acts[0])?.focus();
  }

  // Plan viewer (renderMarkdown: media/markdown.js, which keeps model-written HTML inert).
  function markdown(m) {
    reply(m.reqId);
    const d = document.getElementById('md-view');
    const body = el('div', { className: 'md-body' });
    const show = source => {
      if (source) body.replaceChildren(el('pre', { className: 'md-source', textContent: m.markdown }));
      else body.innerHTML = renderMarkdown(m.markdown);
      rendered.classList.toggle('on', !source); raw.classList.toggle('on', source);
    };
    const rendered = el('button', { textContent: 'Rendered', onclick: () => show(false) });
    const raw = el('button', { textContent: 'Source', onclick: () => show(true) });
    d.replaceChildren(el('header', {}, el('strong', { textContent: m.title }), el('span', { className: 'spacer' }), rendered, raw,
      el('button', { textContent: '×', title: 'Close', onclick: () => d.close() })), body);
    show(m.source);
    if (!d.open) d.showModal();
  }
  document.getElementById('md-view').addEventListener('click', e => { if (e.target.id === 'md-view') e.target.close(); }); // backdrop

  function terminal(m) {
    const url = `/term#${m.id}/${encodeURIComponent(m.title)}`;
    reply(m.reqId);
    // Popup blockers allow this right after a click; otherwise offer a link.
    if (!window.open(url, '_blank')) toast({ level: 'info', text: `${m.title}: terminal ready`, actions: ['Open terminal'] }, v => v && window.open(url, '_blank'));
  }

  function hostOp(m) {
    if (m.op === 'terminal') return terminal(m);
    if (m.op === 'markdown') return markdown(m);
    if (m.op === 'input' || m.modal) return ask(m);
    toast(m);
  }

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      offline.hidden = true;
      if (opened) ws.send(JSON.stringify({ type: 'ready' })); // reconnect: ask for the board again
      opened = true;
      for (const s of queue.splice(0)) ws.send(s);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'host') hostOp(m);
      else window.dispatchEvent(new MessageEvent('message', { data: m }));
    };
    ws.onclose = () => { offline.hidden = false; setTimeout(connect, 1500); };
  }

  window.acquireVsCodeApi = () => ({
    postMessage: m => send(JSON.stringify(m)),
    getState: () => { try { return JSON.parse(localStorage.getItem('lexcode.state')) ?? undefined; } catch { return undefined; } },
    setState: s => { try { localStorage.setItem('lexcode.state', JSON.stringify(s)); } catch {} },
  });
  connect();
})();
