---
name: scry-native-capture-setup
description: Set up a native mobile app (SwiftUI, Jetpack Compose, React Native, or Flutter) so Scry can capture its screens, then verify the capture bundle. Use when someone wants an iOS, Android, React Native or Flutter app mapped in Scry, asks how to add Scry screen capture to a mobile app, or needs a capture script, screen registry, fixtures or CI for it. Not for UIKit-only apps; for those, point the user to references/bundle.md (the capture bundle format) instead of improvising. It never uploads and never reads, writes or prints an API key.
---

# Set up native app capture for Scry

Make an existing app capturable, then prove it with a bundle that passes the validator. You add a
small launch hook, a registry of screens, fixed data and a capture script (CI is optional). You
never upload and never read, write or print an API key: the upload is the user's command, run in
their own shell after they have seen the screenshots.

## Install and copying files

The user installs this skill with `npx skills add scryorg/scry-node --skill scry-native-capture-setup`
(always the `scryorg/scry-node` repo name). The installer puts the skill in
`.agents/skills/` and may make `.claude/skills` a symlink to it. When it is a symlink, do not `cp`
assets out of it: Claude Code prompts for permission on each copy. Read the asset and create the
file in the user's app with the Write tool, verbatim apart from the names, package and paths the
reference lists (`make-scf.mjs` and the scripts must stay byte-identical otherwise, except the one
`--tool-name` string in `capture.sh` that the reference tells you to set).

## Pick the path

1. Inspect the repo. Look for `pubspec.yaml` first: one with `flutter:` under `dependencies` (`sdk: flutter`)
   is a Flutter app, and its generated `ios/Runner.xcodeproj` and `android/app/build.gradle` are not a SwiftUI
   or Compose app. Otherwise: `*.xcodeproj` / `Package.swift` (SwiftUI), `build.gradle(.kts)` with
   `androidx.compose` (Compose), `package.json` with `react-native` / `expo`.
2. Read only the reference for that path:
   - SwiftUI: [references/swiftui.md](references/swiftui.md)
   - Compose: [references/compose.md](references/compose.md)
   - React Native or Expo: [references/react-native.md](references/react-native.md). It uses the
     built-in `scry capture rn`; there is no script to copy.
   - Flutter: [references/flutter.md](references/flutter.md). Dev-only test files and scripts, nothing in
     `lib/`; it can capture on an emulator or simulator, or headless with no device. Read it, then follow the
     Flutter notes below instead of the SwiftUI/Compose hook steps.
   - Both an iOS and an Android app: do one, verify it, then the other.
3. UIKit-only, Kotlin Multiplatform without Compose, or anything else: say this skill does
   not cover it and stop. Do not improvise a hook. [references/bundle.md](references/bundle.md)
   describes the bundle if the user wants to write their own script.
   When the repo is not a SwiftUI, Jetpack Compose, React Native or Flutter app (UIKit-only, a CLI, a web app, anything
   else), make no changes and tell the user the capture bundle page, `references/bundle.md`, explains how any other
   source can ship a capture bundle.
4. A SwiftUI app that mixes in UIKit is fine if the screens to map are SwiftUI views; say which
   screens you cannot map.

## What you add (SwiftUI and Compose; Flutter differs, see below)

Only these, nothing else in the user's app:

| Piece | File | Source |
|---|---|---|
| Launch hook | `ScryLaunch.swift` / `ScryLaunch.kt` (Android: also a no-op `src/release` copy from `assets/ScryLaunch-release.kt`) | `assets/` |
| Screen registry | `ScryScreens.swift` / `ScryScreens.kt` | `assets/`, then fill in |
| Fixtures | `Fixtures.swift` / `Fixtures.kt` | write from the app's own model types |
| Capture script | `scripts/capture.sh` | `assets/capture-ios.sh` or `capture-android.sh` |
| Bundle writer | `scripts/make-scf.mjs` | `assets/make-scf.mjs` (shared) |
| Screen list | iOS: none, the app prints it (`-ScryList YES`). Android: `scripts/screens.json` | Android: by hand, one entry per registry entry |
| CI (optional) | `.github/workflows/scry-capture.yml` | `assets/scry-capture-ios.yml`, `scry-capture-android.yml` or (Flutter) `assets/flutter/scry-capture-flutter.yml` |

Plus the one-line wiring in the app entry point and `.scry/` and `.build/` in `.gitignore`. The
assets are copies of the Kettle sample apps (scryorg/scry-sample-ios, scry-sample-android): keep
their logic, change only names, package, paths and the sample-specific bits the reference lists.
Never overwrite a file the user already has: merge into it.

## Steps

