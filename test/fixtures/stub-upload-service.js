#!/usr/bin/env node
// A local stand-in for the Scry upload service, for tests and the terminal
// walkthrough. Nothing leaves the machine.
//
//   node test/fixtures/stub-upload-service.js --port 8799 --metadata reject
//
// --metadata ok        metadata archive accepted and queued (build #1)
// --metadata reject    metadata archive rejected with HTTP 500
// --metadata notqueued accepted but not queued
// --metadata hang      metadata POST is read but never answered (client times out)
// --metadata hang-once the first metadata POST hangs, the next is accepted
// --metadata reject400 metadata archive rejected with HTTP 400 (not worth retrying)
// --metadata-rate <B/s> read metadata request bodies at this rate (a slow uplink)
// --ci-timings ok      POST .../builds/:buildId/ci-timings stored (a service with the route)
// --ci-timings missing that route answers 404 (an upload service older than it)
// --ci-timings reject  that route answers 400 with the issue paths
// --ci-timings dropped stored, with ci.workflow dropped by the service
// --ci-timings nobuild that route answers 404 "Build not found" (route exists, build does not)
// --presign none      POST .../metadata/presign answers 404 (an upload service older than it)
// --presign ok        the presigned metadata flow: presign -> PUT /put-meta/<key> -> complete,
//                     and .../metadata/failed marks the build failed (recorded on `failed`)
// --metadata-put reject403 the PUT to the presigned URL answers 403 (not worth retrying)
// --metadata-put hang    the PUT is read but never answered (a stalled uplink: the client must time out)
// --metadata-complete reject400 .../metadata/complete answers 400 (not worth retrying)
// PUT /put-meta/ bodies are counted, never kept (they are 100 MiB and more).
// --actions-api ok        GET /repos/:o/:r/actions/runs/:id/attempts/:n/jobs lists this
//                         job (runner "stub-runner", started 90 s ago); set GITHUB_API_URL
//                         to the stub's url to use it
// --actions-api forbidden that endpoint answers 403 (token without actions: read)
// JSON request bodies are kept on each entry (`json`) so tests can read what was sent.
// Every request is printed as one line, so a reader can see whether a
// metadata archive was sent at all.
const http = require('http');

// --delegate <url>: every /delta/* request is forwarded to that origin (test/helpers/deltaStub.js), so a
// CLI run sees the storybook.zip and metadata routes here and the delta routes there.

