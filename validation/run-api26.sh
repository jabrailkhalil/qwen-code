#!/usr/bin/env bash
set -euo pipefail
evidence="${GITHUB_WORKSPACE:?}/evidence"
{ adb shell getprop ro.build.version.sdk; adb shell getprop ro.build.version.release; adb shell dumpsys webviewupdate; } > "$evidence/device.txt"
test "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" = 26
./gradlew --no-daemon connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.requireProfileIsolation=false \
  2>&1 | tee "$evidence/device-tests.log"
