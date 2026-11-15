#!/usr/bin/env bash
# Drift check: the skill's assets/ are copies of the Kettle sample apps (the sample apps are canonical).
# Usage: bash scripts/check-skill-sync.sh <scry-sample-ios dir> <scry-sample-android dir> <scry-sample-flutter dir>
# Exit 0 = every copy matches its sample and the CI templates keep the G5 guards; 1 = drift (diff shown).
# The Flutter sample is the third argument; for the Flutter copies of make-scf.mjs (the sample's, iOS's and
# Android's) the rule is byte-identical to the skill asset (feature flutter-capture, guarantee 6); see the end.
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <ios-sample-dir> <android-sample-dir> <flutter-sample-dir>" >&2; exit 2; }
IOS="$1"; AND="$2"; FLU="$3"
ASSETS="$(cd "$(dirname "$0")/../skills/scry-native-capture-setup/assets" && pwd)"
AK="$AND/app/src"; fail=0

check() { # <asset> <sample file>
  if [ ! -f "$2" ]; then echo "MISSING sample file: $2"; fail=1
  elif diff -u "$2" "$ASSETS/$1" >"${TMPDIR:-/tmp}/skill-sync.diff"; then echo "ok     $1 == $2"
  else echo "DRIFT  $1 differs from $2"; cat "${TMPDIR:-/tmp}/skill-sync.diff"; fail=1; fi
}
check ScryLaunch.swift        "$IOS/Kettle/ScryLaunch.swift"
check ScryScreens.swift       "$IOS/Kettle/ScryScreens.swift"
check capture-ios.sh          "$IOS/scripts/capture.sh"
check make-scf.mjs            "$IOS/scripts/make-scf.mjs"
check scry-capture-ios.yml    "$IOS/.github/workflows/scry-capture.yml"
check ScryLaunch.kt           "$(ls "$AK"/debug/java/*/*/*/ScryLaunch.kt 2>/dev/null | head -1)"
check ScryScreens.kt          "$(ls "$AK"/debug/java/*/*/*/ScryScreens.kt 2>/dev/null | head -1)"
check ScryLaunch-release.kt   "$(ls "$AK"/release/java/*/*/*/ScryLaunch.kt 2>/dev/null | head -1)"
check capture-android.sh      "$AND/scripts/capture.sh"
check scry-capture-android.yml "$AND/.github/workflows/scry-capture.yml"

# Flutter (the sample is canonical for logic; screens.dart and screens.json are templates the user fills in, so
# they only have to exist in both places).
F="$ASSETS/flutter"
check flutter/scry_capture_test.dart          "$FLU/integration_test/scry_capture_test.dart"
check flutter/test_driver_integration_test.dart "$FLU/test_driver/integration_test.dart"
check flutter/headless_scry_capture_test.dart "$FLU/test/scry_capture_test.dart"
check flutter/capture.sh                      "$FLU/scripts/capture.sh"
check flutter/scry_fonts.dart                 "$FLU/test/scry_fonts.dart"
check flutter/scry_registry_test.dart         "$FLU/test/scry_registry_test.dart"
for t in screens.dart screens.json; do [ -f "$F/$t" ] && echo "ok     flutter/$t template present" || { echo "MISSING flutter/$t template"; fail=1; }; done
[ -f "$FLU/integration_test/scry/screens.dart" ] && [ -f "$FLU/scripts/screens.json" ] \
  && echo "ok     Flutter sample has its registry and screens.json" || { echo "MISSING Flutter sample registry or screens.json"; fail=1; }
check make-scf.mjs                            "$FLU/scripts/make-scf.mjs"
# make-scf.mjs is shared and must be byte-identical in the skill and all three samples (the iOS copy is checked above).
check make-scf.mjs                            "$AND/scripts/make-scf.mjs"

# G5 on the CI templates: default branch only, no pull_request(_target), no self-hosted, key only on upload.
for y in scry-capture-ios.yml scry-capture-android.yml flutter/scry-capture-flutter.yml; do
  f="$ASSETS/$y"
  grep -Eq '^\s*(pull_request|pull_request_target)\s*:' "$f" && { echo "G5 FAIL $y: pull_request trigger"; fail=1; }
  grep -qi 'self-hosted' "$f" && { echo "G5 FAIL $y: self-hosted"; fail=1; }
  grep -q 'branches: \[main\]' "$f" || { echo "G5 FAIL $y: not limited to a branch"; fail=1; }
  n="$(grep -c 'secrets\.' "$f")"; [ "$n" -eq 1 ] || { echo "G5 FAIL $y: secrets referenced $n times (want 1, the upload step)"; fail=1; }
done
# The Flutter template is headless-only and must not fail red without credentials (F68): every action is pinned to a
# full commit SHA, the deployer is pinned, the checkout drops its credentials, the upload step is gated on the
# default branch and skips with a notice when SCRY_API_KEY / SCRY_PROJECT_ID are missing. test/skill-flutter-ci-template.test.js
# runs the full rule set (with broken copies) in jest.
y="$ASSETS/flutter/scry-capture-flutter.yml"
if [ -f "$y" ]; then
  code="$(grep -v '^[[:space:]]*#' "$y")"
  bad_uses="$(echo "$code" | grep -E '^\s*-?\s*uses:' | grep -Ev 'uses:\s*[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}\s+# v[0-9]' || true)"
  [ -z "$bad_uses" ] || { echo "G5 FAIL flutter-ci: action not pinned to a full SHA with a version comment: $bad_uses"; fail=1; }
  echo "$code" | grep -q 'persist-credentials: false' || { echo "G5 FAIL flutter-ci: checkout keeps credentials"; fail=1; }
  echo "$code" | grep -qF "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)" || { echo "G5 FAIL flutter-ci: upload not gated on the default branch"; fail=1; }
  echo "$code" | grep -qF "github.ref != format('refs/heads/{0}', github.event.repository.default_branch)" || { echo "G5 FAIL flutter-ci: no notice step for a push to a branch that is not the default branch"; fail=1; }
  echo "$code" | grep -q '::notice ' || { echo "G5 FAIL flutter-ci: no skip notice for missing credentials"; fail=1; }
  echo "$code" | grep -Eq 'capture\.sh headless' || { echo "G5 FAIL flutter-ci: not headless"; fail=1; }
  [ "$(echo "$code" | grep -c 'scry-deployer@0.11.1')" -eq 2 ] || { echo "G5 FAIL flutter-ci: deployer not pinned to 0.11.1 on both steps"; fail=1; }
else
  echo "MISSING flutter/scry-capture-flutter.yml"; fail=1
fi
[ "$fail" -eq 0 ] && echo "PASS: skill assets match the samples, CI guards intact" || { echo "FAIL: drift found" >&2; exit 1; }
