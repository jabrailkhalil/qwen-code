import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const target = 'be322861cadd08d6b485e6de7e189e2cb68497aa';
const sourcePath = 'packages/cli/src/commands/review/test-efficacy.ts';
const results = '/tmp/review-probe-6828-final-unit';
const require = createRequire(join(process.cwd(), 'package.json'));
const pkgPath = require.resolve('vitest/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = join(dirname(pkgPath), pkg.bin.vitest);
const original = readFileSync(sourcePath, 'utf8');
assert.equal(original, execFileSync('git', ['show', target + ':' + sourcePath], { encoding: 'utf8' }));
const classifyStart = original.indexOf('export function classifyProbeRun(');
const matchStart = original.indexOf('    const probe =', classifyStart);
const matchEnd = original.indexOf('    const assertions = ', matchStart);
assert(classifyStart >= 0 && matchStart > classifyStart && matchEnd > matchStart);
const match = original.slice(matchStart, matchEnd);
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, 'mutation must match exactly once');
  return text.replace(from, to);
};
const patched = (part) => original.slice(0, matchStart) + part + original.slice(matchEnd);
const caseFold = replaceOnce(replaceOnce(match,
  ': file;', ': file.toLowerCase();'), ': raw;', ': raw.toLowerCase();');
const separators = replaceOnce(replaceOnce(match,
  ': file;', ": file.replaceAll(String.fromCharCode(92), '/');"),
  ': raw;', ": raw.replaceAll(String.fromCharCode(92), '/');");
const suffix = replaceOnce(match, 'name.endsWith(`/${probe}`)', 'name.endsWith(probe)');
const variants = [
  ['posix-case-fold', patched(caseFold), 'keeps POSIX matching case-sensitive'],
  ['posix-backslash-separator', patched(separators), 'does not treat a POSIX backslash filename as a path separator'],
  ['missing-suffix-boundary', patched(suffix), 'suffix collision'],
];
const summary = [];
mkdirSync(results, { recursive: true });
try {
  for (const [name, text, expectedFailure] of variants) {
    const dir = join(results, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(sourcePath, text);
    const run = spawnSync(process.execPath, [bin, 'run',
      'src/commands/review/test-efficacy.test.ts', '--reporter=json',
      '--outputFile', join(dir, 'tests.json')], {
      cwd: resolve('packages/cli'), encoding: 'utf8', timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(join(dir, 'stdout.log'), run.stdout ?? '');
    writeFileSync(join(dir, 'stderr.log'), run.stderr ?? '');
    assert.equal(run.error, undefined, name + ' must start');
    assert.equal(run.signal, null, name + ' must exit naturally');
    assert.equal(run.status, 1, name + ' must fail');
    const report = JSON.parse(readFileSync(join(dir, 'tests.json'), 'utf8'));
    const failures = report.testResults.flatMap((file) => file.assertionResults)
      .filter((test) => test.status === 'failed');
    assert(failures.some((test) => test.fullName.includes(expectedFailure)), name + ' must fail its path guard assertion');
    assert(failures.every((test) => test.failureMessages.some((m) => /^AssertionError(?::| \[)/.test(m))),
      name + ' must not fail only because of setup/runtime');
    summary.push({ name, exitCode: run.status, passed: report.numPassedTests,
      failed: report.numFailedTests, total: report.numTotalTests,
      failingTests: failures.map((test) => test.fullName) });
    process.stdout.write(JSON.stringify(summary.at(-1)) + '\n');
  }
} finally {
  writeFileSync(sourcePath, original);
  writeFileSync(join(results, 'path-mutation-summary.json'), JSON.stringify(summary, null, 2));
}
execFileSync('git', ['diff', '--exit-code', target, '--', sourcePath], { stdio: 'inherit' });
