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

## Verified results

- Java17/Gradle8.2.1 on Windows: debug, unsigned release, instrumentation builds and 29 JVM tests passed; lint 0 errors, 6 existing dependency notices.
- API36 / WebView134.0.6998.135: 47 actual passes, 1 assumption skip, 0 failures across all 7 committed native classes (48 cases).
- API26 / WebView69.0.3497.100: 36 actual passes, 12 capability skips, 0 failures. A separate real Connect UI check confirmed the provider-update screen with no WebView created.
- Four additional actual HTML/system-UI cases passed: text-only document Open/Save, stopped microphone then Open, stopped microphone then Save, and microphone-authorized Activity recreation requiring explicit Retry and renewed native consent.
- Web Shell: 518 focused tests across 13 files, package typecheck, all 8 changed TS/TSX files' ESLint and the package build passed.

The complete repository build is **not green** in this Windows environment. The exported document renderer is 2,001,512 bytes against a 1,930,000-byte limit. Restoring the six changed H5 callers to pinned upstream on the same dependencies yields 1,999,253 bytes and the same guard failure. No budget was raised. All caller files were restored byte-for-byte and the integrated Web Shell was rebuilt afterward.

An initial combined native run had a rename/recreation fixture timeout. An independent diagnostic reproduced a separate concrete defect in the exact fixture: an idle preconnect timed out and permanently stopped its server. The fixture was fixed per connection and a liveness regression added; the identical independent diagnostic and final complete suite passed. The initial timeout's precise socket event was not captured, so that causal attribution remains an inference. Product recovery code was unchanged.

## Reproduce

Build from `packages/mobile-shell` with Java17 and the Android SDK configured:

```text
gradlew.bat --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:assembleDebugAndroidTest :app:lintDebug
```

Install the debug and test APKs. Select these committed classes explicitly: `ProfileDeviceTest`, `ProfileInitializationDeviceTest`, `FilePickerDeviceTest`, `MicrophoneDeviceTest`, `ProfileAccessibilityDeviceTest`, `DownloadsDeviceTest`, `ConnectionRecoveryDeviceTest`. Modern instrumentation must pass `-e requireProfileIsolation true`. Count assumption skips separately; JUnit's aggregate OK count includes them.

The optional [combined UI harness](fixtures/android-phase2/CombinedNativeAcceptanceDeviceTest.kt) uses synthetic loopback HTML, real touch/permission/document UI and a temporary encrypted profile. It is outside the automatic test source set because it requires an English modern emulator and a preseeded Downloads file named `qwen-combined-input.txt`, whose UTF-8 bytes are exactly `SYNTHETIC COMBINED INPUT\n`. Copy it into the matching `androidTest` package and rebuild the test APK to run its four cases. Save output names use fresh UUIDs; inspect/remove only those synthetic files. It does not wipe app data. The saved-before-stop test verifies explicit Retry after real Activity recreation and fresh native microphone consent despite an existing OS grant.

## Acceptance boundaries and remaining work

The microphone policy intentionally closes any microphone-authorized WebView when backgrounded, even after the audio track ended. Therefore real Open/Save after microphone authorization cancels the operation; Save can leave an empty selected file. Text-only Open and Save work. Recovery retains the session route and explicit Retry, but does not make this interaction seamless or resume the cancelled file operation.

Actual OS process-kill/relaunch, production daemon/H5 and live voice-provider acceptance, physical devices and TalkBack are not established by these fixtures. No foreground/background notification service was added. Per-device revocable primary-listener credentials remain a server prerequisite. Official app identity/signing/release and upstream merge decisions remain with the maintainers. This branch is a reproducible development build, not completed production Phase 2.

Debug APK SHA-256: `cd759b4d8ce2f8850b1409f6ae057a29cb77a2863c4d1b4f4fde3e2be7b47793`.
