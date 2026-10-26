// Markdown for the dashboard (VS Code webview and `lexcode ui`): a safe renderer and a GitHub-style editor.

// Write/Preview survives the board re-rendering the dialog (key: the textarea's data-key). First: nothing below may throw before it.
const mdModes = {};
const mdEsc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Text is model- or user-written: raw HTML is shown as text, only http(s) links survive, no images (CSP blocks them anyway).
// No marked (failed to load): escaped plain text, so the editor and dialogs still work.
const mdLib = (() => {
  const m = globalThis.marked;
  if (!m?.use) { console.error('LexCode: marked did not load; markdown previews show plain text.'); return undefined; }
  m.use({ gfm: true, breaks: true, renderer: {
    html: ({ text }) => mdEsc(text),
    image: ({ text }) => mdEsc(text),
    link({ href, tokens }) {
      const t = this.parser.parseInline(tokens);
      return /^https?:\/\//i.test(href) ? `<a href="${mdEsc(href)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t;
    },
    // Task list checkboxes are display-only.
    checkbox: ({ checked }) => `<input type="checkbox" disabled${checked ? ' checked' : ''}> `,
  } });
  return m;
})();
const renderMarkdown = text => mdLib ? mdLib.parse(text) : `<pre class="md-source">${mdEsc(text)}</pre>`;

/* ---------- editor ---------- */

// Replaces the selection; execCommand keeps the textarea's undo stack, setRangeText is the fallback.
function mdReplace(ta, text, selStart, selEnd) {
  const start = ta.selectionStart;
  ta.focus();
  if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  if (selStart != null) ta.setSelectionRange(start + selStart, start + (selEnd ?? selStart));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// **sel** etc.; no selection → placeholder, selected so typing replaces it.
function mdWrap(ta, before, after = before, placeholder = 'text') {
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || placeholder;
  mdReplace(ta, before + sel + after, before.length, before.length + sel.length);
}

// Prefixes every selected line (prefix(i) for numbered lists); removes it when all lines already have it.
function mdLines(ta, prefix, strip) {
  const v = ta.value;
  const from = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let to = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
  if (to < 0) to = v.length;
  const lines = v.slice(from, to).split('\n');
  const on = lines.every(l => strip.test(l));
  const out = lines.map((l, i) => on ? l.replace(strip, '') : prefix(i) + l).join('\n');
  ta.setSelectionRange(from, to);
  mdReplace(ta, out, 0, out.length);
}

const MD_TOOLS = [
  ['H', 'Heading', ta => mdLines(ta, () => '### ', /^#{1,6} /)],
  ['B', 'Bold (⌘B)', ta => mdWrap(ta, '**')],
  ['I', 'Italic (⌘I)', ta => mdWrap(ta, '_')],
  ['❝', 'Quote', ta => mdLines(ta, () => '> ', /^> ?/)],
  ['<>', 'Code (⌘E)', ta => ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')
    ? mdWrap(ta, '```\n', '\n```', 'code') : mdWrap(ta, '`', '`', 'code')],
  ['🔗', 'Link (⌘K)', ta => {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || 'text';
    mdReplace(ta, `[${sel}](url)`, sel.length + 3, sel.length + 6);
  }],
  ['•', 'Bulleted list', ta => mdLines(ta, () => '- ', /^[-*+] (?!\[[ x]\] )/)],
  ['1.', 'Numbered list', ta => mdLines(ta, i => `${i + 1}. `, /^\d+\. /)],
  ['☑', 'Task list', ta => mdLines(ta, () => '- [ ] ', /^[-*+] \[[ x]\] /)],
];
const MD_KEYS = { b: 1, i: 2, e: 4, k: 5 };

// Enter on a list line continues the list; Enter on an empty item ends it.
function mdEnter(ta, e) {
  if (ta.selectionStart !== ta.selectionEnd) return;
  const v = ta.value, from = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  const line = v.slice(from, ta.selectionStart);
  const m = /^(\s*)([-*+] \[[ x]\] |[-*+] |(\d+)\. |> )/.exec(line);
  if (!m) return;
  e.preventDefault();
  if (line === m[0]) { ta.setSelectionRange(from, ta.selectionStart); return mdReplace(ta, ''); }
  const next = m[3] ? `${+m[3] + 1}. ` : m[2].replace('[x]', '[ ]');
  mdReplace(ta, '\n' + m[1] + next);
}

// Wraps a textarea in toolbar + Write/Preview tabs and returns the wrapper (insert it where the textarea was).
function mdEditor(ta, key = ta.dataset.key) {
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const preview = el('div', { className: 'md-body md-preview' });
  const tools = el('span', { className: 'md-tools' }, ...MD_TOOLS.map(([icon, title, fn]) =>
    el('button', { type: 'button', className: 'md-tool', title, ariaLabel: title, textContent: icon,
      onmousedown: e => e.preventDefault(), onclick: () => fn(ta) })));
  const set = previewing => {
    if (key) mdModes[key] = previewing;
    ta.hidden = tools.hidden = previewing;
    preview.hidden = !previewing;
    write.classList.toggle('on', !previewing); show.classList.toggle('on', previewing);
    if (previewing) {
      if (ta.value.trim()) preview.innerHTML = renderMarkdown(ta.value);
      else preview.replaceChildren(el('p', { className: 'muted', textContent: 'Nothing to preview' }));
    }
  };
  const write = el('button', { type: 'button', className: 'md-tab', textContent: 'Write', onclick: () => { set(false); ta.focus(); } });
  const show = el('button', { type: 'button', className: 'md-tab', textContent: 'Preview', onclick: () => set(true) });
  ta.classList.add('md-input');
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) return mdEnter(ta, e);
    const i = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && MD_KEYS[e.key.toLowerCase()];
    if (i != null && i !== false) { e.preventDefault(); MD_TOOLS[i][2](ta); }
  });
  const box = el('div', { className: 'md-editor' }, el('div', { className: 'md-bar' }, write, show, tools), ta, preview,
    el('p', { className: 'md-hint muted', textContent: 'Markdown supported' }));
  set(!!mdModes[key]);
  return box;
}
