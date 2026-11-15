---
"@scrymore/scry-deployer": patch
---

`scry-deployer upload DIR` is faster on a folder that `capture web` just made. After capture validates its bundle it leaves a small record next to the folder (not inside it). If upload finds the folder exactly as capture left it (same files, sizes, times, scf.json, deployer and validator version) it skips its second validation and says so in the log. Anything else (no record, any change, another tool's folder, `--include-source`) runs the full validation as before, and the new `--validate` flag forces it. What is uploaded does not change. Upload also stores PNG images in the zip instead of compressing them again, which saves zip time at the cost of a slightly larger file.
