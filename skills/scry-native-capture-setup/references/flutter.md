# Flutter (Android, iOS or no device)

Needs the Flutter SDK on `PATH` (use the app's own version; the sample is pinned to 3.47.6) and Node 20+.
`android` also needs `adb`, one running emulator and JDK 17; `ios` needs a Mac with Xcode and an iOS
simulator; `headless` needs nothing else. Source of truth for every asset below: the Kettle sample
(scryorg/scry-sample-flutter); `assets/flutter/` are copies of its files, except `screens.dart` and
`screens.json`, which are templates to fill in (the sample's own registry names Kettle screens).

## Two ways to capture, one bundle format

| | `bash scripts/capture.sh android` / `ios` | `bash scripts/capture.sh headless` |
|---|---|---|
| How | `flutter drive` runs one `integration_test` on an emulator or simulator | `flutter test` renders each screen with no device |
| Look | The real device's screen size and pixel density, the app surface only (no status or navigation bar) | A 390 x 844 pt surface at 3x, whatever the app targets |
| Bundle | `flutter-golden`, platform `android` or `ios`, method `emulator` or `simulator`, device name and OS | `flutter-golden`, platform `other`, method `headless-render`, device `flutter_test 390x844@3x` |
| Use it when | A simulator or emulator exists. This is the one to show your team | No device (a laptop without Xcode, CI without an emulator). Seconds, same pixels on every run |

Both paths draw the app's own Flutter widgets with its own theme and fonts: both are the Flutter Material look,
and neither is a rendering of native iOS or Android controls. Do not describe either as "the iOS look". Tell the
user which path they got; a headless bundle is platform `other`, not iOS or Android. Same bundle format and
same upload.

## What you add (dev only, nothing in `lib/`)

| File | Source |
|---|---|
| `integration_test/scry/screens.dart` (registry + `scryApp` shell) | `assets/flutter/screens.dart`, then fill in |
| `integration_test/scry_capture_test.dart` (device path) | `assets/flutter/scry_capture_test.dart`, verbatim |
| `test_driver/integration_test.dart` (writes the screenshots) | `assets/flutter/test_driver_integration_test.dart`, verbatim |
| `test/scry_capture_test.dart` (headless path) | `assets/flutter/headless_scry_capture_test.dart`, verbatim |
| `test/scry_fonts.dart` (font loader and guard for the headless path) | `assets/flutter/scry_fonts.dart`, verbatim |
| `test/scry_registry_test.dart` (registry and `screens.json` agree) | `assets/flutter/scry_registry_test.dart`, verbatim |
| `scripts/capture.sh` | `assets/flutter/capture.sh`, verbatim |
| `scripts/make-scf.mjs` | `assets/make-scf.mjs` (shared with the other paths), verbatim |
| `scripts/screens.json` | `assets/flutter/screens.json`, then one entry per registry entry |
| `.github/workflows/scry-capture.yml` (optional, only if asked) | `assets/flutter/scry-capture-flutter.yml`, see CI below |

Plus `integration_test` and `flutter_test` under `dev_dependencies` in `pubspec.yaml` (both are
`sdk: flutter`: they ship inside the Flutter SDK, there is no pub.dev package and no version to pin) and
`.scry/` in `.gitignore`. Nothing else: no change in `lib/`, no new `dependencies:` entry, no change to
`android/` or `ios/`. Never overwrite a file the user already has (an `integration_test/` or `test_driver/`
folder is common): merge into it, and keep the user's existing tests untouched.

## Steps

1. **Check it is an app.** `pubspec.yaml` has `flutter:` under `dependencies` (`sdk: flutter`) and the project has
   a `lib/main.dart` with a `main()`. A Flutter package or plugin without an app is not covered: say so and stop.
   A Flutter app also contains `ios/Runner.xcodeproj` and `android/app/build.gradle`: those are Flutter's
   generated shells. Do not treat them as a SwiftUI or Compose app.
2. **Dev dependencies.** Add the two entries above if missing, then `flutter pub get`.
3. **Registry.** Copy `assets/flutter/screens.dart` to `integration_test/scry/screens.dart` and fill it in:
   - Import the app's screens as `package:<pubspec name>/...`.
   - `scryApp(screen)`: the app's own shell, the same `MaterialApp` (or `CupertinoApp` / `.router`) theme,
     locale, text scale and localisation delegates as `main.dart`, so a screenshot looks like the app. If the
     app needs providers (Provider, Riverpod, Bloc, get_it), wrap the screen with fixture overrides here. Do not
     change `lib/` to make a screen easy to build.
   - One `ScryScreen(id, name, kind, file, line, build)` per screen. `id` is stable (a route or type name, never
     a display title; letters, digits, `.`, `_`, `-`). Default: every top-level screen, at most about 10 to start.
     `file` and `line` are where the widget is declared.
4. **Fixtures.** Whatever a screen reads (network, clock, randomness, signed-in user, platform plugins) is
   replaced by a constant in `build`: `DateTime(2026, 1, 1, 9, 41)`, constant lists, `Image.memory` or
   `AssetImage` instead of `Image.network`. Two captures must be identical. Plugin calls throw
   `MissingPluginException` headless and may raise a permission prompt on a device: keep them out of fixtures.
   `test/scry_registry_test.dart` (copied in step 6) fails when `scripts/screens.json` and the registry differ in
   ids, order, name, file or line, or when a listed file is missing. Hand-written file and line drift: run it
   after any edit (`flutter test test/scry_registry_test.dart`).
5. **Screen list.** Write `scripts/screens.json` (`id`, `kind` `screen` or `component`, `title` grouping, `name`,
   `file`, `line`) from the registry, same ids in the same order. Set `kind` to `component` for a widget shown
   alone (it is captured on a full-screen canvas, not a tight crop). The registry test fails if the two lists differ.
6. **Copy the rest** (the three tests, `scry_fonts.dart`, the registry test, the driver, `capture.sh`,
   `make-scf.mjs`), verbatim, then run `flutter test test/scry_registry_test.dart`.
7. **Capture and validate.** Check what exists: `command -v flutter`, `adb devices`, `xcrun simctl list devices
   available`. No `flutter`: stop after writing files, do not claim a capture ran, and list for the user the
   exact commands below. A simulator or emulator exists: run that path. Otherwise run `headless`.
   ```
   bash scripts/capture.sh headless        # or: android | ios
   npx @scrymore/scry-deployer upload .scry/capture --dry-run
   ```
   `--dry-run` needs no key and no project id: run it with none set. Expected (N = registered screens):
   `scf: N/N captured, 0 skipped -> .scry/capture`, then `Bundle valid: N captures, source flutter-golden:other.`
   (`flutter-golden:android` / `flutter-golden:ios` on a device). `scf: 4/5 captured, 1 skipped` or exit code 1
   means a screen did not render: fix it, do not lower the count.
   Emulators and simulators only: the Android path refuses a physical phone (it installs the debug app) unless
   the user sets `ALLOW_PHYSICAL=1`; never set it yourself. The first Android build takes minutes.
8. **Look at the screenshots** in `.scry/capture/images/`: readable text and icons (not black blocks), no debug
   banner, no loading spinner, no permission dialog, no broken-image icon. A valid bundle can hold bad images.
9. **Hand the upload to the user; do not run it**, exactly as in SKILL.md (`SCRY_PROJECT_ID` and `SCRY_API_KEY`
   exported in their own shell, then `npx @scrymore/scry-deployer upload .scry/capture`).

## CI (optional)

Only if the user asks. Copy `assets/flutter/scry-capture-flutter.yml` to `.github/workflows/scry-capture.yml`. It
installs Flutter (pin the app's own version in the `flutter-version:` line), runs `bash scripts/capture.sh headless`
on `ubuntu-latest`, checks the bundle with `npx @scrymore/scry-deployer@0.11.1 upload .scry/capture --dry-run`
(no secret needed), then uploads it. The bundle is platform `other`, shown as "Flutter · Other".

- One secret and one variable, set by the user in the repository settings, never by you: the secret
  `SCRY_API_KEY` and the variable `SCRY_PROJECT_ID`. The key is read by the upload step only.
- Without them (a fork, a fresh clone) the capture and the bundle check still run and the upload step ends green
  with a notice saying it was skipped, so a missing key never turns the run red.
- Push to the default branch only (`branches: [main]`: if the repo's default branch has another name, change that one
  line; the upload step compares the pushed branch with the repo's default branch itself, so there is no second place
  to edit, and a push to a branch that is not the default branch uploads nothing and shows a notice). Never on
  `pull_request` or `pull_request_target`: a pull request, above all one from a fork, must never run in a job that
  can read the key. No `workflow_dispatch`, no `schedule`, no self-hosted runner, `permissions: contents: read`,
  checkout with `persist-credentials: false`, every action pinned to a full commit SHA, the deployer pinned.
- It ships no emulator or simulator job. A device capture on a hosted runner needs an Android emulator action or a
  macOS runner with a booted simulator, a much slower run that has not been tried here: use `capture.sh android` /
  `ios` by hand, or add that job yourself and keep the guards above.
- Status: checked with `actionlint`, the sample's workflow guards and the same steps run locally. It has not run
  on GitHub Actions from this skill; say so.

## Fonts (headless)

`flutter test` draws every glyph as a black block (the "Ahem" test font) until real fonts are loaded.
`test/scry_fonts.dart`, called by `test/scry_capture_test.dart`, loads the SDK's Roboto and MaterialIcons from
`$FLUTTER_ROOT/bin/cache/artifacts/material_fonts` and every family in the app's `FontManifest.json` (the fonts
the app declares under `flutter: fonts:` in `pubspec.yaml`). It then measures "iiii" against "WWWW" in each family: equal widths mean a placeholder font. If the SDK fonts
or a declared family did not load, the run fails with `scry capture: fonts did not load ...`, no screenshots are
written and `capture.sh` stops before building a bundle: never ship screenshots with placeholder blocks.
Package fonts (`packages/<pkg>/<family>` entries in the manifest) are loaded too, and before any capture every
family a registered screen actually draws with (the theme's default and any explicit `fontFamily`) is probed, so a
family that is not bundled fails the run instead of uploading blocks.
Fix: `flutter precache` and declare the app's fonts in `pubspec.yaml`.
A monospace font can be refused although it loaded, because all its letters are equally wide and the probe cannot tell it from a placeholder: the run fails closed, so bundle a proportional font for the capture or say that screen was skipped.
Fonts fetched at run time (the `google_fonts` package's default) cannot load offline: bundle the font files as
assets, or accept that those screens fall back to Roboto, and say which. `SCRY_NO_FONTS=1 bash scripts/capture.sh
headless` skips the loading to prove the guard stops the run; it is a test hook, not an option to offer.

## Release builds stay clean

Everything above lives in `integration_test/`, `test/`, `test_driver/` and `scripts/`, which a release build
never compiles, and nothing imports it from `lib/`. Check it (the sample does) and say you did:
`git diff --stat -- lib/ android/ ios/` is empty, and `git diff pubspec.yaml` touches only `dev_dependencies:`.
To prove it on a release build, `flutter build apk --release` and search the APK's `libapp.so` for `scry`: there is
no hit.

## Common failures

- A blank image on Android: `convertFlutterSurfaceToImage()` must run before the
  first screenshot (the test does it); a customised test must keep it.
- A grey or black band across the top (or bottom) of the Android emulator PNGs: the system bars were not hidden.
  The device test calls `SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersive)` and pumps 500 ms before
  building the screen, so the PNG holds only the app (a screen that draws under the status bar shows its own
  inset band otherwise). A customised test must keep both lines.
- `flutter drive` hangs after the tests start or pass and no PNGs appear (fresh Android emulator). Two separate causes:
  (1) Android's "Viewing full screen" immersive confirmation took focus. `capture.sh android` marks it confirmed before
  the drive (`adb shell settings put secure immersive_mode_confirmations confirmed`) and restores the old value on
  exit; a customised script must keep that line, and on a device run by hand run it once. (2) A brand-new emulator
  keeps doing first-boot work (default roles, package updates) for a minute or two after `sys.boot_completed`; that
  changes the assets configuration, which a manifest `configChanges` cannot absorb, so Android destroys and relaunches
  the app and `flutter drive` stays attached to the dead one. `capture.sh android` waits for the device to settle
  (uptime of at least 150 s, no activity relaunch for 25 s), watches the drive, retries it once on a relaunch, and
  otherwise exits 4 with the likely causes and the retry command. Knobs: `CAPTURE_SETTLE_QUIET`,
  `CAPTURE_SETTLE_UPTIME`, `CAPTURE_SETTLE_MAX`, `CAPTURE_DONE_GRACE`, `CAPTURE_DRIVE_TIMEOUT`,
  `CAPTURE_BOOT_TIMEOUT`, `CAPTURE_RETRIES`. A customised script must keep the settle and the watchdog.
- A test that never ends: the screen has an indeterminate progress indicator or a looping animation and a
  customised test used `pumpAndSettle`. The templates use a fixed `pump(Duration)`; keep it.
- `MissingPluginException`, or a screen that needs the network: the fixture still calls a plugin or `http`.
- `Image.network` shows a broken-image icon headless: use `Image.memory`/`AssetImage` in the fixture.
- `capture.sh ios` stops with `more than one simulator is booted`: it never guesses between simulators. Run
  `xcrun simctl list devices booted`, then `IOS_UDID=<udid> bash scripts/capture.sh ios`; the others are left
  alone. `IOS_UDID is not a booted simulator`: `xcrun simctl boot <udid>` first.
- `flutter drive` on iOS cannot find the simulator: `DEVICE="<name>"` (default `iPhone 16`) must name an
  available simulator; `xcrun simctl list devices available | grep -i iphone`.
- Different pixels on another machine: headless pixels depend on the Flutter version and OS. Pin the version
  (the sample pins 3.47.6) and capture on the same one.

## Known limits

- The device path captures the app surface only: immersive mode hides the status bar and navigation bar (the
  Compose path's `screencap` includes the status bar; the SwiftUI path does not). Say so if the user compares.
- Headless is the same Flutter widgets at 390 x 844 pt: no device safe area, no plugins, no network.
- No widget tree (`structure/`) or source text goes into the bundle. Flutter web and Linux desktop capture are
  not covered. A bundle holds only `scf.json` and images.
- Untested here: apps that need a native plugin on the screens to capture (mock it in the fixture), flavours,
  and Flutter modules embedded in a native app.
