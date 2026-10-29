/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyProbeRun, findVitestBin } from './test-efficacy.js';

const cases = [
  {
    name: 'beforeEach assertion',
    file: 'before-each-assertion.test.js',
    body: "import { beforeEach, it, expect } from 'vitest'; beforeEach(() => expect(1).toBe(2)); it('body passes', () => expect(1).toBe(1));",
    verdict: 'gated',
  },
  {
    name: 'afterEach assertion',
    file: 'after-each-assertion.test.js',
    body: "import { afterEach, it, expect } from 'vitest'; afterEach(() => expect(1).toBe(2)); it('body passes', () => expect(1).toBe(1));",
    verdict: 'gated',
  },
  {
    name: 'Node assertion',
    file: 'node-assertion.test.js',
    body: "import { it } from 'vitest'; import assert from 'node:assert/strict'; it('fails an assertion', () => assert.equal(1, 2));",
    verdict: 'gated',
  },
] as const;

describe('classifyProbeRun with real hook and Node assertion controls', () => {
  let root: string;
  let stdout: string;
  let exitCode: number;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-probe-reporter-'));
    const vitestBin = findVitestBin(process.cwd());
    const modules = dirname(dirname(vitestBin));
    symlinkSync(modules, join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['*.test.js'], environment: 'node', pool: 'forks', maxWorkers: 1, minWorkers: 1, fileParallelism: false } };\n",
    );
    for (const entry of cases) {
      writeFileSync(join(root, entry.file), entry.body);
    }
    const report = join(root, 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        vitestBin,
        'run',
        '--config',
        join(root, 'vitest.config.mjs'),
        '--reporter=json',
        '--outputFile',
        report,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    stdout = readFileSync(report, 'utf8');
    exitCode = run.status ?? -1;
    const parsed = JSON.parse(stdout) as { testResults: unknown[] };
    expect(parsed.testResults).toHaveLength(cases.length);
    const evidenceDir = process.env['QWEN_PROBE_REPORT_DIR'];
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'real-vitest-hook-controls.json'), stdout);
      writeFileSync(join(evidenceDir, 'fixture-hook-controls.stderr'), run.stderr);
    }
  }, 40_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(cases)('$name is $verdict', ({ file, verdict }) => {
    const actual = classifyProbeRun(exitCode, stdout, [file]);
    expect(actual).toHaveLength(1);
    expect(actual[0].verdict).toBe(verdict);
  });
});
