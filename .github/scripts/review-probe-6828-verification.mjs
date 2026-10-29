import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const results = '/tmp/review-probe-6828-verify';
const sourcePath = 'packages/cli/src/commands/review/test-efficacy.ts';
const target = '7d13a061cf08bf8dc69d67ec9561b2c0eb9df6fe';
const base = '4dc63d0023749b4546696a9c16cf26b68dd86673';
const require = createRequire(join(root, 'package.json'));
const pkgPath = require.resolve('vitest/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const vitestBin = join(dirname(pkgPath), pkg.bin.vitest);
mkdirSync(results, { recursive: true });
writeFileSync(join(results, 'vitest-package.json'), readFileSync(pkgPath));
for (const file of readdirSync(join(dirname(pkgPath), 'dist/chunks'))) {
  if (!file.endsWith('.js')) continue;
  const text = readFileSync(join(dirname(pkgPath), 'dist/chunks', file), 'utf8');
  if (text.includes('class JsonReporter')) {
    writeFileSync(join(results, 'installed-json-reporter-' + file), text);
  }
}

const original = readFileSync(sourcePath, 'utf8');
assert.equal(
  original,
  execFileSync('git', ['show', target + ':' + sourcePath], { encoding: 'utf8' }),
);
const oldSource = execFileSync('git', ['show', base + ':' + sourcePath], {
  encoding: 'utf8',
});
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length, 2, 'mutation must match exactly once');
  return text.replace(from, to);
};
const witnessStart = original.indexOf('    const assertionFailures = failed.filter(');
const witnessEnd = original.indexOf('    const passed = ', witnessStart);
assert(witnessStart >= 0 && witnessEnd > witnessStart);
const unchecked = original.slice(0, witnessStart) +
  '    const assertionFailures = failed.length;\n' + original.slice(witnessEnd);
const variants = [
  ['exact-base', oldSource],
  ['no-assertion-witness', unchecked],
  ['ignore-failed-file', replaceOnce(original,
    "failed.length > 0 || result.status === 'failed'", 'failed.length > 0')],
  ['ignore-failed-task', replaceOnce(original,
    "failed.length > 0 || result.status === 'failed'", "result.status === 'failed'")],
  ['unanchored-assertion-name', replaceOnce(original,
    '/^AssertionError(?::| \\[)/.test(message)', '/AssertionError(?::| \\[)/.test(message)')],
];
const summary = [];
try {
  for (const [name, text] of variants) {
    const dir = join(results, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(sourcePath, text);
    const run = spawnSync(process.execPath, [
      vitestBin, 'run',
      'src/commands/review/test-efficacy.test.ts',
      'src/commands/review/test-efficacy.reporter.test.ts',
      '--reporter=json', '--outputFile', join(dir, 'tests.json'),
    ], {
      cwd: resolve('packages/cli'),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, QWEN_PROBE_REPORT_DIR: dir },
    });
    writeFileSync(join(dir, 'stdout.log'), run.stdout ?? '');
    writeFileSync(join(dir, 'stderr.log'), run.stderr ?? '');
    assert.equal(run.error, undefined, name + ' must start');
    assert.equal(run.signal, null, name + ' must exit naturally');
    assert.equal(run.status, 1, name + ' must fail');
    const report = JSON.parse(readFileSync(join(dir, 'tests.json'), 'utf8'));
    assert(report.numTotalTests >= 8, name + ' must collect tests');
    const failed = report.testResults.flatMap((file) => file.assertionResults)
      .filter((test) => test.status === 'failed');
    assert(failed.length > 0, name + ' must fail an outer assertion');
    assert(failed.every((test) => test.failureMessages.some((m) => /^AssertionError(?::| \[)/.test(m))),
      name + ' must not be accepted for a setup/runtime failure');
    if (name === 'exact-base') {
      for (const phrase of ['beforeEach error', 'afterAll error', 'test runtime error', 'test timeout']) {
        assert(failed.some((test) => test.fullName.includes(phrase)), phrase + ' must fail on exact base');
      }
    }
    summary.push({ name, exitCode: run.status, passed: report.numPassedTests,
      failed: report.numFailedTests, total: report.numTotalTests,
      failingTests: failed.map((test) => test.fullName) });
    process.stdout.write(JSON.stringify(summary.at(-1)) + '\n');
  }
} finally {
  writeFileSync(sourcePath, original);
  writeFileSync(join(results, 'mutation-summary.json'), JSON.stringify(summary, null, 2));
}
execFileSync('git', ['diff', '--exit-code', target, '--', sourcePath], { stdio: 'inherit' });
