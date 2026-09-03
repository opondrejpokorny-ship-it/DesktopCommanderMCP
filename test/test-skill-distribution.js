import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const names = (p) => fs.readdirSync(path.join(root, p))
  .filter((name) => fs.existsSync(path.join(root, p, name, 'SKILL.md')))
  .sort();

const canonical = names('skills');
assert.deepEqual(names('plugins/claude/skills'), canonical, 'Claude plugin skill set must match canonical skills/');
assert.deepEqual(names('plugins/cursor/skills'), canonical, 'Cursor plugin skill set must match canonical skills/');

for (const manifestPath of ['plugins/claude/.claude-plugin/plugin.json', 'plugins/cursor/.cursor-plugin/plugin.json']) {
  const manifest = JSON.parse(read(manifestPath));
  assert.equal(manifest.skills, './skills/', `${manifestPath} must discover ./skills/`);
}

for (const skill of canonical) {
  const body = read(`skills/${skill}/SKILL.md`);
  assert.match(body, new RegExp(`^---[\\s\\S]*?name:\\s*${skill}\\s*$[\\s\\S]*?description:`, 'm'), `${skill} frontmatter must have matching name + description`);
  assert.equal(read(`plugins/claude/skills/${skill}/SKILL.md`), body, `Claude copy drifted for ${skill}`);
  if (skill === 'software-project-workflow') {
    assert.equal(read(`plugins/cursor/skills/${skill}/SKILL.md`), body, `Cursor copy drifted for ${skill}`);
  }
  for (const readme of ['plugins/claude/README.md', 'plugins/cursor/README.md']) {
    assert.ok(read(readme).includes(`\`${skill}\``), `${readme} must document ${skill}`);
  }
}
console.log(`PASS: ${canonical.length} canonical skills are packaged and documented consistently`);
