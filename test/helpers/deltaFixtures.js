// Pictures and wire examples for the manifest-first (delta) upload tests.
//
// The JSON files in test/fixtures/deployer-delta/ are the shared fixture of feature content-hash-identity
// slice 2 (contract: scry-management/features/content-hash-identity/briefs/slice2-contract.md), copied from
// the upload service's recording (README there). Requests in the tests are built from them.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'deployer-delta');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A valid 1x1 PNG; `shade` makes the bytes (so the oid) differ. */
function png(shade) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, shade, shade, shade]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The picture the upload service's own tests use (src/delta/delta.test-support.ts fakePng): a PNG
 * signature and IHDR, deterministic filler instead of pixel data. The fixture oids are its sha256.
 */
function fakePng(seed, width = 64, height = 48, totalBytes = 400) {
  const out = Buffer.alloc(totalBytes);
  let x = seed * 7919 + 13;
  for (let i = 0; i < totalBytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff; // doubles on purpose: byte for byte what the service tests compute
    out[i] = x & 0xff;
  }
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(out, 0);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

/** The pictures the fixture manifest lists, by manifest path. */
function fixturePictures() {
  const manifest = readFixture('manifest-request.json');
  return Object.fromEntries(Object.keys(manifest.images).map((name) => [name, fakePng(Number(/pic-(\d+)/.exec(name)[1]))]));
}

/**
 * Write a delta bundle the way sbcov does: `delta-manifest.json` and `delta-files/<manifest path>`
 * beside the metadata ZIP. Returns where the metadata ZIP would be.
 */
/** What sbcov writes: the fixture request without what only the deployer adds (`transfers`, the build id, the provenance). */
function sbcovManifest() {
  const m = readFixture('manifest-request.json');
  for (const key of ['transfers', 'buildId', 'commitSha', 'branch']) delete m[key];
  return m;
}

function writeBundle(dir, { manifest = null, pictures = fixturePictures(), omit = [] } = {}) {
  const zipPath = path.join(dir, 'scry-metadata-test.zip');
  const root = path.join(dir, 'delta-files');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(zipPath, 'not a real zip: the delta path never opens it');
  const body = manifest || sbcovManifest();
  fs.writeFileSync(path.join(dir, 'delta-manifest.json'), JSON.stringify(body));
  for (const [name, bytes] of Object.entries(pictures)) {
    if (omit.includes(name)) continue;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), bytes);
  }
  return { zipPath, root };
}

module.exports = { sbcovManifest, FIXTURE_DIR, png, fakePng, sha256, readFixture, fixturePictures, writeBundle };
