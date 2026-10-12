# deployer-delta fixtures

Recorded by `src/delta/delta.deployer.test.ts` (`RECORD_FIXTURES=1 npx vitest run src/delta/delta.deployer.test.ts`); the test fails when a
committed file is out of date. scry-node copies them to `test/fixtures/deployer-delta/` and builds its requests and fake answers from them.

- `manifest-request.json`: POST /delta/{project}/manifest body, storybook source, `transfers: ["r2-presigned", "basic"]`
- `manifest-response-basic.json`: the answer to the same request with `transfers: ["basic"]` (links to the Scry API, `transfer: "basic"`)
- `manifest-response-r2.json`: the answer when `r2-presigned` is honoured (links to R2 with a signed `x-amz-checksum-sha256` header, `transfer: "r2-presigned"`)
- `commit-request.json` / `commit-response.json`: POST .../commit body and the 202 answer
- `manifest-response-attach-refused.json`: 409 `build_not_attachable` (the `buildId` in the request names a build that cannot take a delta)
- `commit-422.json`: 422 `invalid_picture` (`count`, `request_id`)
- `commit-409.json`: the `missing_blobs` answer (`count`, `missing`, `request_id`); the id is a stand-in, the service mints its own

Pre-change reference (no `transfers`, byte for byte what Scry Sync 0.1.7 gets): `../delta-legacy/manifest-response.json`, recorded from stage `85aa920`.

## Copy in scry-node

Re-copied on 2026-10-12 from scryorg/scry-storybook-upload-service, branch `feat/deployer-delta-r2` at `bdbebdb`
(`git show bdbebdb:test/fixtures/deployer-delta/<file>`); the eight JSON files are byte for byte that commit's (`manifest-request.json` now carries
`buildId`, `commitSha`, `branch`; `manifest-response-attach-refused.json` and `commit-422.json` are new). The pictures behind the oids
are `fakePng(1..3)`, ported byte for byte into `test/helpers/deltaFixtures.js`; `test/deltaUpload.test.js` asserts every oid and size,
so drift fails loudly.