function startStub({ port = 0, metadata = 'ok', ciTimings = 'ok', actionsApi = 'ok', metadataRate = 0, presign = 'none', metadataPut = 'ok', metadataComplete = 'ok', log = () => {} , delegate = null } = {}) {
  const requests = [];
  const failed = [];
  let metadataCalls = 0;
  const server = http.createServer((req, res) => {
    if (delegate && req.url.startsWith('/delta/')) {
      requests.push({ method: req.method, path: req.url.split('?')[0], query: req.url.split('?')[1] || '', bytes: 0, delegated: true });
      const forward = http.request(`${delegate}${req.url}`, { method: req.method, headers: req.headers }, (back) => {
        res.writeHead(back.statusCode, back.headers);
        back.pipe(res);
      });
      forward.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(forward);
      return;
    }
    const chunks = [];
    const started = Date.now();
    const throttle = metadataRate > 0 && req.method === 'POST' && /\/metadata(\?|$)/.test(req.url);
    const counted = req.method === 'PUT' && req.url.startsWith('/put-meta/');
    let counter = 0;
    const putHash = counted ? require('crypto').createHash('sha256') : null;
    req.on('data', (c) => {
      if (counted) { counter += c.length; putHash.update(c); return; }
      chunks.push(c);
      if (throttle) {
        // Read no faster than metadataRate: TCP backpressure slows the sender.
        req.pause();
        setTimeout(() => req.resume(), (c.length / metadataRate) * 1000);
      }
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, path: req.url.split('?')[0], query: req.url.split('?')[1] || '', bytes: counted ? counter : body.length, ms: Date.now() - started };
      if (counted) entry.sha256 = putHash.digest('hex'); // what reached storage, byte for byte
      if (/json/.test(String(req.headers['content-type'] || ''))) {
        try { entry.json = JSON.parse(body.toString('utf8')); } catch (_) { entry.json = null; }
      }
      requests.push(entry);
      log(`stub: ${entry.method} ${entry.path} (${entry.bytes} bytes)`);
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const { port: p } = server.address();
      if (req.method === 'POST' && entry.path.startsWith('/presigned-url/')) {
        return send(200, { url: `http://127.0.0.1:${p}/put${entry.path.slice('/presigned-url'.length)}`, buildId: 'stub-build', buildNumber: 1 });
      }
      if (req.method === 'PUT' && entry.path.startsWith('/put/')) return send(200, {});
      if (req.method === 'PUT' && counted) {
        if (metadataPut === 'hang') return undefined; // the PUT is read but never answered
        return metadataPut === 'reject403' ? send(403, { error: 'SignatureDoesNotMatch (stub)' }) : send(200, {});
      }
      const meta = entry.path.match(/^\/upload\/([^/]+)\/([^/]+)\/metadata\/(presign|complete|failed)$/);
      if (req.method === 'POST' && meta && presign === 'ok') {
        const key = `${meta[1]}/${meta[2]}/builds/1/metadata-screenshots.zip`;
        const rid = { 'x-scry-request-id': `stub-req-${meta[3]}-0001` };
        const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', ...rid }); res.end(JSON.stringify(obj)); };
        if (meta[3] === 'presign') return reply(200, { url: `http://127.0.0.1:${p}/put-meta/${key}?sig=stub`, key, buildId: 'stub-build', buildNumber: 1 });
        if (meta[3] === 'failed') { failed.push(entry.json); return reply(200, { success: true, buildNumber: 1 }); }
        if (metadataComplete === 'reject400') return reply(400, { error: 'metadata zip not found (stub)' });
        return reply(200, { success: true, queued: true, buildNumber: 1, zipKey: key });
      }
      if (req.method === 'POST' && /\/coverage$/.test(entry.path)) return send(200, { success: true, buildId: 'stub-build' });
      if (req.method === 'POST' && /\/metadata$/.test(entry.path)) {
        metadataCalls += 1;
        if (metadata === 'hang' || (metadata === 'hang-once' && metadataCalls === 1)) return undefined;
        if (metadata === 'reject400') return send(400, { error: 'Empty body (stub)' });
        if (metadata === 'reject') return send(500, { error: 'metadata store unavailable (stub)' });
        if (metadata === 'notqueued') return send(200, { success: true, queued: false, buildNumber: 1 });
        return send(200, { success: true, queued: true, buildNumber: 1, zipKey: 'stub/metadata.zip' });
      }
      if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(entry.path)) {
        entry.authorization = req.headers.authorization ? 'present' : 'absent';
        if (actionsApi === 'forbidden') return send(403, { message: 'Resource not accessible by integration' });
        const startedAt = new Date(Date.now() - 90000).toISOString();
        return send(200, {
          total_count: 2,
          jobs: [
            { id: 1, name: 'other', status: 'completed', runner_name: 'another-runner', started_at: new Date(Date.now() - 600000).toISOString() },
            { id: 2, name: 'deploy', status: 'in_progress', runner_name: 'stub-runner', started_at: startedAt },
          ],
        });
      }
      if (req.method === 'POST' && /\/builds\/[^/]+\/ci-timings$/.test(entry.path)) {
        if (ciTimings === 'missing') return send(404, { error: 'not found (stub)' });
        if (ciTimings === 'dropped') return send(200, { success: true, buildId: 'stub-build', buildNumber: 1, stored: ['executeMs'], dropped: ['ci.workflow'] });
        if (ciTimings === 'nobuild') return send(404, { error: 'Build not found for this project, version and build id' });
        if (ciTimings === 'reject') return send(400, { error: 'invalid ciTimings', issues: ['executeMs'] });
        return send(200, { success: true, buildId: 'stub-build', buildNumber: 1, stored: Object.keys((entry.json && entry.json.ciTimings) || {}), dropped: [] });
      }
      return send(404, { error: 'not found (stub)' });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, requests, failed, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) });
    });
  });
}

if (require.main === module) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  startStub({ port: Number(arg('--port', '8799')), metadata: arg('--metadata', 'ok'), metadataRate: Number(arg('--metadata-rate', '0')), presign: arg('--presign', 'none'), metadataPut: arg('--metadata-put', 'ok'), metadataComplete: arg('--metadata-complete', 'ok'), ciTimings: arg('--ci-timings', 'ok'), actionsApi: arg('--actions-api', 'ok'), log: (l) => console.log(l) })
    .then((s) => console.log(`stub upload service on ${s.url} (metadata: ${arg('--metadata', 'ok')})`));
}

module.exports = { startStub };
