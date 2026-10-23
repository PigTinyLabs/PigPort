# Compatibility notes — 2026-10-23

## Liên Quân crash investigation

Read-only investigation; no runtime fixes applied in this investigation.

- iOS reports from 2026-10-22 show failures in SecKeyGetBlockSize called by UnityFramework, heap corruption involving CrashSight, invalid objc_retain, and, most recently at 17:48, Metal drawIndexedPrimitives in AGXMetalG16X called by UnityFramework.
- These are failure locations, not proven root causes. There is no evidence yet that failing to identify as an iPad caused the crashes.
- Current native input code already overrides several iPad/device identity queries and also intercepts Keychain and CrashSight behaviour. Compare a minimal baseline against each hook group separately before adding more overrides.
- Audit Keychain return types, error propagation, object lifetimes and thread safety. Preserve genuine error reporting; suppressing an abort is not a memory-corruption fix.
- Investigate Metal/Unity compatibility after isolating memory and hook failures. Lower render settings are diagnostic experiments, not confirmed fixes.
- The currently recorded Liên Quân package is Android XAPK com.garena.game.kgvn on emulator-5554. Its Android crash has not been diagnosed: this tool session cannot connect to the ADB listener on port 5037. Obtain Android logcat/tombstones for a separate diagnosis.

## Device profiles

- iPad identity/UI overrides do not supply the full iPadOS runtime, GPU stack or device services. Avoid hiding host differences from system frameworks that depend on them.
- Android tablet mode requires an Android system image and an appropriate tablet hardware/display profile. Naming it iPad does not supply iOS APIs or make an IPA executable on Android.

## IPA on Windows — proposed architecture, not implemented

Goal: choose an IPA in the Windows client, install it on a paired Apple Silicon Mac host, and control its streamed game session from Windows.

1. First establish that the selected IPA runs reliably on the Mac host. Streaming cannot fix a host-side crash.
2. Add an authenticated paired-host protocol for capabilities, package upload, install, launch, stop and diagnostic retrieval. Restrict commands to the game service; do not expose arbitrary shell access.
3. Upload in bounded chunks with integrity checks, resume support and explicit installation status.
4. Capture the selected game window and audio on the Mac; encode video with hardware acceleration and stream over WebRTC. Obtain macOS screen/audio/input permissions when needed.
5. Send keyboard, mouse, controller and mapped-touch events back to the host. Coordinate mapping must follow the actual game window and render target.
6. Handle reconnects, timeouts, host availability, per-game data isolation and process exits. Start with a paired Mac on the same LAN; internet traversal is additional work.

This is remote execution: the Mac must remain available. It is not local/offline IPA execution on Windows. No remote backend has been implemented by this note.

True local Windows support would require a separate iOS-compatible runtime: Mach-O loading, ARM64 execution/translation where necessary, Objective-C/Swift runtime support, Apple-framework API compatibility, graphics translation, data/services compatibility and game-specific validation. Windows ARM64 only addresses CPU architecture, not these APIs. Reusing the current Mac Catalyst converter does not provide them.

References:
- https://github.com/PlayCover/PlayCover — current project targets Apple Silicon Macs.
- https://developer.apple.com/documentation/uikit/choosing-a-user-interface-idiom-for-your-mac-app
- https://developer.android.com/studio/run/managing-avds

## Android stability work — 2026-10-23

Implemented in the Android path only:
- Wait for both boot_completed and a responsive Package Manager, including reused devices.
- Reject source APK/XAPK native ABIs incompatible with the selected Android device.
- Resolve the launch activity and use am start -W instead of Monkey, then observe the main process for 3 seconds. Early exit is reported rather than treated as successful gameplay; later crashes still require Diagnostics.
- Managed emulator uses a 1280x800 / 160 dpi tablet display and cold boots without Quick Boot snapshots. This does not wipe userdata. Existing external emulator startup flags are left to their owner.
- Settings offers Auto / Software graphics. Apply & restart closes games on the built-in AVD and cold boots with the new renderer. Software is a diagnostic fallback, not guaranteed game compatibility.
- Concurrent cold-boot requests for the same AVD share one boot operation.
- Emulator output stays in a 64 KiB in-memory tail. On launch failure the app captures device properties and a finite recent crash buffer; diagnostics/android-latest.txt is overwritten with at most 1 MiB. No continuous logcat file is created. Crash-buffer entries may predate the launch or belong to another app.
- Diagnostics is also available from installed Android game cards.

Validation: TypeScript build and the 35 non-uninstall tests pass, including 7 new Android stability cases. The separate existing iOS uninstall test fails in this restricted session because getconf DARWIN_USER_CACHE_DIR is unavailable; it was not changed. Live ADB/Android gameplay remains unverified because the tool session cannot bind/connect to the ADB listener (Operation not permitted on port 5037). No confirmed root-cause fix for Liên Quân's Android crash is claimed.

## Visual control settings UI — 2026-10-23

- Per-game Controls button in the imported library (IPA/APK/XAPK) and Android game list, usable before launching a game.
- Android player Control settings opens the same modal with a snapshot of the current frame. The stream is not paused; input bindings are released and keyboard input to the player is blocked while the modal is open. Quick edit remains available.
- Add/delete key buttons, WASD joysticks and mouse-look areas; drag on a normalized preview, assign keyboard/mouse keys, edit percent coordinates/radius/sensitivity. MOBA/FPS layouts are starter drafts and require game-specific positioning. They do not implement game-specific skill aiming or macros.
- Import/export existing version-1 keymaps. Save persists through the existing validated keymap API; Android player applies a saved profile immediately. iOS's existing injected input layer reloads its keymap on focus; this UI does not add iOS runtime compatibility.
- Cancel discards the isolated draft after an unsaved-change prompt. Saving blocks edits until the operation succeeds or fails.
- TypeScript build checked. Native UI interaction and screenshots could not be verified in this tool session; require manual UI review.