1. **Ask only what you cannot find:** which screens matter (default: every top-level screen, at most
   about 10 to start), the Scry project id, whether to add CI. Do not ask for the API key.
2. **Add the hook** and wire the entry point. A normal launch must behave exactly as before;
   `-ScryScreen <id>` (iOS) or `--es scry_screen <id>` (Android) shows only that screen. The hook is
   debug-only: iOS wraps it in `#if DEBUG` (Release gets a pass-through `ScryLaunchRoot`), Android
   keeps it in `src/debug` with a no-op copy in `src/release`. A release build carries none of it.
   - The app already reads launch arguments or intent extras: keep its handling, add the Scry key
     beside it, and do not reorder or consume the existing ones.
   - iOS: with an existing `.xcodeproj`, check how files reach the target:
     `grep PBXFileSystemSynchronizedRootGroup *.xcodeproj/project.pbxproj`. A hit (Xcode 16
     synchronized folders, what the sample uses) means a file dropped in the folder is in the target.
     No hit is a classic project: add each new file to the app target explicitly (`project.pbxproj`
     file reference, build file, Sources phase) or ask the user to drag them in, and say so in your
     report: classic projects are untested. A SwiftPM-only app: put the files in the app target's
     sources. Do not convert one to the other.
   - Android: put the files in the module that holds the launcher activity. In a multi-module
     project, the registry may need access to screens in feature modules: use the existing `api` /
     `implementation` dependencies, do not add new ones.
3. **Register screens** with a stable `id` (a route or type name, never a display title), the view's
   source file and line.
4. **Write fixtures** for any screen that reads the network, clock, randomness or signed-in user, so
   two captures are identical. Fixtures and capture paths run only when the launch argument is set;
   they must not change a release build (`#if DEBUG` / debug source set, as above). If the app has a
   test target, add a registry test to it (write it yourself; it is not in `assets/`): ids unique and
   stable, and each `file`/`line` still holds the declaration, because hand-written file and line drift.
5. **Copy the scripts.** iOS: nothing else, `capture.sh` asks the app for its registry
   (`-ScryList YES` prints `scry:screens <json>`; `ScryScreens.swift` is the one source of ids).
   Android: write `scripts/screens.json` from `ScryScreens.kt` (id, kind, title, name, file, line)
   and keep the two in step. Set `kind` to `component` for a component (it is captured as a
   full-screen canvas, not a tight crop) and `title` for its grouping, e.g. `["Components"]`.
6. **Capture and validate.** First check a simulator or emulator exists (`xcrun simctl list devices
   available`, `adb devices`). If none: stop here, do not claim a capture ran, and list for the user
   the exact `capture.sh` and `--dry-run` commands from the reference with the expected output.
   Emulators and simulators only: the Android script refuses a physical device (it installs the app
   and changes system settings) unless the user sets `ALLOW_PHYSICAL=1`; never set it yourself. Both
   scripts refuse an `OUT` outside the project or one that is not empty (it is deleted and recreated),
   and reject screen ids that are not letters, digits, `.`, `_`, `-`.
   Otherwise (the scripts build the Debug app and wait for the device to boot themselves):
   ```
   bash scripts/capture.sh
   npx @scrymore/scry-deployer upload .scry/capture --dry-run
   ```
   `--dry-run` needs no key and no project id: run it with none set (step 8). Expected from the samples (N = registered screens):
   `scf: 5/5 captured, 0 skipped -> .scry/capture`, then
   `Bundle valid: 5 captures, source swiftui-preview:ios.` (Android:
   `source compose-preview:android.`). `scf: 4/5 captured, 1 skipped` or exit code 1 means a
   screen never reported ready: fix it, do not lower the count. Other devices: `DEVICE="<name>"`
   and, on iOS, `SCALE=<2|3>`; Android derives the scale from `wm density`.
7. **Look at the screenshots** in `.scry/capture/images/`: no keyboard, permission dialog, loading
   spinner, debug banner or clipped status bar. A valid bundle can hold bad images.
8. **Hand the upload to the user; do not run it.** Stop and list this for them to run themselves,
   with `SCRY_PROJECT_ID` and `SCRY_API_KEY` already exported in their own shell (or set as CI
   secrets), after they have looked at the screenshots:
   ```
   npx @scrymore/scry-deployer upload .scry/capture
   ```
   Do not write the key or the project id into this command, a file or your reply, and do not ask
   the user to paste them to you. The only `upload` you run is `--dry-run` with `SCRY_API_KEY`
   unset (run `env -u SCRY_API_KEY -u STORYBOOK_DEPLOYER_API_KEY npx @scrymore/scry-deployer upload
   .scry/capture --dry-run` if the shell may have one).

