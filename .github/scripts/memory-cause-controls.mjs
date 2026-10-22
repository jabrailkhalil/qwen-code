/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const filename = 'packages/core/src/memory/indexer.ts';
const original = fs.readFileSync(filename, 'utf8');
const predicate = 'charCount > MAX_INDEX_CHARS && ordinaryCharCount <= MAX_INDEX_CHARS';
assert.equal(original.split(predicate).length - 1, 1);
const records = [];
const testPattern = 'keeps count advice when a dropped overlong candidate|names paths and frontmatter';

function negative(label, failed, passed) {
  const reportFile = path.join(evidence, label + '.json');
  const result = spawnSync('corepack', [
    'pnpm', 'exec', 'vitest', 'run', 'src/memory/index-drop-notice.test.ts',
    '--coverage.enabled=false', '--maxWorkers=2', '--minWorkers=1', '-t', testPattern,
    '--reporter=default', '--reporter=json', '--outputFile.json=' + reportFile,
  ], { cwd: path.join(root, 'packages/core'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  assert.ifError(result.error);
  assert.notEqual(result.status, null);
  assert.notEqual(result.status, 0, 'negative control must fail');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, 'no setup/runtime failure');
  const tests = report.testResults.flatMap((suite) => suite.assertionResults);
  const failures = tests.filter((test) => test.status === 'failed');
  assert.equal(failures.length, failed);
  assert.equal(tests.filter((test) => test.status === 'passed').length, passed);
  assert(failures.every((test) => test.failureMessages.some((message) => /AssertionError|Error: expect/.test(message))));
  const record = { label, exit: result.status, failed, passed, failures: failures.map((test) => test.fullName) };
  records.push(record);
  console.log(JSON.stringify(record));
}

try {
  const restored = spawnSync('git', ['restore', '--source=5f93cd5dcba82673f5e08421adeda62cdc6d0288', '--worktree', '--', filename], { encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  try { negative('r2-previous-source', 2, 1); }
  finally { fs.writeFileSync(filename, original); }

  fs.writeFileSync(filename, original.replace(predicate, 'candidates.some((line) => line.length > MAX_INDEX_LINE_CHARS)'));
  try { negative('r2-noncausal-length-mutant', 2, 1); }
  finally { fs.writeFileSync(filename, original); }

  fs.writeFileSync(filename, original.replace(predicate, 'false'));
  try { negative('r2-discarded-huge-control-mutant', 1, 2); }
  finally { fs.writeFileSync(filename, original); }
} finally {
  fs.writeFileSync(filename, original);
  fs.writeFileSync(path.join(evidence, 'r2-control-summary.json'), JSON.stringify(records, null, 2));
}
