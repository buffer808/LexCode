import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverAgents, discoverSkills, frontmatter, mapRoles, resolveRoles, bundledRolePrompt, ROLES } from '../agents';

const agentFile = (dir: string, file: string, fm: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\nbody`);
};

test('frontmatter parses flat keys and strips quotes', () => {
  assert.deepEqual(frontmatter('---\nname: x\ndescription: "Does: things"\nmodel: opus\n---\nhi'), { name: 'x', description: 'Does: things', model: 'opus' });
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('discovers project + user agents, project shadows user, keyword + explicit mapping', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const pa = path.join(proj, '.claude', 'agents'), ua = path.join(home, '.claude', 'agents');
  agentFile(pa, 'tech-lead.md', 'name: tech-lead\ndescription: plans work\nmodel: opus');
  agentFile(pa, 'qa-engineer.md', 'name: qa-engineer\ndescription: tests');
  agentFile(pa, 'db-expert.md', 'description: databases'); // name from file
  agentFile(ua, 'qa-engineer.md', 'name: qa-engineer\ndescription: user copy');
  agentFile(ua, 'backend-developer.md', 'name: backend-developer\ndescription: builds');

  const agents = discoverAgents(proj, home);
  assert.deepEqual(agents.map(a => [a.name, a.scope]),
    [['db-expert', 'project'], ['qa-engineer', 'project'], ['tech-lead', 'project'], ['backend-developer', 'user']]);
  assert.equal(agents.find(a => a.name === 'tech-lead')!.model, 'opus');

  // tech-lead → orchestrator (lead), qa-engineer → reviewer (qa beats engineer), backend-developer → builder.
  assert.deepEqual(resolveRoles(proj, home).roles, { orchestrator: 'tech-lead', reviewer: 'qa-engineer', builder: 'backend-developer' });

  // Explicit config wins; an explicit name that doesn't exist is ignored.
  fs.mkdirSync(path.join(proj, '.lexcode'));
  fs.writeFileSync(path.join(proj, '.lexcode', 'factory.json'), JSON.stringify({ roles: { revalidator: 'db-expert', security: 'ghost', bogus: 'x' } }));
  assert.deepEqual(resolveRoles(proj, home).roles,
    { revalidator: 'db-expert', orchestrator: 'tech-lead', reviewer: 'qa-engineer', builder: 'backend-developer' });

  fs.writeFileSync(path.join(proj, '.lexcode', 'factory.json'), '{bad');
  assert.throws(() => resolveRoles(proj, home), /factory\.json/);
});

test('one agent claims one role; no agents → nothing mapped', () => {
  const a = (name: string) => ({ name, description: '', scope: 'project' as const, file: '' });
  assert.deepEqual(mapRoles([a('lead-reviewer'), a('reviewer-2')]), { orchestrator: 'lead-reviewer', reviewer: 'reviewer-2' });
  assert.deepEqual(mapRoles([]), {});
});

test('bundled role prompts exist for every role', () => {
  const dir = path.join(__dirname, '..', '..', 'agents');
  for (const r of ROLES) assert.ok(bundledRolePrompt(dir, r).length > 100 && !bundledRolePrompt(dir, r).startsWith('---'), r);
});

test('discoverSkills: project + user skills and commands, deduped', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-sk-')), home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const put = (f: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '---\nname: x\n---\n'); };
  put(path.join(proj, '.claude/skills/git-release/SKILL.md'));
  fs.mkdirSync(path.join(proj, '.claude/skills/empty'), { recursive: true }); // no SKILL.md: not a skill
  put(path.join(proj, '.claude/commands/release.md'));
  put(path.join(home, '.claude/skills/git-release/SKILL.md'));
  put(path.join(home, '.claude/commands/ship.md'));
  assert.deepEqual(discoverSkills(proj, home), ['git-release', 'release', 'ship']);
  assert.deepEqual(discoverSkills(path.join(proj, 'nope'), path.join(home, 'nope')), []);
});