## Flutter, in short

Everything is in [references/flutter.md](references/flutter.md); this is what differs from the steps above.
There is no launch hook, no entry-point wiring and no change in `lib/`: the registry and tests live in
`integration_test/`, `test/`, `test_driver/` and `scripts/`, and `pubspec.yaml` gains only `integration_test` and
`flutter_test` under `dev_dependencies` (both ship inside the Flutter SDK). Steps 1, 3, 4, 7 and 8 apply as written
(registry with stable ids, fixtures, look at the screenshots, hand the upload to the user). Capture is
`bash scripts/capture.sh android|ios|headless`: `android` and `ios` need an emulator or simulator; `headless`
needs only the Flutter SDK, so with no device run that, and tell the user which path they got (both draw the
app's own Flutter widgets; a headless bundle is platform `other`, never "the iOS look"). No Flutter SDK on the machine: write the files, do not claim a capture ran, and list the exact
commands and expected output for the user. Expected dry-run line: `Bundle valid: N captures, source
flutter-golden:other.` (`:android` / `:ios` on a device). If the headless run stops with `scry capture: fonts did not load`,
that is the guard working: fix the fonts (`flutter precache`), do not work around it. Two device-path gotchas
(details in the reference): several booted simulators need `IOS_UDID=<udid>`, and the Android test must keep
immersive mode or the PNGs carry a status-bar band. A fresh Android emulator needs the script's settle wait and drive watchdog
(it exits 4 with the cause and retry command instead of hanging).

## Rules

- No new dependency in the user's app, project file settings or build config. The hook is plain
  SwiftUI / Compose. Flutter: only `integration_test` and `flutter_test` as `dev_dependencies`, nothing under
  `dependencies:`, nothing in `lib/`, `android/` or `ios/`.
- CI, only if asked: copy the matching `assets/scry-capture-*.yml` (Flutter:
  `assets/flutter/scry-capture-flutter.yml`) and keep its guards. It runs on
  a push to the default branch only (Flutter: if the default branch is not `main`, change `branches: [main]` in the
  template's `on:` block, the only edit; the upload step compares with the repo's default branch itself), never on
  `pull_request` or `pull_request_target`, never on a self-hosted runner, with `permissions:
  contents: read`, and `SCRY_API_KEY` appears only on the upload step. Tell the user it has not run
  on a hosted runner yet. The Flutter template captures headless on `ubuntu-latest` (platform `other`), keeps
  every action pinned to a commit SHA, and ends the upload step green with a notice, uploading nothing, when
  `SCRY_API_KEY` or `SCRY_PROJECT_ID` is not set (a fork, a fresh clone). It ships no emulator job: for a device
  capture in CI point the user to `references/flutter.md`.
- Do not include source text (`--include-source`) unless the user asks.
- Never read, print, write to a file, log or commit an API key. Credentials are `SCRY_PROJECT_ID`
  and `SCRY_API_KEY`, set by the user in their environment or CI secrets, never by you. Do not run
  `env`, `printenv`, `export -p`, `set`, `echo $SCRY_API_KEY` or any command that shows them; do not
  use `set -x`, `bash -x` or a CLI debug or verbose flag around a command that could see a key. Do
  not read the user's keychain, `.env`, shell profile or shell history to find one. If a key shows
  up in output anyway, say so and tell the user to rotate it.
- Never answer a device permission prompt. Set capture up so none appears (fixtures, no real
  permission-gated calls); if one still does, report it.
- Do not upload, create a project or call the Scry API. The optional CI file uploads from the
  user's CI with their secret; you only add the file, you never run that step.

## Status of the pieces

The hooks, `capture.sh` scripts and `make-scf.mjs` ran end to end on the Kettle sample apps (iOS 18.6
simulator, Pixel 6 API 34 emulator): bundles pass `--dry-run` and the release builds hold no capture
code. The Flutter templates ran headless on a scratch app (Flutter 3.47.6, Linux): valid bundle, two runs
byte-identical, the font guard stops the run; the emulator and simulator paths run in the Kettle Flutter sample
(scryorg/scry-sample-flutter). The CI templates have not run on a hosted runner. The Flutter CI template
(`assets/flutter/scry-capture-flutter.yml`) was checked without a runner: `actionlint`, the Kettle Flutter sample's
`scripts/check-workflows.sh` guards, and its steps (`capture.sh headless`, `upload --dry-run`, and the upload step's
skip logic with and without credentials) run locally on Linux with Flutter 3.47.6. GitHub Actions itself has not run it.
Untested: classic (non-synchronized) Xcode
projects, multi-module Android apps, `singleTop` activities.
