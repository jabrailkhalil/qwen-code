const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(process.argv[2] || process.cwd());
const modulePath = path.resolve(process.argv[3] || path.join(__dirname, 'prompt.cjs'));
const mode = process.argv[4] || 'source-script-fallback';
const output = path.resolve(process.argv[5] || path.join(__dirname, 'baseline'));
fs.mkdirSync(output, { recursive: true });
const loaded = require(modulePath);
const { buildManagedAutoMemoryPrompt } = loaded;
assert.equal(typeof buildManagedAutoMemoryPrompt, 'function');
const makeLines = (count, length) => Array.from({ length: count }, (_, i) => {
  const prefix = `- [Topic ${i}](project/topic-${i}.md) — `;
  assert(prefix.length <= length);
  return prefix + 'h'.repeat(length - prefix.length);
});
const arms = [
  { name: 'character-only-original', lines: makeLines(170, 150) },
  { name: 'character-only-shorter-descriptions', lines: makeLines(170, 140) },
  { name: 'line-only-original', lines: makeLines(201, 80) },
  { name: 'line-only-shorter-descriptions', lines: makeLines(201, 60) },
  { name: 'both-original', lines: makeLines(201, 150) },
  { name: 'both-shorter-descriptions', lines: makeLines(201, 80) },
  { name: 'overlong-original', lines: [`- [Long](reference/${'x'.repeat(25000)}.md)`] },
  { name: 'overlong-shorter-path', lines: ['- [Long](reference/short.md)'] },
];
const observations = [];
for (const arm of arms) {
  const fixtureRoot = path.join(output, arm.name);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const memory = path.join(fixtureRoot, 'MEMORY.md');
  fs.writeFileSync(memory, arm.lines.join('\n'));
  const input = fs.readFileSync(memory, 'utf8');
  const rendered = buildManagedAutoMemoryPrompt(fixtureRoot, input);
  fs.writeFileSync(path.join(fixtureRoot, 'rendered-prompt.txt'), rendered);
  const warning = rendered.split('\n').find(line => line.startsWith('> WARNING: MEMORY.md')) || '';
  const observation = {
    name: arm.name,
    lines: arm.lines.length,
    chars: input.length,
    longestLine: Math.max(...arm.lines.map(line => line.length)),
    warning,
    hasReaderWarning: rendered.includes('Only part of it was loaded.'),
    rejectsShortening: warning.includes('shortening entries cannot help'),
    falseLengthCause: warning.includes('index entries are too long'),
  };
  observations.push(observation);
}
const byName = Object.fromEntries(observations.map(item => [item.name, item]));
const checks = [];
const check = (name, test) => {
  try { test(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
};
check('170 ordinary entries overflow only characters', () => {
  const arm = byName['character-only-original'];
  assert.equal(arm.lines, 170);
  assert.equal(arm.longestLine, 150);
  assert.equal(arm.chars, 25669);
  assert(arm.hasReaderWarning);
});
check('shortening descriptions alone clears character-only warning', () => {
  const arm = byName['character-only-shorter-descriptions'];
  assert.equal(arm.lines, 170);
  assert.equal(arm.chars, 23969);
  assert(!arm.hasReaderWarning);
});
check('character-only warning must not claim shortening cannot help', () => {
  assert(!byName['character-only-original'].rejectsShortening);
});
check('ordinary entries must not be blamed for violating their per-line bound', () => {
  assert(!byName['character-only-original'].falseLengthCause);
});
check('shortening cannot clear line-only overflow', () => {
  assert(byName['line-only-original'].hasReaderWarning);
  assert(byName['line-only-shorter-descriptions'].hasReaderWarning);
});
check('shortening cannot clear combined overflow until line count falls', () => {
  assert(byName['both-original'].hasReaderWarning);
  assert(byName['both-shorter-descriptions'].hasReaderWarning);
});
check('a protected huge path is not offered description shortening and a shorter path fits', () => {
  assert(byName['overlong-original'].hasReaderWarning);
  assert(!byName['overlong-original'].falseLengthCause);
  assert(byName['overlong-original'].warning.includes('Prune or merge entries to fit the character budget.'));
  assert(!byName['overlong-shorter-path'].hasReaderWarning);
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  mode,
  repo,
  head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  platform: process.platform,
  sourceSha256: sha256(fs.readFileSync(path.join(repo, 'packages/core/src/memory/prompt.ts'))),
  modulePath,
  moduleSha256: sha256(fs.readFileSync(modulePath)),
  observations,
  checks,
  passed: checks.filter(item => item.passed).length,
  failed: checks.filter(item => !item.passed).length,
};
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
