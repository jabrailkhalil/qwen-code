#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RESULTS"
production=packages/channels/feishu/src/FeishuAdapter.ts
testfile=packages/channels/feishu/src/adapter.test.ts
production_blob=408c1bf4dbf1daa35a8eaa1a9ccade7d929908ce
test_blob=db2476f1c6b0b48388c589ea4721051ac52b0880
target='removes a downloaded file immediately when stopped during preparation'

logged() {
  local label=$1 status
  shift
  set +e
  /usr/bin/time -v -o "$RESULTS/$label.time" "$@" > "$RESULTS/$label.log" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status" > "$RESULTS/$label.rc"
  tail -n 30 "$RESULTS/$label.log"
  return "$status"
}

inspect() {
  python3 - "$RESULTS" "$1" "$target" <<'PY'
import json
from pathlib import Path
import sys

root, mode, target = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
path = root / f'{mode}.json'
data = json.loads(path.read_text(encoding='utf-8'))
cases = [case for suite in data['testResults'] for case in suite['assertionResults']]
passed = [case for case in cases if case['status'] == 'passed']
failed = [case for case in cases if case['status'] == 'failed']
pending = [case for case in cases if case['status'] not in ['passed', 'failed']]
selected = [case for case in cases if case['title'] == target]
assert len(selected) == 1
if mode == 'cleanup-omitted':
    assert len(cases) == data['numTotalTests'] == 184
    assert len(failed) == data['numFailedTests'] == 1 and not passed
    assert len(pending) == data['numPendingTests'] == 183
    assert failed[0] is selected[0]
    message = '\n'.join(failed[0]['failureMessages'])
    assert 'AssertionError' in message and '[]' in message
    assert 'adapter.test.ts:1110' in message
else:
    assert len(cases) == data['numTotalTests'] == data['numPassedTests'] == 324
    assert not failed and not pending
    assert data['numFailedTests'] == data['numPendingTests'] == 0
    assert selected[0]['status'] == 'passed'
if 'numRuntimeErrorTestSuites' in data:
    assert data['numRuntimeErrorTestSuites'] == 0
result = {
    'mode': mode, 'passed': len(passed), 'failed': len(failed),
    'filteredOrPending': len(pending), 'selectedStatus': selected[0]['status'],
    'selectedFailureMessages': selected[0]['failureMessages'],
    'runtimeErrorFieldPresent': 'numRuntimeErrorTestSuites' in data,
    'runtimeErrorFieldValue': data.get('numRuntimeErrorTestSuites'),
    'raw': str(path),
}
path.with_suffix('.verified.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
PY
}

case "$1" in
  identity)
    bash -n "$HARNESS/qwen-feishu-cleanup.sh"
    test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
    test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
    test "$(git hash-object "$production")" = "$production_blob"
    test "$(git hash-object "$testfile")" = "$test_blob"
    test "$(git diff --name-only "$PREVIOUS_HEAD" HEAD)" = "$testfile"
    git diff --exit-code "$PREVIOUS_HEAD" HEAD -- . ":(exclude)$testfile"
    git diff "$PREVIOUS_HEAD" HEAD -- "$testfile" > "$RESULTS/one-assertion.patch"
    git diff --name-only "$LINT_BASE_SHA" HEAD > "$RESULTS/net-files.txt"
    test "$(wc -l < "$RESULTS/net-files.txt")" -eq 2
    node -e 'if(process.platform!=="linux" || process.arch!=="arm64" || process.version!=="v22.23.4") process.exit(1)'
    test "$(npm --version)" = 10.9.9
    { git log -1 --format=fuller; git rev-parse 'HEAD^{tree}'; node --version; npm --version; corepack pnpm --version; uname -a; } > "$RESULTS/source.txt"
    ;;
  install)
    logged install corepack pnpm install --frozen-lockfile --reporter=append-only
    ;;
  negative)
    test "$(git hash-object "$production")" = "$production_blob"
    trap 'git restore --source="$SOURCE_SHA" -- "$production"' EXIT
    python3 - "$production" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
assert lines[2808].strip() == 'rmSync(downloadedFileDir, { recursive: true, force: true });'
assert lines[2809].strip() == 'downloadedFileDir = undefined;'
assert any('if (this.stoppedMessages.has(msgId))' in line for line in lines[2803:2808])
lines[2808] = '                  // Mutation: omit only the immediate stop cleanup.\n'
path.write_text(''.join(lines), encoding='utf-8')
PY
    git diff HEAD -- "$production" > "$RESULTS/cleanup-omitted.patch"
    if logged cleanup-omitted npm --workspace=packages/channels/feishu run test:ci -- src/adapter.test.ts -t "$target" --reporter=default --reporter=json --outputFile="$RESULTS/cleanup-omitted.json"; then
      echo 'Stop-cleanup omission unexpectedly survived the selected test'
      exit 1
    else
      test "$?" -eq 1
    fi
    inspect cleanup-omitted
    git restore --source="$SOURCE_SHA" -- "$production"
    test "$(git hash-object "$production")" = "$production_blob"
    printf '%s\n' "$(git hash-object "$production")" > "$RESULTS/restored-production.txt"
    git diff --exit-code HEAD -- .
    trap - EXIT
    ;;
  full)
    test "$(git hash-object "$production")" = "$production_blob"
    test "$(git hash-object "$testfile")" = "$test_blob"
    logged feishu npm --workspace=packages/channels/feishu run test:ci -- --reporter=default --reporter=json --outputFile="$RESULTS/feishu.json"
    inspect feishu
    ;;
  style)
    logged scoped-eslint node scripts/lint.js --eslint
    logged scoped-prettier node scripts/lint.js --prettier
    ;;
  *) exit 2 ;;
esac
