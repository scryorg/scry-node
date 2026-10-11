---
"@scrymore/scry-deployer": patch
---

The CLI no longer reports your own mistakes as crashes. A missing or wrong `--dir`, a folder with no `.png`/`.jpg`/`.jpeg` images, and a missing API key or env var for `upload-images --local` print the same message and exit 1 as before, but are no longer sent to error reporting. Real crashes are still reported, and error reporting is now also off when `NODE_ENV=test` or `CI` is set to a true value, in addition to `SCRY_TELEMETRY=0` and `DO_NOT_TRACK=1`. You do not need to do anything.
