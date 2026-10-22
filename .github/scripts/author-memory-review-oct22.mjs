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
const files = [
  'packages/core/src/memory/indexer.ts',
  'packages/core/src/memory/prompt.ts',
  'packages/core/src/memory/structured-scan.ts',
];
const originals = new Map(
  files.map((file) => [file, fs.readFileSync(file, 'utf8')]),
);
const summaries = [];
function restore() {
  for (const [file, content] of originals) fs.writeFileSync(file, content);
}
function replaceOnce(file, before, after) {
  const content = originals.get(file);
  assert.equal(content.split(before).length - 1, 1, `unique mutation: ${file}`);
  fs.writeFileSync(file, content.replace(before, after));
}
function expectAssertions(
  label,
  testFile,
  pattern,
  failed,
  passed,
  assertionPattern = /AssertionError|Error: expect/,
) {
  const reportFile = path.join(evidence, `${label}.json`);
  const run = spawnSync(
    'corepack',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      testFile,
      '--coverage.enabled=false',
      '--maxWorkers=2',
      '--minWorkers=1',
      '-t',
      pattern,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportFile}`,
    ],
    {
      cwd: path.join(root, 'packages/core'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(evidence, `${label}.log`),
    `${run.stdout ?? ''}${run.stderr ?? ''}`,
  );
  assert.ifError(run.error);
  assert.notEqual(run.status, null);
  assert.notEqual(run.status, 0, `${label}: negative control must fail`);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const assertions = report.testResults.flatMap(
    (suite) => suite.assertionResults,
  );
  const completed = assertions.filter(
    (test) => test.status === 'passed' || test.status === 'failed',
  );
  const failures = completed.filter((test) => test.status === 'failed');
  assert.equal(
    report.numRuntimeErrorTestSuites ?? 0,
    0,
    `${label}: no setup error`,
  );
  assert.equal(failures.length, failed, `${label}: expected failed assertions`);
  assert.equal(
    completed.filter((test) => test.status === 'passed').length,
    passed,
  );
  assert(
    failures.every((test) =>
      test.failureMessages.some((message) => assertionPattern.test(message)),
    ),
  );
  const summary = {
    label,
    exit: run.status,
    failed,
    passed,
    failures: failures.map((test) => test.fullName),
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}

try {
  const baseline = spawnSync(
    'git',
    [
      'restore',
      '--source=d115d1efaa86602a7e8f6e14905c964674ab8ea9',
      '--worktree',
      '--',
      ...files,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(baseline.status, 0, baseline.stderr);
  try {
    expectAssertions(
      'previous-head',
      'src/memory/index-drop-notice.test.ts',
      'review follow-up diagnostics',
      10,
      5,
    );
  } finally {
    restore();
  }

  const mutations = [
    {
      label: 'bidi-strip',
      file: files[0],
      before: String.raw`.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')`,
      after: '',
      test: 'src/memory/index-drop-notice.test.ts',
      pattern: 'sanitizes a short omitted title',
      failed: 1,
      passed: 1,
    },
    {
      label: 'backtick-defang',
      file: files[0],
      before: '.replace(/`/g, "\'")',
      after: '',
      test: 'src/memory/index-drop-notice.test.ts',
      pattern: 'sanitizes a short omitted title',
      failed: 1,
      passed: 1,
    },
    {
      label: 'single-paragraph-guard',
      file: files[1],
      before: "    !trimmed.slice(noticeStart + 2).includes('\\n');",
      after: '    true;',
      test: 'src/memory/index-drop-notice.test.ts',
      pattern: 'budgets a short multiline tail',
      failed: 2,
      passed: 0,
    },
    {
      label: 'writer-notice-retention',
      file: files[1],
      before: 'return `${content}${writerNotice}\\n\\n> WARNING:',
      after: 'return `${content}\\n\\n> WARNING:',
      test: 'src/memory/index-drop-notice.test.ts',
      pattern: 'retains the bounded writer notice',
      failed: 1,
      passed: 0,
    },
    {
      label: 'team-root-symlink',
      file: files[2],
      before: "followRootSymlink: scope === 'user',",
      after: "followRootSymlink: scope === 'user' || scope === 'team',",
      test: 'src/memory/structured-scan.test.ts',
      pattern: 'refuses a symlinked team memory root',
      failed: 1,
      passed: 0,
      assertionPattern:
        /^Error: promise resolved "[^\n]*" instead of rejecting\n\s+at Assertion\.__VITEST_REJECTS__[\s\S]*\/src\/memory\/structured-scan\.test\.ts:807:5(?:\n|$)/,
    },
  ];
  for (const mutation of mutations) {
    try {
      replaceOnce(mutation.file, mutation.before, mutation.after);
      expectAssertions(
        mutation.label,
        mutation.test,
        mutation.pattern,
        mutation.failed,
        mutation.passed,
        mutation.assertionPattern,
      );
    } finally {
      restore();
    }
  }
} finally {
  restore();
  fs.writeFileSync(
    path.join(evidence, 'control-summary.json'),
    JSON.stringify(summaries, null, 2),
  );
}
