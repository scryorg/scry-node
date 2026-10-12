---
"@scrymore/scry-deployer": minor
---

Manifest-first picture upload. When scry-sbcov writes `delta-manifest.json` and `delta-files/` beside the metadata ZIP (`--delta-manifest`), the deployer asks the upload service which pictures it does not hold (`POST /delta/{project}/manifest`, with an `Idempotency-Key` and `transfers: ["r2-presigned","basic"]`), sends only those (8 at a time, up to 3 retries each, the Scry key only to the API's own origin), and commits. It prints `pictures: sent N of M (X MB), already held K`. The metadata ZIP path is used, with a one-line reason, when there is no manifest, the service answers 503 `delta_disabled` or 404, the network fails before the commit, or `SCRY_DELTA=0`. A commit that says pictures are missing, or a 403, ends the deploy red with the request id; it is never reported green. The storybook.zip upload is unchanged.
