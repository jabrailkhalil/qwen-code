/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Portable built-output check. Example after the normal repository build:
// node verify-qwen-memory-r2-1.mjs --repo /checkout --out /artifacts/r2-1
// --mode source-fallback --module /path/indexer.cjs labels an isolated source
// probe explicitly; it never constitutes built-output verification.
const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert(args[i]?.startsWith('--') && args[i + 1], `Invalid option: ${args[i]}`);
  options.set(args[i].slice(2), args[i + 1]);
}
const repo = path.resolve(options.get('repo') ?? process.cwd());
const mode = options.get('mode') ?? 'built';
assert(['built', 'source-fallback'].includes(mode), `Unknown mode: ${mode}`);
const builtModule = path.join(repo, 'packages/core/dist/src/memory/indexer.js');
const modulePath = path.resolve(options.get('module') ?? builtModule);
assert(mode !== 'built' || modulePath === builtModule, 'Built mode must import the repository dist indexer.js');
const outputRoot = path.resolve(options.get('out') ?? path.join(repo, '.qwen/e2e-tests/memory-r2-1-fixed'));
await mkdir(outputRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(outputRoot, 'run-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...gitArgs) => execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' }).trim();
const sourcePath = path.join(repo, 'packages/core/src/memory/indexer.ts');
const identity = {
  repo,
  head: git('rev-parse', 'HEAD'),
  trackedStatus: git('status', '--short', '--untracked-files=no'),
  indexerSourceSha256: hash(await readFile(sourcePath)),
  indexerModule: modulePath,
  indexerModuleSha256: hash(await readFile(modulePath)),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  mode,
};
if (options.has('expected-head')) assert.equal(identity.head, options.get('expected-head'));
const loaded = await import(pathToFileURL(modulePath).href);
const buildManagedAutoMemoryIndex = loaded.buildManagedAutoMemoryIndex ?? loaded.default?.buildManagedAutoMemoryIndex;
const rebuildAutoMemoryIndexAtRoot = loaded.rebuildAutoMemoryIndexAtRoot ?? loaded.default?.rebuildAutoMemoryIndexAtRoot;
assert.equal(typeof buildManagedAutoMemoryIndex, 'function');
assert.equal(typeof rebuildAutoMemoryIndexAtRoot, 'function');
const checks = [];
const check = (name, callback) => {
  try { callback(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
};
const noticeStart = '\n\n> WARNING: MEMORY.md is too large; only part of it was written.';
const entryLines = (index) => index.split('\n').filter((line) => line.startsWith('- ['));
const body = (index) => entryLines(index).join('\n');
const notice = (index) => index.slice(index.indexOf(noticeStart)).trimStart();
const doc = (index) => {
  const id = String(index).padStart(3, '0');
  return {
    scope: 'project', type: 'project', category: 'uncategorized',
    filePath: path.join(runRoot, `topic-${id}.md`),
    relativePath: `project/topic-${id}.md`, filename: `topic-${id}.md`,
    title: `Topic-${id}`, description: 'h'.repeat(200), keywords: [],
    usageScenarios: [], body: '', mtimeMs: index,
  };
};
const ordinary = Array.from({ length: 199 }, (_, i) => doc(199 - i));
const hidden = { ...doc(0), title: 'Hidden', relativePath: `reference/${' '.repeat(49)}xx.md` };
const extra = { ...doc(200), mtimeMs: -1 };
const arms = [
  { name: 'A-original', docs: [...ordinary, hidden] },
  { name: 'B-short-path', docs: [...ordinary, { ...hidden, relativePath: 'reference/hidden.md' }] },
  { name: 'C-short-title', docs: [...ordinary, { ...hidden, title: 'Short' }] },
  { name: 'D-201-docs', docs: [...ordinary, hidden, extra] },
];
const countAdvice = 'Merge topic files or remove obsolete ones to reduce the index.';
function checkCountDiagnosis(index, name) {
  check(`${name}: count cause`, () => assert(index.includes('too many index entries')));
  check(`${name}: no length cause`, () => assert(!index.includes('index entries are too long')));
  check(`${name}: count advice`, () => assert(index.includes(countAdvice)));
  check(`${name}: no length advice`, () => assert(!index.includes('Overlong entries already omit descriptions.')));
  check(`${name}: no path/name advice`, () => assert(!index.includes('Shorten their topic-file paths or frontmatter names')));
}
const observations = [];
for (const arm of arms) {
  arm.index = buildManagedAutoMemoryIndex(arm.docs);
  checkCountDiagnosis(arm.index, `builder ${arm.name}`);
  check(`${arm.name}: 165 retained entries`, () => assert.equal(entryLines(arm.index).length, 165));
  check(`${arm.name}: retained entries meet the line cap`, () => assert(entryLines(arm.index).every((line) => line.length === 150)));
  check(`${arm.name}: original retained body`, () => assert.equal(body(arm.index), body(arms[0].index)));
  check(`${arm.name}: bounded omitted-name sample`, () => assert(notice(arm.index).includes('"Topic-034", "Topic-033", "Topic-032"')));
  check(`${arm.name}: hidden candidate absent`, () => assert(!arm.index.includes('[Hidden]') && !notice(arm.index).includes('"Hidden"')));
  await writeFile(path.join(runRoot, `${arm.name}.builder.MEMORY.md`), arm.index);

  const fixture = path.join(runRoot, arm.name);
  for (const topic of arm.docs) {
    const filename = path.join(fixture, topic.relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, `---\nname: ${JSON.stringify(topic.title)}\ndescription: ${JSON.stringify(topic.description)}\ntype: project\ncategory: uncategorized\n---\nIndependent memory fixture.\n`);
    const when = new Date(1_600_000_000_000 + topic.mtimeMs * 1000);
    await utimes(filename, when, when);
  }
  // At 201 files the scanner returns 200 docs plus one scan omission, so the
  // persisted notice differs from the direct 201-entry builder's line-cap case.
  const expectedWritten = arm.docs.length === 201
    ? buildManagedAutoMemoryIndex(arm.docs.slice(0, 200), undefined, arm.docs.slice(200))
    : arm.index;
  const written = await rebuildAutoMemoryIndexAtRoot(fixture, 'project');
  const persisted = await readFile(path.join(fixture, 'MEMORY.md'), 'utf8');
  check(`${arm.name}: scan/rebuild result matches expected index`, () => assert.equal(written, expectedWritten));
  check(`${arm.name}: persisted index matches result`, () => assert.equal(persisted, written));
  checkCountDiagnosis(persisted, `persisted ${arm.name}`);
  const repeated = await rebuildAutoMemoryIndexAtRoot(fixture, 'project');
  check(`${arm.name}: repeated rebuild stable`, () => assert.equal(repeated, persisted));
  if (arm.docs.length === 201) {
    check(`${arm.name}: scan omission is reported`, () => assert(persisted.includes('Dropped 1 of 201 topic files: "Topic-200"')));
  }
  observations.push({
    arm: arm.name, docs: arm.docs.length, retainedEntries: entryLines(written).length,
    retainedBodyChars: body(written).length,
    retainedLineLengths: [...new Set(entryLines(written).map((line) => line.length))],
    builderNotice: notice(arm.index), persistedNotice: notice(persisted),
  });
}

const ordinaryIndex = buildManagedAutoMemoryIndex(ordinary);
check('ordinary candidates alone require character trimming', () => {
  assert.equal(ordinary.map((item) => buildManagedAutoMemoryIndex([item])).join('\n').length, 30_048);
  assert.equal(body(ordinaryIndex), body(arms[0].index));
});
const huge = { ...doc(0), relativePath: `reference/${'x'.repeat(25_003)}.md` };
const hugeIndex = buildManagedAutoMemoryIndex([huge, doc(1)]);
check('huge-path control: length cause preserved', () => assert(hugeIndex.includes('index entries are too long')));
check('huge-path control: length advice preserved', () => assert(hugeIndex.includes('Overlong entries already omit descriptions.')));
check('huge-path control: path/name lever preserved', () => assert(hugeIndex.includes('Shorten their topic-file paths or frontmatter names')));
check('huge-path control: discarded huge candidate named', () => assert(hugeIndex.includes('Dropped 1 of 2 entries: "Topic-000".')));
check('huge-path control: ordinary entry retained', () => assert.deepEqual(entryLines(hugeIndex), entryLines(buildManagedAutoMemoryIndex([doc(1)]))));
check('huge-path control: removing already-omitted description is inert', () => assert.equal(buildManagedAutoMemoryIndex([{ ...huge, description: '' }, doc(1)]), hugeIndex));
await writeFile(path.join(runRoot, 'E-huge-path.builder.MEMORY.md'), hugeIndex);
observations.push({ arm: 'E-huge-path', docs: 2, retainedEntries: entryLines(hugeIndex).length, builderNotice: notice(hugeIndex), filesystem: 'Not attempted: synthetic 25,003-character path exceeds filesystem path limits.' });
const sourceUnchanged = hash(await readFile(sourcePath)) === identity.indexerSourceSha256;
check('source file hash stable', () => assert(sourceUnchanged));
const passed = checks.every((item) => item.passed);
const report = {
  verdict: passed ? (mode === 'built' ? 'BUILT_OUTPUT_PASS' : 'SOURCE_FALLBACK_PASS') : 'CHECKS_FAILED',
  identity, runRoot, checksPassed: checks.filter((item) => item.passed).length,
  checksFailed: checks.filter((item) => !item.passed).length,
  checks, observations,
  limitations: ['No TUI or model call.', 'Huge-path control is builder-only because its synthetic path exceeds filesystem limits.', ...(mode === 'source-fallback' ? ['Source fallback is not built-output verification.'] : [])],
};
await writeFile(path.join(runRoot, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(path.join(outputRoot, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
