// A local stand-in for the upload service's /delta routes (+ an optional "R2" origin), answering with
// the shared fixture files (test/fixtures/deployer-delta). Nothing leaves the machine.
//
// options:
//   manifest  'ok' | 'disabled' (503 delta_disabled) | 'notfound' (404) | 'forbidden' (403) | 'bad400' (400 unsupported_protocol)
//             | 'broken' (500 every time) | 'refuse-object' (the first object carries error.code)
//   commit    'verify' (default: 409 missing_blobs unless every oid is held or was PUT) | 'forbidden' (403) | 'always409' | 'down' (500)
//   held      Set of oids the project already holds (no actions.upload for those)
//   direct    true = answer with direct-to-storage links on a second origin, when the request lists r2-presigned
//   putFail   { count, status } = the first `count` PUTs answer `status`
//   swallowPuts true = answer 201 to every PUT but keep nothing (the commit check must then say missing_blobs)
//   wrongOid  true = answer the PUT of the first object with 422 (hash_mismatch)
const http = require('http');
const { readFixture, sha256 } = require('./deltaFixtures.js');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function startDeltaStub({ manifest = 'ok', commit = 'verify', held = new Set(), direct = false, putFail = null, wrongOid = false, swallowPuts = false } = {}) {
  const requests = []; // every request the API origin saw
  const storageRequests = []; // every request the "R2" origin saw
  const received = new Set();
  let putFailures = 0;
  let api;
  let storage;

  const json = (res, status, obj, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-scry-request-id': 'req-stub-delta-0001', ...extra });
    res.end(JSON.stringify(obj));
  };
  const objectsOf = (answer) => answer.objects;

  const storeBlob = async (req, res, oid, sink, okStatus) => {
    const bytes = await readBody(req);
    sink.push({ method: req.method, url: req.url, headers: req.headers, bytes: bytes.length });
    if (putFail && putFailures < putFail.count) {
      putFailures += 1;
      return json(res, putFail.status, { error: 'unavailable (stub)' });
    }
    if (wrongOid && oid === readFixture('manifest-response-basic.json').objects[0].oid) return json(res, 422, { error: 'hash_mismatch', message: 'bytes do not hash to the oid' });
    if (sha256(bytes) !== oid) return json(res, 422, { error: 'hash_mismatch', message: 'bytes do not hash to the oid' });
    received.add(oid);
    return json(res, okStatus, { oid, size: bytes.length });
  };

  storage = await listen(async (req, res) => {
    const oid = (req.url.match(/\/_blobs\/[^/]+\/([0-9a-f]{64})/) || [])[1];
    if (req.method === 'PUT' && oid) return storeBlob(req, res, oid, storageRequests, 200);
    return json(res, 404, { error: 'not found (storage stub)' });
  });
  const storageUrl = `http://127.0.0.1:${storage.address().port}`;

  // eslint-disable-next-line sonarjs/cognitive-complexity -- one route table for a test stub; splitting it would hide the routes
  api = await listen(async (req, res) => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- only a base to parse the path against
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const entry = { method: req.method, path: url.pathname, search: url.search, headers: req.headers, json: null, bytes: body.length };
    if (req.method === 'POST' && body.length) {
      try { entry.json = JSON.parse(body.toString('utf8')); } catch { entry.json = null; }
    }
    requests.push(entry);
    const apiUrl = `http://127.0.0.1:${api.address().port}`;

    if (req.method === 'POST' && /^\/delta\/[^/]+\/manifest$/.test(url.pathname)) {
      if (manifest === 'disabled') return json(res, 503, { error: 'delta_disabled', message: 'switched off' });
      if (manifest === 'notfound') return json(res, 404, { error: 'not found' });
      if (manifest === 'forbidden') return json(res, 403, { error: 'wrong_project', message: 'key of another project' });
      if (manifest === 'bad400') return json(res, 400, { error: 'unsupported_protocol', message: 'use the zip path' });
      if (manifest === 'broken') return json(res, 500, { error: 'internal_error' });
      const useDirect = direct && Array.isArray(entry.json?.transfers) && entry.json.transfers.includes('r2-presigned');
      const answer = readFixture(useDirect ? 'manifest-response-r2.json' : 'manifest-response-basic.json');
      const objects = objectsOf(answer).map((o) => {
        const base = { oid: o.oid, size: o.size };
        if (manifest === 'refuse-object' && o === answer.objects[0]) return { ...base, error: { code: 'too_large', message: 'over 20 MiB' } };
        if (held.has(o.oid)) return base;
        const upload = o.actions.upload;
        const href = useDirect
          ? `${storageUrl}/scry-uploads/_blobs/proj_fixture/${o.oid}?X-Amz-Signature=stub`
          : `${apiUrl}/delta/fixture/blobs/${o.oid}?build=${answer.buildId}`;
        return { ...base, actions: { upload: { ...upload, href } } };
      });
      return json(res, 201, { ...answer, objects });
    }
    const blob = url.pathname.match(/^\/delta\/[^/]+\/blobs\/([0-9a-f]{64})$/);
    if (req.method === 'PUT' && blob) {
      // storeBlob re-reads the body; the body was already consumed above, so answer from the buffer.
      if (putFail && putFailures < putFail.count) { putFailures += 1; return json(res, putFail.status, { error: 'unavailable (stub)' }); }
      if (sha256(body) !== blob[1]) return json(res, 422, { error: 'hash_mismatch', message: 'bytes do not hash to the oid' });
      if (!swallowPuts) received.add(blob[1]);
      return json(res, 201, { oid: blob[1], size: body.length });
    }
    if (req.method === 'POST' && /^\/delta\/[^/]+\/builds\/[^/]+\/commit$/.test(url.pathname)) {
      if (commit === 'forbidden') return json(res, 403, { error: 'wrong_project', message: 'not your build' });
      if (commit === 'down') return json(res, 500, { error: 'internal_error' });
      const all = readFixture('manifest-request.json');
      const missing = Object.values(all.images).map((i) => i.oid).filter((oid) => !held.has(oid) && !received.has(oid));
      if (commit === 'always409' || missing.length) return json(res, 409, { ...readFixture('commit-409.json'), missing: missing.length ? missing : readFixture('commit-409.json').missing });
      return json(res, 202, readFixture('commit-response.json'));
    }
    return json(res, 404, { error: 'not found (stub)' });
  });

  return {
    url: `http://127.0.0.1:${api.address().port}`,
    storageUrl,
    requests,
    storageRequests,
    received,
    puts: () => requests.filter((r) => r.method === 'PUT'),
    close: () => Promise.all([api, storage].map((s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }))),
  };
}

module.exports = { startDeltaStub };
