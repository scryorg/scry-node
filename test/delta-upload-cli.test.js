// The real CLI against the local stub upload service, with the /delta routes behind it
// (content-hash-identity slice 2; acceptance rows 11, 12, 13). sbcov is the fake one, which writes
// the delta bundle beside its metadata ZIP when it is given --delta-manifest.
const { runDeployerCli } = require('./helpers/runDeployerCli.js');
const { readFixture } = require('./helpers/deltaFixtures.js');

const fixture = readFixture('manifest-request.json');
// The deploy's git provenance comes from the environment here (lib/gitContext.js); the build is the one the stub's storybook.zip presign creates.
const DELTA_ENV = {
  FAKE_SBCOV_DELTA: '1', SCRY_UPLOAD_BACKOFF_MS: '20', SCRY_UPLOAD_TIMEOUT_FLOOR_MS: '5000',
  SCRY_COMMIT_SHA: fixture.commitSha, SCRY_BRANCH: fixture.branch,
};
const STORYBOOK_BUILD = 'stub-build';
const oids = Object.values(fixture.images).map((i) => i.oid);
const metadataZipSent = (r) => r.requests.some((q) => /\/metadata\/presign$/.test(q.path) || q.path.endsWith('/metadata'));

describe('delta upload through the CLI', () => {
  test('row 11: an sbcov that writes the bundle -> manifest, only missing pictures, commit; no metadata ZIP; exit 0', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: DELTA_ENV, delta: { held: new Set([oids[0]]) } });
    expect(r.sbcovArgs).toContain('--delta-manifest');
    const methods = r.deltaRequests.map((q) => `${q.method} ${q.path.replace(/[0-9a-f]{64}/, '<oid>')}`);
    expect(methods).toEqual([
      'POST /delta/fixture/manifest',
      'PUT /delta/fixture/blobs/<oid>',
      'PUT /delta/fixture/blobs/<oid>',
      `POST /delta/fixture/builds/${STORYBOOK_BUILD}/commit`,
    ]);
    expect(r.deltaRequests.filter((q) => q.method === 'PUT')).toHaveLength(2);
    const manifest = r.deltaRequests.find((q) => q.path === '/delta/fixture/manifest').json;
    expect(manifest.version).toBe('main'); // the deploy's own version
    // F42: the pictures attach to the build the storybook.zip upload created, with the same provenance the metadata-ZIP path sends.
    expect(manifest).toMatchObject({ buildId: STORYBOOK_BUILD, commitSha: fixture.commitSha, branch: fixture.branch });
    expect(r.failed).toHaveLength(0);
    expect(r.out).toMatch(/pictures: sent 2 of 3 \(800 B\), already held 1/);
    expect(metadataZipSent(r)).toBe(false);
    expect(r.hostedStorybook).toBe(true);
    expect(r.out).toContain('Indexing has been queued');
    expect(r.code).toBe(0);
  }, 60000);

  test('row 12 / G6: the commit says pictures are missing -> exit 1 with the request id, never green, no ZIP behind it', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: DELTA_ENV, delta: { swallowPuts: true } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOTHING WILL BE INDEXED');
    expect(r.out).toContain('missing_blobs');
    expect(r.out).toContain('Ref: req-stub-delta-0001');
    expect(r.out).not.toContain('Indexing has been queued');
    expect(metadataZipSent(r)).toBe(false);
    // P2-1: the storybook.zip build is marked failed, and the text says so (not "closes by itself").
    expect(r.failed).toEqual([{ buildId: STORYBOOK_BUILD, reason: expect.stringMatching(/missing_blobs/) }]);
    expect(r.out).toContain(`Build ${STORYBOOK_BUILD}`);
    expect(r.out).toContain('is marked failed on the upload service');
    expect(r.out).not.toContain('closes by itself');
  }, 60000);

  test('F42: commit 422 invalid_picture -> exit 1 with the request id and the count, build marked failed, never green', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: DELTA_ENV, delta: { commit: 'invalid-picture' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NOTHING WILL BE INDEXED');
    expect(r.out).toContain('invalid_picture');
    expect(r.out).toMatch(/1 picture/);
    expect(r.out).toContain('Ref: req-stub-delta-0001');
    expect(r.out).not.toContain('Indexing has been queued');
    expect(r.failed).toHaveLength(1);
    expect(metadataZipSent(r)).toBe(false);
  }, 60000);

  test('F42: 409 build_not_attachable on the manifest -> the metadata ZIP for the same build; exit 0, nothing marked failed', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: DELTA_ENV, delta: { manifest: 'attach-refused' } });
    expect(r.out).toMatch(/Delta upload not used \(.*build_not_attachable/);
    expect(r.deltaRequests.map((q) => `${q.method} ${q.path}`)).toEqual(['POST /delta/fixture/manifest']);
    expect(metadataZipSent(r)).toBe(true);
    expect(r.failed).toHaveLength(0);
    expect(r.out).toContain('Indexing has been queued');
    expect(r.code).toBe(0);
  }, 60000);

  test('row 12 / G6: 403 at commit -> exit 1, not a fallback', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: DELTA_ENV, delta: { commit: 'forbidden' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ref: req-stub-delta-0001');
    expect(metadataZipSent(r)).toBe(false);
    expect(r.failed).toHaveLength(1); // P2-1
  }, 60000);

  describe('row 13: every fallback trigger still indexes through the metadata ZIP', () => {
    test.each([
      ['SCRY_DELTA=0 (sbcov is not even asked for the bundle)', { env: { ...DELTA_ENV, SCRY_DELTA: '0' }, delta: {} }, /SCRY_DELTA=0/],
      ['503 delta_disabled', { env: DELTA_ENV, delta: { manifest: 'disabled' } }, /delta_disabled/],
      ['404 on /delta (an upload service without the route)', { env: DELTA_ENV, delta: null }, /HTTP 404/],
      ['an sbcov that wrote no delta manifest', { env: { ...DELTA_ENV, FAKE_SBCOV_DELTA: '0' }, delta: {} }, /sbcov wrote no delta manifest/],
    ])('%s', async (_name, opts, reason) => {
      const r = await runDeployerCli({ presign: 'ok', ...opts });
      expect(r.out).toMatch(/Delta upload not used \(/);
      expect(r.out).toMatch(reason);
      expect(metadataZipSent(r)).toBe(true);
      expect(r.out).toContain('Indexing has been queued');
      expect(r.code).toBe(0);
      if (opts.env.SCRY_DELTA === '0') expect(r.sbcovArgs).not.toContain('--delta-manifest');
    }, 60000);
  });
});
