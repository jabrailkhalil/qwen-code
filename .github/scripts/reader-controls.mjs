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
const fixedMemory = JSON.parse(fs.readFileSync(path.join(evidence, 'fixed-memory.json'), 'utf8'));
const prompt = fixedMemory.testResults.find(test => test.name.endsWith('/src/memory/prompt.test.ts'));
assert.equal(prompt.assertionResults.length, 53);
assert(prompt.assertionResults.every(test => test.status === 'passed'));
const cases = [];
function run(name, contents, expectedFailures, expectedName) {
  fs.writeFileSync(source, contents);
  const output = path.join(evidence, `${name}.json`);
  const result = spawnSync(process.execPath, [
    '../../node_modules/vitest/vitest.mjs', 'run', 'src/memory/prompt.test.ts',
    '--coverage.enabled=false', '--maxWorkers=2', '--minWorkers=1',
    '--reporter=json', '--outputFile=' + output,
  ], { cwd: path.join(repo, 'packages/core'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.status, 1, 'Negative control must fail test assertions');
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.numFailedTests, expectedFailures);
  assert.equal(report.numPassedTests, 53 - expectedFailures);
  assert.equal(report.numPendingTests, 0);
  const failures = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed');
  assert.equal(failures.length, expectedFailures);
  if (expectedName) assert(failures.some(test => test.fullName.includes(expectedName)));
  cases.push({ name, passed: report.numPassedTests, failed: report.numFailedTests, failures: failures.map(test => test.fullName) });
}
try {
  const baseline = execFileSync('git', ['show', process.env.BASE_SHA + ':' + relative]);
  run('original-source-control', baseline, 4, '170 entries of 150 units');
  const mutant = original.toString().replace(
    /const overlongEntriesCauseOverflow =\s*candidateCharCount > MAX_INDEX_CHARS &&\s*ordinaryCharCount <= MAX_INDEX_CHARS;/,
    'const overlongEntriesCauseOverflow = false;',
  );
  assert.notEqual(mutant, original.toString());
  run('disabled-length-cause-control', mutant, 1, 'keeps blaming entry length');
} finally {
  fs.writeFileSync(source, original);
}
assert(fs.readFileSync(source).equals(original));
const receipt = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), cases, restoredSha256: createHash('sha256').update(original).digest('hex') };
fs.writeFileSync(path.join(evidence, 'control-summary.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
