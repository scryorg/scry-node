// guarantee-8 for scry-management/features/metadata-zip-100mb-limit (Fix 2, sbcov 0.8.0): a metadata
// ZIP whose screenshots are lossless WebP (images/<story>.webp, plus a PNG for a capture over 6 MP)
// goes presign -> PUT -> complete exactly as sbcov wrote it. The deployer never opens, renames,
// re-encodes or filters the images, so what reaches storage is byte-identical to the ZIP on disk.
//
// Driven through the real CLI against the local stub upload service and the fake sbcov in
// WEBP mode (FAKE_SBCOV_WEBP=1: the ZIP layout and manifest of sbcov 0.8.0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDeployerCli } = require('./helpers/runDeployerCli.js');

const FAST = { SCRY_UPLOAD_TIMEOUT_FLOOR_MS: '5000', SCRY_UPLOAD_BACKOFF_MS: '50' };
const put = (r) => r.requests.filter((q) => q.method === 'PUT' && q.path.startsWith('/put-meta/'));

describe('guarantee-8 a WebP metadata ZIP is uploaded unchanged', () => {
  test('presign, PUT, complete in order; the bytes that reach storage are the bytes sbcov wrote; exit 0', async () => {
    const shaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webp-zip-')), 'zip.sha256');
    const r = await runDeployerCli({ presign: 'ok', env: { ...FAST, FAKE_SBCOV_WEBP: '1', FAKE_SBCOV_ZIP_SHA_FILE: shaFile } });
    const order = r.requests
      .filter((q) => /\/metadata(\/|$)/.test(q.path) || q.path.startsWith('/put-meta/'))
      .map((q) => q.path.split('/').pop());
    expect(order).toEqual(['presign', 'metadata-screenshots.zip', 'complete']);
    expect(put(r)).toHaveLength(1);
    expect(put(r)[0].sha256).toBe(fs.readFileSync(shaFile, 'utf8'));
    expect(r.requests.some((q) => q.method === 'POST' && /\/metadata$/.test(q.path))).toBe(false);
    expect(r.out).toContain('Indexing has been queued');
    expect(r.code).toBe(0);
    fs.rmSync(path.dirname(shaFile), { recursive: true, force: true });
  }, 60000);

  test('the deployer does not change the capture arguments it hands to sbcov (no format flag of its own)', async () => {
    const r = await runDeployerCli({ presign: 'ok', env: { ...FAST, FAKE_SBCOV_WEBP: '1' } });
    expect(r.sbcovArgs).not.toContain('--capture-format');
    expect(r.code).toBe(0);
  }, 60000);

  test('an upload service without the presign route still takes a WebP ZIP on the old route, unchanged', async () => {
    const r = await runDeployerCli({ presign: 'none', env: { ...FAST, FAKE_SBCOV_WEBP: '1' } });
    const old = r.requests.filter((q) => q.method === 'POST' && /\/metadata$/.test(q.path));
    expect(old).toHaveLength(1);
    expect(put(r)).toHaveLength(0);
    expect(r.code).toBe(0);
  }, 60000);
});
