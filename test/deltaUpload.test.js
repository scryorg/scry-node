// Manifest-first upload of a deploy's pictures (content-hash-identity slice 2, PR 6; acceptance rows 11, 12, 13).
// Requests are built from the shared fixture (test/fixtures/deployer-delta); the stub answers with it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getApiClient, uploadMetadataDelta } = require('../lib/apiClient.js');
const { PUT_CONCURRENCY, removeDeltaBundle, locateDeltaBundle } = require('../lib/deltaUpload.js');
const { startDeltaStub } = require('./helpers/deltaStub.js');
const { readFixture, fixturePictures, png, sha256, writeBundle, sbcovManifest } = require('./helpers/deltaFixtures.js');

const API_KEY = 'test-key-not-a-credential';
const TARGET = { project: 'fixture', version: 'pr-12-abc1234' };
const manifestFixture = readFixture('manifest-request.json');
const oids = Object.values(manifestFixture.images).map((i) => i.oid);
// The build the storybook.zip upload created and the provenance the metadata-ZIP path sends: the fixture's own.
const GIT = { commitSha: manifestFixture.commitSha, branch: manifestFixture.branch };
const KNOWN = { buildId: manifestFixture.buildId };

function capture() {
  const lines = [];
  const add = (level) => (m) => lines.push(`${level}: ${m}`);
  return { lines, log: { info: add('info'), warn: add('warn'), error: add('error'), success: add('success'), debug: add('debug') } };
}

