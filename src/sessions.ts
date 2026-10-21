import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Session { id: string; title: string; mtime: number }

// Claude Code stores sessions in ~/.claude/projects/<cwd with non-alphanumerics → '-'>/<sessionId>.jsonl
export const sessionDir = (projectPath: string, home = os.homedir()) =>
  path.join(home, '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));

export function sessionTitle(jsonl: string): string {
  let custom: string | undefined, ai: string | undefined, firstPrompt: string | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; } // partial last line while session is writing
    if (r.type === 'custom-title') custom = r.customTitle;
    else if (r.type === 'ai-title') ai = r.aiTitle;
    else if (r.type === 'user' && !firstPrompt && !r.isMeta) {
      const c = r.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x.type === 'text')?.text : undefined;
      if (text && !text.startsWith('<')) firstPrompt = text; // skip <command-name>, <ide_...> wrappers
    }
  }
  return (custom ?? ai ?? firstPrompt ?? '(untitled)').split('\n')[0].slice(0, 80);
}

// ponytail: reads whole files on every call, cache by mtime if big histories get slow.
export function listSessions(projectPath: string, home?: string): Session[] {
  const dir = sessionDir(projectPath, home);
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  return files.map(f => {
    const file = path.join(dir, f);
    return { id: f.slice(0, -6), title: sessionTitle(fs.readFileSync(file, 'utf8')), mtime: fs.statSync(file).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

export const sessionExists = (projectPath: string, id: string, home?: string) =>
  fs.existsSync(path.join(sessionDir(projectPath, home), id + '.jsonl'));

export interface FileEdit { file: string; edits: number; last: number; sessionIds: string[] }

const EDIT_TOOLS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

// Files changed by Edit/Write tool calls in the given sessions; failed/rejected calls are skipped.
// ponytail: re-parses whole session files per call, cache by mtime if long sessions get slow.
export function editedFiles(projectPath: string, sessionIds: string[], home?: string): FileEdit[] {
  const byFile = new Map<string, FileEdit>();
  for (const sid of sessionIds) {
    let text: string;
    try { text = fs.readFileSync(path.join(sessionDir(projectPath, home), sid + '.jsonl'), 'utf8'); } catch { continue; }
    const calls = new Map<string, { file: string; time: number }>();
    const failed = new Set<string>();
    for (const line of text.split('\n')) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (r.type === 'assistant' && c.type === 'tool_use' && EDIT_TOOLS[c.name] && typeof c.input?.[EDIT_TOOLS[c.name]] === 'string') {
          calls.set(c.id, { file: c.input[EDIT_TOOLS[c.name]], time: Date.parse(r.timestamp) || 0 });
        }
        if (r.type === 'user' && c.type === 'tool_result' && c.is_error) failed.add(c.tool_use_id);
      }
    }
    for (const [id, { file, time }] of calls) {
      if (failed.has(id)) continue;
      const e = byFile.get(file) ?? { file, edits: 0, last: 0, sessionIds: [] };
      e.edits++;
      e.last = Math.max(e.last, time);
      if (!e.sessionIds.includes(sid)) e.sessionIds.push(sid);
      byFile.set(file, e);
    }
  }
  return [...byFile.values()].sort((a, b) => b.last - a.last);
}
