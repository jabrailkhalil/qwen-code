import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const evidence = process.env.EVIDENCE_DIR;
assert(evidence);
const relative = 'packages/core/src/memory/prompt.ts';
const source = path.join(repo, relative);
const original = fs.readFileSync(source);
const full = JSON.parse(fs.readFileSync(path.join(evidence, 'fixed-memory.json'), 'utf8'));
assert.equal(full.numFailedTests, 0);
const prompt = full.testResults.find(test => test.name.endsWith('/src/memory/prompt.test.ts'));
assert.equal(prompt.assertionResults.length, 83);
assert(prompt.assertionResults.every(test => test.status === 'passed'));
const cases = [];
function run(name, contents, selector, expectedTests, expectFailure) {
  fs.writeFileSync(source, contents);
  const output = path.join(evidence, `${name}.json`);
  const result = spawnSync(process.execPath, [
    '../../node_modules/vitest/vitest.mjs', 'run', 'src/memory/prompt.test.ts',
    '--coverage.enabled=false', '--maxWorkers=1', '--minWorkers=1',
    '-t', selector, '--reporter=json', '--outputFile=' + output,
  ], { cwd: path.join(repo, 'packages/core'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.status, expectFailure ? 1 : 0);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const assertions = report.testResults.flatMap(file => file.assertionResults);
  const executed = assertions.filter(test => test.status !== 'pending' && test.status !== 'skipped');
  assert.equal(executed.length, expectedTests);
  assert.equal(report.numFailedTests, expectFailure ? expectedTests : 0);
  assert.equal(report.numPassedTests, expectFailure ? 0 : expectedTests);
  if (expectFailure) {
    assert(executed.every(test => test.status === 'failed'));
    assert(executed.every(test => test.failureMessages.every(message => message.includes('AssertionError'))));
  }
  cases.push({ name, passed: report.numPassedTests, failed: report.numFailedTests,
    selected: executed.map(test => test.fullName) });
}
try {
  const baseline = execFileSync('git', ['show', process.env.BASE_SHA + ':' + relative]);
  const advice = 'offers effective character-budget advice';
  run('original-source-control', baseline, advice, 2, true);
  run('fixed-advice-control', original, advice, 2, false);
  const mutant = original.toString().replace(
    /const overlongEntriesCauseOverflow =\s*allOverlongEntriesShortenable &&\s*candidateCharCount > MAX_INDEX_CHARS &&\s*ordinaryCharCount <= MAX_INDEX_CHARS;/,
    'const overlongEntriesCauseOverflow = false;',
  );
  assert.notEqual(mutant, original.toString());
  const length = 'keeps length advice (when a removable description causes the overflow|ahead of line-count advice when both budgets overflow)';
  run('disabled-length-cause-control', mutant, length, 2, true);
  run('restored-length-control', original, length, 2, false);
} finally {
  fs.writeFileSync(source, original);
}
assert(fs.readFileSync(source).equals(original));
const receipt = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baseline: process.env.BASE_SHA, cases,
  restoredSha256: createHash('sha256').update(original).digest('hex') };
fs.writeFileSync(path.join(evidence, 'control-summary.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
