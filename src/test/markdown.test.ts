import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// media/markdown.js is a browser script: run it with marked in a bare context and drive a stub textarea.
test('markdown editor: toolbar formatting, list continuation, safe rendering', () => {
  const media = path.join(__dirname, '..', '..', 'media');
  const ctx: any = vm.createContext({ Event: class { constructor(public type: string) {} }, document: { execCommand: () => false } });
  vm.runInContext(fs.readFileSync(path.join(media, 'vendor', 'marked.umd.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(media, 'markdown.js'), 'utf8') + ';this.api = { mdWrap, mdLines, mdEnter, MD_TOOLS, renderMarkdown }', ctx);
  const { mdWrap, mdEnter, MD_TOOLS, renderMarkdown } = ctx.api;
  const ta = (value: string, s: number, e = s): any => ({ value, selectionStart: s, selectionEnd: e, focus() {}, dispatchEvent() {},
    setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(t: string, a: number, b: number) { this.value = this.value.slice(0, a) + t + this.value.slice(b); this.selectionStart = this.selectionEnd = a + t.length; } });
  const sel = (t: any) => t.value.slice(t.selectionStart, t.selectionEnd);
  let t = ta('make it fast', 8, 12); mdWrap(t, '**'); assert.strictEqual(t.value, 'make it **fast**'); assert.strictEqual(sel(t), 'fast');
  t = ta('', 0); mdWrap(t, '_'); assert.strictEqual(t.value, '_text_'); assert.strictEqual(sel(t), 'text');
  t = ta('a\nb\nc', 0, 5); MD_TOOLS[7][2](t); assert.strictEqual(t.value, '1. a\n2. b\n3. c');
  MD_TOOLS[7][2](t); assert.strictEqual(t.value, 'a\nb\nc'); // toggles off
  t = ta('x\ny', 2); MD_TOOLS[8][2](t); assert.strictEqual(t.value, 'x\n- [ ] y');
  t = ta('- [ ] y', 7); MD_TOOLS[6][2](t); assert.strictEqual(t.value, '- - [ ] y'); // bullet on a task line adds, doesn't strip task
  t = ta('see', 0, 3); MD_TOOLS[5][2](t); assert.strictEqual(t.value, '[see](url)'); assert.strictEqual(sel(t), 'url');
  t = ta('l1\nl2', 0, 5); MD_TOOLS[4][2](t); assert.strictEqual(t.value, '```\nl1\nl2\n```');
  const enter = (v: string, at: number) => { const x = ta(v, at); let p = false; mdEnter(x, { preventDefault: () => { p = true; } }); return [x.value, p]; };
  assert.deepEqual(enter('- one', 5), ['- one\n- ', true]);
  assert.deepEqual(enter('  3. three', 10), ['  3. three\n  4. ', true]);
  assert.deepEqual(enter('- [x] done', 10), ['- [x] done\n- [ ] ', true]);
  assert.deepEqual(enter('a\n- ', 4), ['a\n', true]); // empty item ends list
  assert.deepEqual(enter('plain', 5), ['plain', false]);
  const html = renderMarkdown('- [x] ok\n<script>x</script>');
  assert.match(html, /disabled checked/); assert.doesNotMatch(html, /<script>/);
});
