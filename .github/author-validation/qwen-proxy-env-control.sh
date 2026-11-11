#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RESULTS"

logged() {
  local label=$1 status
  shift
  set +e
  /usr/bin/time -v -o "$RESULTS/$label.time" "$@" > "$RESULTS/$label.log" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status" > "$RESULTS/$label.rc"
  tail -n 35 "$RESULTS/$label.log"
  return "$status"
}

case "$1" in
  identity)
    bash -n "$HARNESS/qwen-proxy-env-control.sh"
    test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
    test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
    git fetch --no-tags --depth=1 origin "$INPUT_BASE"
    git diff --name-only "$INPUT_BASE" HEAD > "$RESULTS/net-files.txt"
    test "$(wc -l < "$RESULTS/net-files.txt")" -eq "$EXPECTED_FILES"
    git diff --exit-code "$INPUT_BASE" HEAD -- integrations/external-context package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json
    node -e 'if(process.platform!=="linux" || process.arch!=="arm64" || process.version!=="v22.23.4") process.exit(1)'
    test "$(npm --version)" = 10.9.9
    { git log -1 --format=fuller; git rev-parse 'HEAD^{tree}'; node --version; npm --version; corepack pnpm --version; uname -a; } > "$RESULTS/source.txt"
    node -e 'const fs=require("node:fs");const keys=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"];console.log(JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,runnerName:process.env.RUNNER_NAME,dockerenv:fs.existsSync("/.dockerenv"),machineIdPresent:fs.existsSync("/etc/machine-id"),inheritedProxyKeyPresence:Object.fromEntries(keys.map(k=>[k,Object.hasOwn(process.env,k)]))}))' > "$RESULTS/host-platform.json"
    ;;
  install)
    logged install corepack pnpm install --frozen-lockfile --reporter=append-only
    ;;
  dependency)
    node <<'JS' > "$RESULTS/undici.json"
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const req = require('node:module').createRequire(path.resolve('integrations/external-context/package.json'));
const packageFile = req.resolve('undici/package.json');
const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version;
if (version !== '7.29.0') throw new Error(`Unexpected locked Undici version: ${version}`);
const dispatcherFile = path.join(path.dirname(packageFile), 'lib/dispatcher/env-http-proxy-agent.js');
const source = fs.readFileSync(dispatcherFile, 'utf8');
if (!source.includes('httpProxy ?? process.env.http_proxy ?? process.env.HTTP_PROXY')) {
  throw new Error('Expected environment precedence was not found in actual Undici source');
}
console.log(JSON.stringify({version, packageFile, dispatcherFile, sha256:crypto.createHash('sha256').update(source).digest('hex')}));
JS
    ;;
  clean|lowercase)
    condition=$1
    command=(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u all_proxy -u no_proxy)
    if [ "$condition" = lowercase ]; then
      command+=(http_proxy=http://127.0.0.1:9)
    fi
    command+=(npm --workspace=integrations/external-context run test:ci -- src/proxy.test.ts --retry=2 --reporter=default --reporter=json --outputFile="$RESULTS/proxy-$condition.json")
    if logged "proxy-$condition" "${command[@]}"; then status=0; else status=$?; fi
    if [ "$condition" = clean ]; then
      test "$status" -eq 0
    else
      test "$status" -eq 1
    fi
    ;;
  records)
    python3 - "$RESULTS" "$ARM" <<'PY'
import json
from pathlib import Path
import sys

root, arm = Path(sys.argv[1]), sys.argv[2]
target = 'rejects a malformed proxy environment value via the real dispatcher'
records = []
for condition in ['clean', 'lowercase']:
    raw = root / f'proxy-{condition}.json'
    data = json.loads(raw.read_text(encoding='utf-8'))
    suites = data['testResults']
    assert len(suites) == 1
    assert suites[0]['name'].replace('\\', '/').endswith('/src/proxy.test.ts')
    cases = suites[0]['assertionResults']
    assert len(cases) == data['numTotalTests'] == 3
    passed = [case for case in cases if case['status'] == 'passed']
    failed = [case for case in cases if case['status'] == 'failed']
    assert len(passed) == data['numPassedTests']
    assert len(failed) == data['numFailedTests']
    assert len(passed) + len(failed) == 3 and data['numPendingTests'] == 0
    rc = int((root / f'proxy-{condition}.rc').read_text(encoding='utf-8').strip())
    selected = [case for case in cases if case['title'] == target]
    assert len(selected) == 1
    if condition == 'clean':
        assert len(passed) == 3 and not failed and rc == 0 and data['success'] is True
    else:
        assert len(passed) == 2 and len(failed) == 1 and rc == 1 and data['success'] is False
        assert failed[0]['title'] == target
        messages = '\n'.join(failed[0]['failureMessages'])
        log = (root / 'proxy-lowercase.log').read_text(encoding='utf-8')
        assert 'AssertionError' in messages and 'throw' in messages
        assert 'proxy.test.ts:48:' in messages + log
    if 'numRuntimeErrorTestSuites' in data:
        assert data['numRuntimeErrorTestSuites'] == 0
    records.append({
        'arm': arm, 'condition': condition, 'passed': len(passed), 'failed': len(failed),
        'pending': data['numPendingTests'], 'exitCode': rc,
        'selectedStatus': selected[0]['status'],
        'selectedFailureMessages': selected[0].get('failureMessages'),
        'runtimeErrorFieldPresent': 'numRuntimeErrorTestSuites' in data,
        'runtimeErrorFieldValue': data.get('numRuntimeErrorTestSuites'),
        'raw': str(raw),
    })
(root / 'proxy-env-records.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
print(json.dumps(records))
PY
    ;;
  *) exit 2 ;;
esac
