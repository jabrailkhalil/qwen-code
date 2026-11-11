#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RESULTS"

image='node:22.23.4-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f'

metrics() {
  local label=$1 file
  for file in memory.max memory.current memory.events cpu.max cpuset.cpus.effective; do
    if [ -r "/sys/fs/cgroup/$file" ]; then
      cat "/sys/fs/cgroup/$file" > "$RESULTS/$label-$file"
    fi
  done
}

logged() {
  local label=$1 status
  shift
  metrics "$label-before"
  set +e
  /usr/bin/time -v -o "$RESULTS/$label.time" "$@" > "$RESULTS/$label.log" 2>&1
  status=$?
  set -e
  metrics "$label-after"
  printf '%s\n' "$status" > "$RESULTS/$label.rc"
  tail -n 35 "$RESULTS/$label.log"
  return "$status"
}

case "$1" in
  identity)
    bash -n "$HARNESS/qwen-provider-control.sh"
    test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
    test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
    git fetch --no-tags --depth=1 origin "$INPUT_BASE"
    git diff --name-only "$INPUT_BASE" HEAD > "$RESULTS/net-files.txt"
    test "$(wc -l < "$RESULTS/net-files.txt")" -eq "$EXPECTED_FILES"
    git diff --exit-code "$INPUT_BASE" HEAD -- integrations/external-context package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json
    node -e 'if(process.platform!=="linux" || process.arch!=="arm64" || process.version!=="v22.23.4") process.exit(1)'
    test "$(npm --version)" = 10.9.9
    { git log -1 --format=fuller; git rev-parse 'HEAD^{tree}'; node --version; npm --version; corepack pnpm --version; uname -a; } > "$RESULTS/source.txt"
    node -e 'const fs=require("node:fs"); console.log(JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,runnerName:process.env.RUNNER_NAME,dockerenv:fs.existsSync("/.dockerenv"),machineIdPresent:fs.existsSync("/etc/machine-id")}))' > "$RESULTS/host-platform.json"
    ;;
  install)
    logged install corepack pnpm install --frozen-lockfile --reporter=append-only
    ;;
  host)
    logged provider-host npm --workspace=integrations/external-context run test:ci -- src/provider-extension-local.test.ts --retry=2 --reporter=default --reporter=json --outputFile="$RESULTS/provider-host.json"
    ;;
  image)
    logged docker-pull docker pull "$image"
    docker image inspect --format '{{json .RepoDigests}}' "$image" > "$RESULTS/container-image.json"
    ;;
  container)
    logged provider-container docker run --rm -e CI=true -e QWEN_SKIP_PREPARE=1 -v "$PWD:/work" -v "$RESULTS:/results" -w /work "$image" bash -lc '
      set -euo pipefail
      node -e '\''if(process.platform!=="linux" || process.arch!=="arm64" || process.version!=="v22.23.4") process.exit(1)'\''
      test "$(npm --version)" = 10.9.9
      node -e '\''const fs=require("node:fs"); console.log(JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,dockerenv:fs.existsSync("/.dockerenv"),machineIdPresent:fs.existsSync("/etc/machine-id")}))'\'' > /results/container-platform.json
      for file in memory.max memory.current memory.events cpu.max cpuset.cpus.effective; do
        if [ -r "/sys/fs/cgroup/$file" ]; then cat "/sys/fs/cgroup/$file" > "/results/container-$file"; fi
      done
      npm --workspace=integrations/external-context run test:ci -- src/provider-extension-local.test.ts --retry=2 --reporter=default --reporter=json --outputFile=/results/provider-container.json
    '
    ;;
  records)
    python3 - "$RESULTS" "$ARM" <<'PY'
import json
from pathlib import Path
import sys

root, arm = Path(sys.argv[1]), sys.argv[2]
target = 'packs an executable that fails fast without provider configuration'
results = []
for mode in ['host', 'container']:
    path = root / f'provider-{mode}.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    suites = data['testResults']
    assert len(suites) == 1
    assert suites[0]['name'].replace('\\', '/').endswith('/src/provider-extension-local.test.ts')
    cases = suites[0]['assertionResults']
    assert len(cases) == data['numTotalTests'] == 15
    passed = [case for case in cases if case['status'] == 'passed']
    failed = [case for case in cases if case['status'] == 'failed']
    assert len(passed) == data['numPassedTests']
    assert len(failed) == data['numFailedTests']
    assert len(passed) + len(failed) == 15 and data['numPendingTests'] == 0
    selected = [case for case in cases if case['title'] == target]
    assert len(selected) == 1 and selected[0]['status'] in ['passed', 'failed']
    results.append({
        'arm': arm, 'mode': mode, 'passed': len(passed), 'failed': len(failed),
        'pending': data['numPendingTests'], 'selectedStatus': selected[0]['status'],
        'selectedDurationMs': selected[0].get('duration'),
        'selectedFailureMessages': selected[0].get('failureMessages'),
        'runtimeErrorFieldPresent': 'numRuntimeErrorTestSuites' in data,
        'runtimeErrorFieldValue': data.get('numRuntimeErrorTestSuites'),
        'raw': str(path),
    })
    if 'numRuntimeErrorTestSuites' in data:
        assert data['numRuntimeErrorTestSuites'] == 0
(root / 'provider-records.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
print(json.dumps(results))
PY
    ;;
  *) exit 2 ;;
esac
