// Contract between LexCode and the read-only factory stages (plan / revalidate / security / review).
// Agents reply with one ```json block; everything here treats that output as untrusted input.

export type Severity = 'low' | 'medium' | 'high';
export interface PlanStory { title: string; description?: string; points?: number; refs?: string[] }
export interface PlanSprint { key: string; name: string; dependsOn: string[]; parallel: boolean; stories: PlanStory[] }
export interface Finding { severity: Severity; sprint?: string; story?: string; finding: string }
export interface Plan {
  summary: string;
  sprints: PlanSprint[];
  reuse: string[];
  dependencies: { name: string; available: boolean; note?: string }[];
  affectedFiles: string[];
  security: Finding[];
}
export interface Verdict { pass: boolean; risk: 'minor' | 'critical'; issues: string[] }

const SEVERITIES: Severity[] = ['low', 'medium', 'high'];

// Last ```json fenced block, else the whole text if it is bare JSON.
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : text.trim();
  try { return JSON.parse(raw); } catch (e: any) {
    throw new Error(blocks.length ? `invalid JSON in \`\`\`json block: ${e.message}` : 'no ```json block found');
  }
}

const fail = (where: string, what: string): never => { throw new Error(`${where}: ${what}`); };
const str = (v: unknown, where: string) => typeof v === 'string' && v.trim() ? v.trim() : fail(where, 'expected non-empty string');
const optStr = (v: unknown, where: string) => v === undefined || v === null ? undefined : str(v, where);
const arr = (v: unknown, where: string): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : fail(where, 'expected array');
const obj = (v: unknown, where: string): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(where, 'expected object');

// Story refs are handed to builders as files to read: keep them inside the project.
function ref(v: unknown, where: string) {
  const r = str(v, where);
  return r.startsWith('/') || r.startsWith('~') || /^[a-zA-Z]:/.test(r) || r.split(/[\\/]/).includes('..')
    ? fail(where, `ref must be a project-relative path, got "${r}"`) : r;
}

export function validatePlan(input: unknown): Plan {
  const p = obj(input, 'plan');
  const sprints = arr(p.sprints, 'sprints').map((sv, i): PlanSprint => {
    const w = `sprints[${i}]`, s = obj(sv, w);
    const stories = arr(s.stories, `${w}.stories`).map((tv, j): PlanStory => {
      const tw = `${w}.stories[${j}]`, t = obj(tv, tw);
      const points = t.points === undefined || t.points === null ? undefined
        : typeof t.points === 'number' && t.points >= 0 ? t.points : fail(`${tw}.points`, 'expected number >= 0');
      const refs = arr(t.refs, `${tw}.refs`).map((r, k) => ref(r, `${tw}.refs[${k}]`));
      return { title: str(t.title, `${tw}.title`), description: optStr(t.description, `${tw}.description`), points, refs: refs.length ? refs : undefined };
    });
    if (!stories.length) fail(w, 'sprint has no stories');
    return {
      key: str(s.key, `${w}.key`), name: str(s.name, `${w}.name`),
      dependsOn: arr(s.dependsOn, `${w}.dependsOn`).map((d, k) => str(d, `${w}.dependsOn[${k}]`)),
      parallel: s.parallel === true, stories,
    };
  });
  if (!sprints.length) fail('sprints', 'plan has no sprints');

  const keys = new Set<string>();
  for (const s of sprints) {
    if (keys.has(s.key)) fail('sprints', `duplicate key "${s.key}"`);
    keys.add(s.key);
  }
  for (const s of sprints) for (const d of s.dependsOn) {
    if (!keys.has(d)) fail(`sprint ${s.key}`, `depends on unknown sprint "${d}"`);
  }
  // Cycle check: a sprint that can never start would stall the epic forever.
  const byKey = new Map(sprints.map(s => [s.key, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string, trail: string[]) => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') fail('sprints', `dependency cycle ${[...trail, k].join(' → ')}`);
    state.set(k, 'visiting');
    for (const d of byKey.get(k)!.dependsOn) visit(d, [...trail, k]);
    state.set(k, 'done');
  };
  for (const s of sprints) visit(s.key, []);

  return {
    summary: str(p.summary, 'summary'),
    sprints,
    reuse: arr(p.reuse, 'reuse').map((r, i) => str(r, `reuse[${i}]`)),
    dependencies: arr(p.dependencies, 'dependencies').map((dv, i) => {
      const d = obj(dv, `dependencies[${i}]`);
      return { name: str(d.name, `dependencies[${i}].name`), available: d.available === true, note: optStr(d.note, `dependencies[${i}].note`) };
    }),
    affectedFiles: arr(p.affectedFiles, 'affectedFiles').map((f, i) => str(f, `affectedFiles[${i}]`)),
    security: arr(p.security, 'security').map((fv, i) => {
      const w = `security[${i}]`, f = obj(fv, w);
      const severity = SEVERITIES.includes(f.severity as Severity) ? f.severity as Severity : fail(`${w}.severity`, 'expected low|medium|high');
      const sprint = optStr(f.sprint, `${w}.sprint`);
      if (sprint && !keys.has(sprint)) fail(`${w}.sprint`, `unknown sprint "${sprint}"`);
      return { severity, sprint, story: optStr(f.story, `${w}.story`), finding: str(f.finding, `${w}.finding`) };
    }),
  };
}

export function validateVerdict(input: unknown): Verdict {
  const v = obj(input, 'verdict');
  if (typeof v.pass !== 'boolean') fail('pass', 'expected boolean');
  const risk = v.risk === 'critical' ? 'critical' : v.risk === 'minor' || v.risk === undefined ? 'minor' : fail('risk', 'expected minor|critical');
  const issues = arr(v.issues, 'issues').map((x, i) => str(x, `issues[${i}]`));
  if (!v.pass && !issues.length) fail('issues', 'a failing verdict must list issues');
  return { pass: v.pass as boolean, risk, issues };
}

// Human-readable plan shown at the approval gate (.lexcode/epics/<epicId>/plan.md).
export function renderPlanMd(title: string, p: Plan): string {
  const out = [`# Plan: ${title}`, '', p.summary, ''];
  const list = (h: string, xs: string[]) => { if (xs.length) out.push(`## ${h}`, '', ...xs.map(x => `- ${x}`), ''); };
  for (const s of p.sprints) {
    const meta = [s.parallel ? 'parallel-safe' : 'sequential', s.dependsOn.length ? `after ${s.dependsOn.join(', ')}` : ''].filter(Boolean).join(' · ');
    out.push(`## ${s.key}: ${s.name}`, '', `_${meta}_`, '');
    for (const t of s.stories) {
      out.push(`- [ ] ${t.title}${t.points !== undefined ? ` (${t.points} pts)` : ''}`);
      if (t.description) out.push(`  ${t.description.replace(/\n/g, '\n  ')}`);
      if (t.refs) out.push(`  refs: ${t.refs.join(', ')}`);
    }
    out.push('');
  }
  list('Reuse', p.reuse);
  list('Dependencies', p.dependencies.map(d => `${d.available ? '✅' : '❌'} ${d.name}${d.note ? ` (${d.note})` : ''}`));
  list('Affected files', p.affectedFiles);
  list('Security findings', p.security.map(f => `**${f.severity}**${f.sprint ? ` [${f.sprint}]` : ''}${f.story ? ` ${f.story}:` : ''} ${f.finding}`));
  return out.join('\n');
}
