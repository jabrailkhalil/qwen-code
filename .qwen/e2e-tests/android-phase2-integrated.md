# Combined Android Phase 2 acceptance — 2026-09-19

This is an integration/verification branch, not an official Android release or a replacement for the focused upstream PRs.

## Source manifest

Pinned upstream `009aab05b2` plus these source commits, cherry-picked with traceable `-x` records:

| Slice | Upstream PR | Source commits |
| --- | --- | --- |
| Encrypted isolated profiles and initialization guard | #12121 | `496903fca0`, `92f6af0109`, `a765ac1ecf` |
| Document Open | #12126 | `f01990a750` |
| Foreground microphone consent | #12127 | `a4d574756e` |
| Native profile accessibility | #12129 | `d53ad5f12a` |
| Blob/document Save | #12130 | `548e731053` |
| Connection recovery | #12247 | `81d5a59282`, `8e1f527e9b` |

Combined product changes are at `e8bee177e4`; test fixture hardening is at `98f5b42b9b`. Conflict resolution retains every controller and pending-result flag. A microphone-authorized snapshot is marked as requiring Retry even when Android saves state before `onStop`; background teardown remains in force.

The microphone/document preflight is at `26c4a5d1ed`; its focused counterpart is published in #12127 as `d0f3e94f2f`. The integration-only snapshot accounting keeps Open and Save independent when their deferred cancelled results are queued together.

## Verified results

- Java17/Gradle8.2.1 on Windows: debug, unsigned release, instrumentation builds and 29 JVM tests passed; lint 0 errors, 6 existing dependency notices.
- Final combined API36 / WebView134.0.6998.135: 50 actual passes, 1 assumption skip, 0 failures across all 8 committed native classes (51 cases). The final APK also passed 7/7 independent real HTML/system-UI and saved-state scenarios.
- Combined API26 / WebView69.0.3497.100 before the API36-only counter refinement: 39 actual passes, 12 capability skips, 0 failures. The counter refinement changes only per-action saved-state accounting; API26 was not rerun after it. A separate real Connect UI check confirmed the provider-update screen with no WebView created.
- Focused microphone API36: 20 actual passes, 1 assumption skip, 0 failures across its 4 committed native classes. Focused API26: 17 actual passes, 4 capability skips, 0 failures.
- The final real guard cases cover stopped microphone Open and Save, Keep editing and Android Back retaining the same page/draft, explicit Reconnect followed by real Open/Save with exact bytes, a stopped original track with a live clone, Home/return foreground teardown, each saved-before-cancel boundary, and an ordered Open-then-Save snapshot between deferred cancellations.
- Web Shell: 518 focused tests across 13 files, package typecheck, all 8 changed TS/TSX files' ESLint and the package build passed.

The complete repository build is **not green** in this Windows environment. The exported document renderer is 2,001,512 bytes against a 1,930,000-byte limit. Restoring the six changed H5 callers to pinned upstream on the same dependencies yields 1,999,253 bytes and the same guard failure. No budget was raised. All caller files were restored byte-for-byte and the integrated Web Shell was rebuilt afterward.

An initial combined native run had a rename/recreation fixture timeout. An independent diagnostic reproduced a separate concrete defect in the exact fixture: an idle preconnect timed out and permanently stopped its server. The fixture was fixed per connection and a liveness regression added; the identical independent diagnostic and final complete suite passed. The initial timeout's precise socket event was not captured, so that causal attribution remains an inference. Product recovery code was unchanged.

## Reproduce

Build from `packages/mobile-shell` with Java17 and the Android SDK configured:

```text
gradlew.bat --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:assembleDebugAndroidTest :app:lintDebug
```

Install the debug and test APKs. Select these committed classes explicitly: `ProfileDeviceTest`, `ProfileInitializationDeviceTest`, `FilePickerDeviceTest`, `MicrophoneDeviceTest`, `ProfileAccessibilityDeviceTest`, `DownloadsDeviceTest`, `ConnectionRecoveryDeviceTest`. Modern instrumentation must pass `-e requireProfileIsolation true`. Count assumption skips separately; JUnit's aggregate OK count includes them.

The optional [combined UI harness](fixtures/android-phase2/CombinedNativeAcceptanceDeviceTest.kt) uses synthetic loopback HTML, real touch/permission/document UI and a temporary encrypted profile. It is outside the automatic test source set because it requires an English modern emulator and a preseeded Downloads file named `qwen-combined-input.txt`, whose UTF-8 bytes are exactly `SYNTHETIC COMBINED INPUT\n`. Copy it into the matching `androidTest` package and rebuild the test APK to run its seven guard cases. Save output names use fresh UUIDs; inspect/remove only those synthetic files. It does not wipe app data. The saved-before-stop checks cover both native controllers and the ordered Open-then-Save queue.

## Acceptance boundaries and remaining work

The microphone policy intentionally closes any microphone-authorized WebView when backgrounded, even after the audio track ended. Before that background transition can occur, the guard intercepts microphone-authorized Open/Save, returns the normal cancelled result to the controller, and offers Keep editing or explicit Reconnect. A blocked Save does not open DocumentsUI or create a destination. Recovery retains the session route in the combined build, but this does not make microphone/file use seamless or resume the cancelled file operation.

Actual OS process-kill/relaunch, production daemon/H5 and live voice-provider acceptance, physical devices and TalkBack are not established by these fixtures. No foreground/background notification service was added. Per-device revocable primary-listener credentials remain a server prerequisite. Official app identity/signing/release and upstream merge decisions remain with the maintainers. This branch is a reproducible development build, not completed production Phase 2.

Final combined debug APK SHA-256: `df9aded931572e5d7039bf812e77931206eae4d5c3c625f79719c63abbb50e0a`.