describe('delta upload (manifest-first)', () => {
  let dir;
  let stub;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-delta-test-'));
    process.env.SCRY_UPLOAD_BACKOFF_MS = '1';
    delete process.env.SCRY_DELTA;
  });
  afterEach(async () => {
    if (stub) await stub.close();
    stub = null;
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  const run = async (opts = {}, url = null) => {
    stub = await startDeltaStub(opts);
    const { zipPath } = writeBundle(dir);
    const cap = capture();
    const client = getApiClient(url || stub.url, API_KEY);
    const outcome = await uploadMetadataDelta(client, TARGET, zipPath, cap.log, GIT, KNOWN);
    return { outcome, cap, zipPath };
  };

  test('shared fixture: the oids are the sha256 of the pictures, and the manifest request is the fixture', async () => {
    const pics = fixturePictures();
    const manifest = readFixture('manifest-request.json');
    for (const [name, bytes] of Object.entries(pics)) {
      expect(manifest.images[name]).toEqual({ oid: sha256(bytes), size: bytes.length });
    }
    const { outcome } = await run();
    expect(outcome.handled).toBe(true);
    const sent = stub.requests.find((r) => r.path === '/delta/fixture/manifest');
    expect(sent.json).toEqual(manifest); // protocol 1, sha256, version, source, scf, images, buildId, commitSha, branch, transfers
    expect(sent.json.transfers).toEqual(['r2-presigned', 'basic']);
    expect(sent.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(sent.headers['x-api-key']).toBe(API_KEY);
  });

  test('F42: the manifest names the storybook.zip build and carries the same git provenance as the metadata-ZIP path', async () => {
    await run();
    const sent = stub.requests.find((r) => r.path === '/delta/fixture/manifest').json;
    expect(sent.buildId).toBe('build_A_1');
    expect(sent.commitSha).toBe(GIT.commitSha);
    expect(sent.branch).toBe(GIT.branch);
  });

  test('F42: provenance members that are not known are left out of the body, not sent empty', async () => {
    stub = await startDeltaStub();
    const { zipPath } = writeBundle(dir);
    await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, { branch: 'main' }, KNOWN);
    const sent = stub.requests.find((r) => r.path === '/delta/fixture/manifest').json;
    expect(sent.branch).toBe('main');
    expect(sent).not.toHaveProperty('commitSha');
  });

  test('F42: the delta commits to the build it attached to, so one deploy is one build', async () => {
    const { outcome } = await run({ held: new Set(oids) }, null);
    expect(outcome.result).toMatchObject({ success: true, buildId: 'build_A_1' });
    expect(stub.requests.filter((r) => r.path.endsWith('/commit')).map((r) => r.path)).toEqual(['/delta/fixture/builds/build_A_1/commit']);
  });

  test('F42: no build id from the storybook.zip upload -> the ZIP, with a one-line reason, and never a second build', async () => {
    stub = await startDeltaStub();
    const { zipPath } = writeBundle(dir);
    const outcome = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, GIT, {});
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/no build id/);
    expect(outcome.reason).not.toContain('\n');
    expect(stub.requests).toHaveLength(0);
  });

  test('F42: 409 build_not_attachable on the manifest -> the metadata ZIP for the same build (nothing committed, no PUT)', async () => {
    const { outcome } = await run({ manifest: 'attach-refused' });
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/build_not_attachable/);
    expect(outcome.reason).not.toContain('\n');
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /delta/fixture/manifest']);
    expect(stub.failedMarks).toHaveLength(0); // the build is still going to be used by the ZIP
  });

  test('row 11: nothing changed -> 0 PUTs, the build is committed', async () => {
    const { outcome, cap } = await run({ held: new Set(oids) });
    expect(outcome.handled).toBe(true);
    expect(outcome.result).toMatchObject({ success: true, delta: true, queued: true, buildNumber: 1, picturesSent: 0, picturesTotal: 3 });
    expect(stub.puts()).toHaveLength(0);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /delta/fixture/manifest',
      'POST /delta/fixture/builds/build_A_1/commit',
    ]);
    expect(cap.lines).toContain('info: pictures: sent 0 of 3 (0 B), already held 3');
  });

  test('some pictures missing -> only those are PUT, each to the href as given, with the server header', async () => {
    const { outcome, cap } = await run({ held: new Set([oids[0], oids[1]]) });
    expect(outcome.result).toMatchObject({ success: true, picturesSent: 1, picturesTotal: 3 });
    const puts = stub.puts();
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/delta/fixture/blobs/${oids[2]}`);
    expect(puts[0].search).toBe('?build=build_A_1');
    expect(puts[0].headers['content-type']).toBe('application/octet-stream'); // exactly the server's header
    expect(puts[0].headers['x-api-key']).toBe(API_KEY); // same origin as the API
    expect(puts[0].bytes).toBe(400);
    expect(cap.lines.find((l) => l.startsWith('info: pictures: '))).toMatch(/^info: pictures: sent 1 of 3 \(400 B\), already held 2$/);
  });

  test('direct-to-storage links: followed as given; the Scry key and API headers never reach the other origin', async () => {
    const { outcome, cap } = await run({ direct: true });
    expect(outcome.result).toMatchObject({ success: true, picturesSent: 3, bytesSent: 1200 }); // 3 x 400 B, concurrent PUTs all counted
    expect(stub.puts()).toHaveLength(0); // nothing went through the API
    expect(stub.storageRequests).toHaveLength(3);
    for (const r of stub.storageRequests) {
      const oid = /\/([0-9a-f]{64})/.exec(r.url)[1];
      expect(r.headers['x-amz-checksum-sha256']).toBe(Buffer.from(oid, 'hex').toString('base64')); // the header the fixture's R2 links carry
      expect(r.headers['x-api-key']).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers['x-scry-client']).toBeUndefined();
      expect(r.url).toContain('X-Amz-Signature=stub');
    }
    expect(cap.lines.join('\n')).not.toContain('X-Amz-Signature'); // the signed href is never printed
    expect(cap.lines.join('\n')).not.toContain(API_KEY);
  });

  test('a picture PUT that fails with a 5xx is retried (up to 3 retries) and then succeeds', async () => {
    const { outcome, cap } = await run({ putFail: { count: 2, status: 503 } });
    expect(outcome.result.success).toBe(true);
    expect(stub.puts()).toHaveLength(5); // 3 pictures + 2 retries
    expect(cap.lines.some((l) => l.includes('retrying'))).toBe(true);
  });

  test('row 12 / G6: a picture the server never stored -> commit says 409 missing_blobs -> failed result with the request id, no fallback', async () => {
    const { outcome, cap } = await run({ swallowPuts: true });
    expect(outcome.handled).toBe(true);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toMatch(/3 pictures never arrived \(missing_blobs\)/);
    expect(outcome.result.requestId).toBe('req-stub-delta-0001');
    expect(cap.lines.some((l) => l.startsWith('error: Delta upload failed'))).toBe(true);
    // P2-1: the storybook.zip build is marked failed exactly as the ZIP path does it.
    expect(outcome.result).toMatchObject({ markedFailed: true, buildId: 'build_A_1' });
    expect(stub.failedMarks).toEqual([{ buildId: 'build_A_1', reason: expect.stringMatching(/missing_blobs/) }]);
    expect(cap.lines.join('\n')).not.toContain(oids[0]); // a picture hash is never printed
  });

  test('G6: 403 at commit (another project) -> failed result, no fallback', async () => {
    const { outcome } = await run({ commit: 'forbidden' });
    expect(outcome.handled).toBe(true);
    expect(outcome.result).toMatchObject({ success: false, requestId: 'req-stub-delta-0001' });
    expect(outcome.result.error).toMatch(/HTTP 403/);
    expect(outcome.result).toMatchObject({ markedFailed: true, buildId: 'build_A_1' });
  });

  test('F42: commit 422 invalid_picture -> failed result with the request id and the count, build marked failed, no ZIP behind it', async () => {
    const { outcome, cap } = await run({ commit: 'invalid-picture' });
    expect(outcome.handled).toBe(true);
    expect(outcome.result).toMatchObject({ success: false, requestId: 'req-stub-delta-0001', markedFailed: true, buildId: 'build_A_1' });
    expect(outcome.result.error).toMatch(/1 picture/);
    expect(outcome.result.error).toMatch(/invalid_picture/);
    expect(stub.failedMarks).toEqual([{ buildId: 'build_A_1', reason: expect.stringMatching(/invalid_picture/) }]);
    expect(cap.lines.some((l) => l.startsWith('error: Delta upload failed'))).toBe(true);
  });

  test('a commit that cannot be reached is not reported green and not retried as a ZIP', async () => {
    const { outcome } = await run({ commit: 'down' });
    expect(outcome.handled).toBe(true);
    expect(outcome.result.success).toBe(false);
  });

  test('the manifest refusing the key (403) fails the deploy instead of hiding it behind the ZIP path', async () => {
    const { outcome } = await run({ manifest: 'forbidden' });
    expect(outcome.handled).toBe(true);
    expect(outcome.result).toMatchObject({ success: false, requestId: 'req-stub-delta-0001', markedFailed: true, buildId: 'build_A_1' });
  });

  describe('F64: a redirect from the API origin never carries X-API-Key to another host', () => {
    const http = require('http');
    let sink;
    let sinkHits;
    beforeEach(async () => {
      sinkHits = [];
      sink = http.createServer((req, res) => {
        sinkHits.push({ method: req.method, url: req.url, key: req.headers['x-api-key'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      // 127.0.0.2 is a different host name from the stub's 127.0.0.1, so follow-redirects would see a cross-host hop
      await new Promise((resolve) => sink.listen(0, '127.0.0.2', resolve));
    });
    afterEach(async () => {
      await new Promise((resolve) => { sink.close(resolve); sink.closeAllConnections?.(); });
    });
    const sinkUrl = (p) => `http://127.0.0.2:${sink.address().port}${p}`;

    test('302 on the manifest call: the other host sees nothing, and the run falls back to the ZIP path like any delta failure', async () => {
      const { outcome } = await run({ redirect: { route: 'manifest', to: sinkUrl('/steal') } });
      expect(sinkHits).toEqual([]);
      expect(outcome.handled).toBe(false);
      expect(outcome.reason).toMatch(/delta manifest request failed/);
      expect(outcome.reason).not.toContain('\n');
      expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /delta/fixture/manifest']); // one attempt: 302 is not retried
    });

    test('302 on the commit call: the other host sees nothing, and the result is a failure (never green, never a ZIP behind it)', async () => {
      const { outcome } = await run({ held: new Set(oids), redirect: { route: 'commit', to: sinkUrl('/steal') } });
      expect(sinkHits).toEqual([]);
      expect(outcome.handled).toBe(true);
      expect(outcome.result.success).toBe(false);
    });
  });

  describe('row 13: each fallback trigger -> the ZIP path (handled: false, one-line reason, no commit)', () => {
    test.each([
      ['503 delta_disabled', { manifest: 'disabled' }, /delta_disabled/],
      ['404 on /delta', { manifest: 'notfound' }, /HTTP 404/],
      ['400 unsupported_protocol', { manifest: 'bad400' }, /unsupported_protocol/],
      ['5xx after retries', { manifest: 'broken' }, /HTTP 500/],
      ['an object refused alone', { manifest: 'refuse-object' }, /refused a picture \(too_large\)/],
      ['a picture PUT that keeps failing', { putFail: { count: 99, status: 500 } }, /picture could not be sent \(HTTP 500/],
    ])('%s', async (_name, opts, reason) => {
      const { outcome } = await run(opts);
      expect(outcome.handled).toBe(false);
      expect(outcome.reason).toMatch(reason);
      expect(outcome.reason).not.toContain('\n');
      expect(stub.requests.some((r) => r.path.endsWith('/commit'))).toBe(false);
    });

    test('network failure before commit', async () => {
      stub = await startDeltaStub();
      const deadUrl = stub.url;
      await stub.close();
      stub = null;
      const { zipPath } = writeBundle(dir);
      const outcome = await uploadMetadataDelta(getApiClient(deadUrl, API_KEY), TARGET, zipPath, capture().log, GIT, KNOWN);
      expect(outcome.handled).toBe(false);
      expect(outcome.reason).toMatch(/ECONNREFUSED/);
    });

    test('SCRY_DELTA=0 -> no request at all', async () => {
      process.env.SCRY_DELTA = '0';
      const { outcome } = await run();
      expect(outcome).toEqual({ handled: false, reason: 'SCRY_DELTA=0' });
      expect(stub.requests).toHaveLength(0);
    });

    test('no delta manifest from sbcov -> no request at all', async () => {
      stub = await startDeltaStub();
      const zipPath = path.join(dir, 'scry-metadata-none.zip');
      fs.writeFileSync(zipPath, 'zip');
      const outcome = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, GIT, KNOWN);
      expect(outcome).toEqual({ handled: false, reason: 'sbcov wrote no delta manifest' });
      expect(stub.requests).toHaveLength(0);
    });

    test('a picture on disk that is not what the manifest says -> ZIP, before anything is sent', async () => {
      stub = await startDeltaStub();
      const pictures = fixturePictures();
      pictures['images/pic-3.png'] = png(201); // same name, other bytes
      const { zipPath } = writeBundle(dir, { pictures });
      const outcome = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, GIT, KNOWN);
      expect(outcome.handled).toBe(false);
      expect(outcome.reason).toMatch(/does not match its delta manifest/);
      expect(stub.requests).toHaveLength(0);
    });

    test('a picture missing on disk, or a manifest path that escapes the bundle -> ZIP', async () => {
      stub = await startDeltaStub();
      const { zipPath } = writeBundle(dir, { omit: ['images/pic-3.png'] });
      let outcome = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, GIT, KNOWN);
      expect(outcome.reason).toMatch(/missing on disk/);
      const escaping = sbcovManifest();
      escaping.images = { '../../etc/passwd': Object.values(escaping.images)[0] };
      const second = writeBundle(fs.mkdtempSync(path.join(dir, 'x-')), { manifest: escaping });
      outcome = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, second.zipPath, capture().log, GIT, KNOWN);
      expect(outcome.reason).toMatch(/outside its bundle/);
      expect(stub.requests).toHaveLength(0);
    });
  });

  test('an upload address that is neither this API nor https is not followed (the picture and the key stay here)', async () => {
    stub = await startDeltaStub({ direct: true });
    // A plain-http href on a host that is not this machine must fall back, not be followed.
    const { zipPath } = writeBundle(dir);
    const spy = jest.spyOn(require('axios'), 'put');
    const body = readFixture('manifest-response-basic.json');
    body.objects = body.objects.map((o) => ({ ...o, actions: { upload: { ...o.actions.upload, href: 'http://uploads.example.test/blob?sig=secret' } } }));
    const client = getApiClient(stub.url, API_KEY);
    jest.spyOn(client, 'post').mockResolvedValue({ status: 201, data: body });
    const outcome = await uploadMetadataDelta(client, TARGET, zipPath, capture().log, GIT, KNOWN);
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/non-https upload address on another host/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('F42: an upload service that opens a different build than the one named (it ignores buildId) -> the ZIP, never a second build', async () => {
    stub = await startDeltaStub();
    const { zipPath } = writeBundle(dir);
    const client = getApiClient(stub.url, API_KEY);
    jest.spyOn(client, 'post').mockResolvedValue({ status: 201, data: { ...readFixture('manifest-response-basic.json'), buildId: 'build_other_9' } });
    const outcome = await uploadMetadataDelta(client, TARGET, zipPath, capture().log, GIT, KNOWN);
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/different build/);
    expect(stub.requests).toHaveLength(0); // nothing was PUT or committed
  });

  test('at most 8 picture PUTs are in flight at once', async () => {
    const { __runPool } = require('../lib/deltaUpload.js');
    let inFlight = 0;
    let max = 0;
    await __runPool(Array.from({ length: 40 }, (_, i) => i), PUT_CONCURRENCY, async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });
    expect(PUT_CONCURRENCY).toBe(8);
    expect(max).toBe(8);
  });

  test('the bundle sits beside the ZIP and cleanup removes only the delta files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-dt-'));
    try {
      const { zipPath } = writeBundle(dir);
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
      const found = locateDeltaBundle(zipPath);
      expect(found.manifestPath).toBe(path.join(dir, 'delta-manifest.json'));
      expect(found.root).toBe(path.join(dir, 'delta-files'));
      removeDeltaBundle(zipPath);
      expect(fs.existsSync(path.join(dir, 'delta-manifest.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'delta-files'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);
      expect(locateDeltaBundle(zipPath)).toBeNull();
      expect(locateDeltaBundle(null)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a manifest older than the ZIP (left over from another run) is not used', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-dt-'));
    try {
      const { zipPath } = writeBundle(dir);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, 'delta-manifest.json'), old, old);
      stub = await startDeltaStub();
      const r = await uploadMetadataDelta(getApiClient(stub.url, API_KEY), TARGET, zipPath, capture().log, GIT, KNOWN);
      expect(stub.requests).toHaveLength(0);
      expect(r).toEqual({ handled: false, reason: 'the delta manifest is older than the metadata ZIP' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
