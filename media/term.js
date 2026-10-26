// Browser terminal for a session the server queued (#<id>/<title>): attach, resume or a new Claude session.
const [id, title] = location.hash.slice(1).split('/');
if (title) document.title = decodeURIComponent(title);
const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, "Cascadia Mono", monospace' });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('t'));
fit.fit();
const ws = new WebSocket(`ws://${location.host}/pty?id=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`);
ws.onmessage = e => term.write(e.data);
ws.onclose = () => term.write('\r\n\x1b[2m[session closed, you can close this tab]\x1b[0m\r\n');
const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
term.onData(d => send({ d }));
term.onResize(({ cols, rows }) => send({ r: [cols, rows] }));
addEventListener('resize', () => fit.fit());
term.focus();
