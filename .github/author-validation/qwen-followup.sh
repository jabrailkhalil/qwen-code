#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$RESULTS"

metrics() {
  local label=$1 file
  for file in memory.max memory.current memory.events; do
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
  tail -n 25 "$RESULTS/$label.log"
  return "$status"
}

bootstrap_case='launches once under concurrent requests, survives its launcher, and cleanly retires'
webshell() {
  (
    cd packages/web-shell
    logged webshell npx --no-install vitest run client/utils/saveBlob.test.ts client/components/artifacts client/components/sidebar client/components/SessionOverviewPanel.test.tsx client/components/messages/WorkflowExecutionView.test.tsx --reporter=default --reporter=json --outputFile="$RESULTS/webshell.json"
  )
  python3 "$HARNESS/qwen-results.py" webshell "$RESULTS/webshell.json" "$ARM"
}

feishu() {
  (
    cd packages/channels/feishu
    logged feishu npx --no-install vitest run --reporter=default --reporter=json --outputFile="$RESULTS/feishu.json"
  )
  python3 "$HARNESS/qwen-results.py" positive "$RESULTS/feishu.json" "$ARM"
}

case "$1" in
  identity)
    bash -n "$HARNESS/qwen-followup.sh"
    python3 -m py_compile "$HARNESS/qwen-results.py"
    test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
    test "$(git rev-parse 'HEAD^{tree}')" = "$SOURCE_TREE"
    git merge-base --is-ancestor "$BASE_SHA" HEAD
    git diff --name-only "$BASE_SHA" HEAD > "$RESULTS/net-files.txt"
    test "$(wc -l < "$RESULTS/net-files.txt")" -eq "$EXPECTED_FILES"
    git diff --exit-code "$BASE_SHA" HEAD -- package.json pnpm-lock.yaml AGENTS.md CONTRIBUTING.md .github/workflows/ci.yml scripts/tests/no-ak-integration-ci.test.js
    { git log -1 --format=fuller; git rev-parse 'HEAD^{tree}'; node --version; corepack pnpm --version; uname -a; } > "$RESULTS/source.txt"
    node -e 'console.log(JSON.stringify({node:process.version,heapLimit:require("node:v8").getHeapStatistics().heap_size_limit}))' > "$RESULTS/node-heap.json"
    ;;
  install) logged install corepack pnpm install --frozen-lockfile --reporter=append-only ;;
  build)
    logged build npm run build
    logged bundle npm run bundle
    ;;
  types) logged typecheck npm run typecheck ;;
  style)
    export LINT_BASE_SHA="$BASE_SHA"
    logged scoped-eslint node scripts/lint.js --eslint
    logged scoped-prettier node scripts/lint.js --prettier
    ;;
  full-format) logged full-prettier env -u LINT_BASE_SHA node scripts/lint.js --prettier ;;
  functional)
    if [ "$ARM" = base ]; then
      logged ci-meta npm run test:scripts:unit -- scripts/tests/no-ak-integration-ci.test.js scripts/tests/verify-capture.test.js scripts/tests/lint-scope.test.js --reporter=json --outputFile="$RESULTS/ci-meta.json"
      python3 "$HARNESS/qwen-results.py" positive "$RESULTS/ci-meta.json" "$ARM"
      logged routing node --test .github/scripts/ci-runner-routing.test.mjs
      logged freshness node --test .github/scripts/check-lint-gate-freshness.test.mjs
      feishu
      webshell
    elif [ "$ARM" = feishu ]; then
      feishu
    else
      webshell
    fi
    ;;
  bootstrap-host)
    test -e /etc/machine-id
    logged bootstrap-host npm --workspace=packages/cli run test -- src/serve/managed-runtime-bootstrap.process.test.ts -t "$bootstrap_case" --reporter=json --outputFile="$RESULTS/bootstrap-host.json"
    python3 "$HARNESS/qwen-results.py" host "$RESULTS/bootstrap-host.json" "$ARM"
    ;;
  bootstrap-container)
    image='node:22-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f'
    logged docker-pull docker pull "$image"
    docker image inspect --format '{{json .RepoDigests}}' "$image" > "$RESULTS/container-image.json"
    export BOOTSTRAP_CASE="$bootstrap_case"
    if logged bootstrap-container docker run --rm -e CI=true -e QWEN_SKIP_PREPARE=1 -e BOOTSTRAP_CASE -v "$PWD:/work" -v "$RESULTS:/results" -w /work "$image" bash -lc 'test -e /.dockerenv && test ! -e /etc/machine-id || exit 97; node --version; npm --workspace=packages/cli run test -- src/serve/managed-runtime-bootstrap.process.test.ts -t "$BOOTSTRAP_CASE" --reporter=json --outputFile=/results/bootstrap-container.json'; then
      echo 'Expected missing-machine-id failure did not reproduce'
      exit 1
    else
      test "$?" -eq 1
    fi
    python3 "$HARNESS/qwen-results.py" container "$RESULTS/bootstrap-container.json" "$ARM"
    ;;
  *) echo "Unknown verification phase: $1" >&2; exit 2 ;;
esac
