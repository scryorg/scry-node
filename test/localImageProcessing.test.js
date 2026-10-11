const { spawnSync } = require('child_process');
const { runLocalImageProcessing, geminiDocumentText, assertCollectionMatchesModel } = require('../lib/localImageProcessing');
const fixture = require('./fixtures/gemini-embed-requests.json');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock global fetch for all API calls
const originalFetch = global.fetch;

describe('runLocalImageProcessing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-local-test-'));
    // Create test images
    fs.writeFileSync(path.join(tmpDir, 'home.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(tmpDir, 'settings.jpg'), Buffer.from([255, 216, 255]));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when directory has no images', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scry-empty-'));
    fs.writeFileSync(path.join(emptyDir, 'readme.txt'), 'text');

    await expect(runLocalImageProcessing({
      dir: emptyDir,
      project: 'test',
      openaiApiKey: 'sk-test',
      jinaApiKey: 'jina-test',
      milvusAddress: 'https://milvus.test',
      milvusToken: 'tok',
      milvusCollection: 'col',
    })).rejects.toThrow('No image files');

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('runs the full local pipeline end-to-end', async () => {
    const fetchCalls = [];

    global.fetch = jest.fn(async (url, options) => {
      fetchCalls.push({ url, method: options?.method || 'GET' });

      // OpenAI vision API
      if (url === 'https://api.openai.com/v1/chat/completions') {
        const body = JSON.parse(options.body);
        const imageCount = body.messages[0].content.filter(c => c.type === 'image_url').length;
        let components = '';
        for (let i = 1; i <= imageCount; i++) {
          components += `<component-${i}>
            <screen-name>Screen ${i}</screen-name>
            <description>A test screen ${i}.</description>
            <tags><tag>Test</tag><tag>UI</tag></tags>
            <search-queries><query>test screen ${i}</query></search-queries>
          </component-${i}>`;
        }

        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: `<batch-analysis>${components}</batch-analysis>`,
              },
            }],
          }),
        };
      }

      // Jina embeddings API
      if (url === 'https://api.jina.ai/v1/embeddings') {
        const body = JSON.parse(options.body);
        const embeddings = body.input.map(() => ({
          embedding: new Array(1024).fill(0.5),
        }));
        return {
          ok: true,
          json: async () => ({ data: embeddings }),
        };
      }

      // Milvus insert API
      if (url.includes('/v2/vectordb/entities/insert')) {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: { insertCount: body.data.length },
          }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await runLocalImageProcessing({
      dir: tmpDir,
      project: 'test-project',
      openaiApiKey: 'sk-test',
      jinaApiKey: 'jina-test',
      milvusAddress: 'https://milvus.test',
      milvusToken: 'tok',
      milvusCollection: 'my-collection',
      verbose: false,
    });

    expect(result.projectId).toBe('test-project');
    expect(result.totalImages).toBe(2);
    expect(result.processedImages).toBe(2);
    expect(result.failedImages).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.uploadId).toMatch(/^local-/);

    // Verify API calls happened
    const openaiCalls = fetchCalls.filter(c => c.url.includes('openai'));
    const jinaCalls = fetchCalls.filter(c => c.url.includes('jina'));
    const milvusCalls = fetchCalls.filter(c => c.url.includes('milvus'));

    expect(openaiCalls.length).toBeGreaterThanOrEqual(1);
    expect(jinaCalls.length).toBeGreaterThanOrEqual(2); // image + text embeddings
    expect(milvusCalls.length).toBeGreaterThanOrEqual(1);

    // Verify Milvus insert data
    const milvusCall = fetchCalls.find(c => c.url.includes('milvus'));
    expect(milvusCall).toBeTruthy();
  });

  it('includes source_type upload in Milvus records', async () => {
    let milvusBody = null;

    global.fetch = jest.fn(async (url, options) => {
      if (url === 'https://api.openai.com/v1/chat/completions') {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: `<batch-analysis>
                  <component-1><screen-name>Home</screen-name><description>Home screen.</description><tags><tag>Home</tag></tags><search-queries><query>home</query></search-queries></component-1>
                  <component-2><screen-name>Settings</screen-name><description>Settings screen.</description><tags><tag>Settings</tag></tags><search-queries><query>settings</query></search-queries></component-2>
                </batch-analysis>`,
              },
            }],
          }),
        };
      }

      if (url === 'https://api.jina.ai/v1/embeddings') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            data: body.input.map(() => ({ embedding: new Array(1024).fill(0.1) })),
          }),
        };
      }

      if (url.includes('/v2/vectordb/entities/insert')) {
        milvusBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ code: 0, data: { insertCount: milvusBody.data.length } }),
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await runLocalImageProcessing({
      dir: tmpDir,
      project: 'proj',
      openaiApiKey: 'sk-test',
      jinaApiKey: 'jina-test',
      milvusAddress: 'https://milvus.test',
      milvusToken: 'tok',
      milvusCollection: 'col',
    });

    expect(milvusBody).toBeTruthy();
    expect(milvusBody.collectionName).toBe('col');
    expect(milvusBody.data).toHaveLength(2);

    for (const record of milvusBody.data) {
      expect(record.json_content.source_type).toBe('upload');
      expect(record.text_embedding).toHaveLength(2048);
      expect(record.image_embedding).toHaveLength(2048);
      expect(record.project_id).toBe('proj');
    }

    expect(milvusBody.data[0].component_name).toBe('Home');
    expect(milvusBody.data[1].component_name).toBe('Settings');
  });

  describe('Gemini embeddings (gemini-embeddings contract)', () => {
    const openaiOk = () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `<batch-analysis>
          <component-1><screen-name>Home</screen-name><description>Home screen.</description><tags><tag>Home</tag></tags><search-queries><query>home</query></search-queries></component-1>
          <component-2><screen-name>Settings</screen-name><description>Settings screen.</description><tags><tag>Settings</tag></tags><search-queries><query>settings</query></search-queries></component-2>
        </batch-analysis>` } }],
      }),
    });
    const unit = (n) => { const v = new Array(n).fill(0); v[0] = 1; return v; };
    const baseConfig = () => ({
      dir: tmpDir, project: 'proj', openaiApiKey: 'sk-test',
      milvusAddress: 'https://milvus.test', milvusToken: 'tok',
    });

    function installFetch({ geminiHandler } = {}) {
      const calls = { gemini: [], milvus: [], jina: 0 };
      global.fetch = jest.fn(async (url, options) => {
        if (url === 'https://api.openai.com/v1/chat/completions') return openaiOk();
        if (url.startsWith('https://generativelanguage.googleapis.com/')) {
          const call = { url, headers: options.headers, body: JSON.parse(options.body) };
          calls.gemini.push(call);
          if (geminiHandler) {
            const r = geminiHandler(call, calls.gemini.length);
            if (r) return r;
          }
          if (url.endsWith(':batchEmbedContents')) {
            return { ok: true, json: async () => ({ embeddings: call.body.requests.map(() => ({ values: unit(1024) })) }) };
          }
          return { ok: true, json: async () => ({ embedding: { values: unit(1024) } }) };
        }
        if (url.includes('jina')) { calls.jina++; }
        if (url.includes('/v2/vectordb/entities/insert')) {
          const body = JSON.parse(options.body);
          calls.milvus.push(body);
          return { ok: true, json: async () => ({ code: 0, data: { insertCount: body.data.length } }) };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      return calls;
    }

    it('sends the canonical request shapes from the shared fixture', async () => {
      const calls = installFetch();
      await runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'AIza-test', milvusCollection: 'scry_component_snapshots_g2_staging' });

      const docText = fixture.requests.document_text;
      const docImage = fixture.requests.document_image;
      const textCall = calls.gemini.find(c => c.url === docText.url);
      const imageCall = calls.gemini.find(c => c.url === docImage.url);
      expect(textCall).toBeTruthy();
      expect(imageCall).toBeTruthy();

      // Header auth, never a query param.
      expect(textCall.headers['x-goog-api-key']).toBe('AIza-test');
      expect(calls.gemini.every(c => !c.url.includes('key='))).toBe(true);

      // Text: batchEmbedContents, prefix + 1024 dims, same request shape as the fixture.
      expect(Object.keys(textCall.body)).toEqual(Object.keys(docText.body));
      const first = textCall.body.requests[0];
      expect(Object.keys(first)).toEqual(Object.keys(docText.body.requests[0]));
      expect(first.model).toBe(docText.body.requests[0].model);
      expect(first.outputDimensionality).toBe(docText.body.requests[0].outputDimensionality);
      expect(Object.keys(first.content.parts[0])).toEqual(['text']);
      expect(textCall.body.requests[0].content.parts[0].text).toMatch(/^title: Home \| text: .*home/);
      expect(textCall.body.requests[1].content.parts[0].text).toMatch(/^title: Settings \| text: /);

      // Image: embedContent, inline_data, no prefix, same keys as the fixture.
      const imgPart = imageCall.body.content.parts[0];
      expect(Object.keys(imageCall.body)).toEqual(Object.keys(docImage.body));
      expect(Object.keys(imgPart)).toEqual(['inline_data']);
      expect(imgPart.inline_data.mime_type).toBe('image/png');
      expect(imageCall.body.model).toBe(docImage.body.model);
      expect(imageCall.body.outputDimensionality).toBe(1024);
      expect(imageCall.body).not.toHaveProperty('taskType');
      expect(calls.jina).toBe(0);
    });

    it('builds the fixture document text exactly', () => {
      const [a, b] = fixture.requests.document_text.body.requests.map(r => r.content.parts[0].text);
      expect(geminiDocumentText('Button', 'A blue primary button with rounded corners')).toBe(a);
      expect(geminiDocumentText(undefined, 'A login form with an email field')).toBe(b);
    });

    it('writes 1024-dim rows with embed_model to the g2 collection', async () => {
      const calls = installFetch();
      const result = await runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'AIza-test', milvusCollection: 'scry_component_snapshots_g2_staging' });
      expect(result.status).toBe('completed');
      expect(calls.milvus).toHaveLength(1);
      expect(calls.milvus[0].collectionName).toBe('scry_component_snapshots_g2_staging');
      for (const row of calls.milvus[0].data) {
        expect(row.embed_model).toBe('gemini-embedding-2');
        expect(row.text_embedding).toHaveLength(1024);
        expect(row.image_embedding).toHaveLength(1024);
      }
    });

    it('normalises a non-unit vector defensively', async () => {
      const calls = installFetch({
        geminiHandler: (call) => call.url.endsWith(':embedContent')
          ? { ok: true, json: async () => ({ embedding: { values: [3, 4, ...new Array(1022).fill(0)] } }) }
          : null,
      });
      await runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'k', milvusCollection: 'c_g2' });
      const norm = Math.sqrt(calls.milvus[0].data[0].image_embedding.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('honours Retry-After on 429 and then succeeds', async () => {
      jest.useFakeTimers();
      try {
        const calls = installFetch({
          geminiHandler: (call, n) => n === 1
            ? { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '7' : null) }, text: async () => '{"error":{"message":"quota"}}' }
            : null,
        });
        const spy = jest.spyOn(global, 'setTimeout');
        const p = runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'k', milvusCollection: 'c_g2' });
        for (let i = 0; i < 200; i++) { await jest.advanceTimersByTimeAsync(1000); }
        const result = await p;
        expect(result.status).toBe('completed');
        expect(spy.mock.calls.some(([, ms]) => ms === 7000)).toBe(true);
        expect(calls.gemini.length).toBeGreaterThan(1);
        spy.mockRestore();
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not retry a 400 and never echoes the request body', async () => {
      installFetch({
        geminiHandler: () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => '{"error":{"message":"bad request"}}' }),
      });
      await expect(runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'k', milvusCollection: 'c_g2' }))
        .rejects.toThrow('Gemini API error 400: bad request');
      expect(global.fetch.mock.calls.filter(([u]) => u.includes('generativelanguage'))).toHaveLength(1);
    });

    it('G1: refuses a Gemini run against a Jina collection before any embedding call', async () => {
      const calls = installFetch();
      await expect(runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'k', milvusCollection: 'scry_component_snapshots' }))
        .rejects.toThrow(/Refusing to write Gemini/);
      expect(calls.gemini).toHaveLength(0);
      expect(calls.milvus).toHaveLength(0);
    });

    it('G1: refuses a Jina run against a g2 collection', async () => {
      const calls = installFetch();
      await expect(runLocalImageProcessing({ ...baseConfig(), jinaApiKey: 'j', milvusCollection: 'scry_component_snapshots_g2' }))
        .rejects.toThrow(/Refusing to write Jina/);
      expect(calls.milvus).toHaveLength(0);
    });

    it('assertCollectionMatchesModel accepts matching pairs', () => {
      expect(() => assertCollectionMatchesModel('gemini-embedding-2', 'scry_component_snapshots_g2')).not.toThrow();
      expect(() => assertCollectionMatchesModel('gemini-embedding-2', 'scry_component_snapshots_g2_staging')).not.toThrow();
      expect(() => assertCollectionMatchesModel('jina-embeddings-v4', 'scry_component_snapshots_staging')).not.toThrow();
      expect(() => assertCollectionMatchesModel('gemini-embedding-2', 'scry_component_snapshots_staging')).toThrow();
    });

    it('a Gemini key wins over a Jina key and Jina is not called', async () => {
      const calls = installFetch();
      await runLocalImageProcessing({ ...baseConfig(), geminiApiKey: 'g', jinaApiKey: 'j', milvusCollection: 'c_g2' });
      expect(calls.jina).toBe(0);
      expect(calls.gemini.length).toBeGreaterThan(0);
    });
  });

  describe('CLI flags', () => {
    const cli = path.join(__dirname, '..', 'bin', 'cli.js');
    const run = (extra, env = {}) => spawnSync(process.execPath, [
      cli, 'upload-images', '--dir', tmpDir, '--project', 'p', '--local',
      '--openai-api-key', 'sk', '--milvus-address', 'https://m.test', '--milvus-token', 't', ...extra,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), SCRY_TELEMETRY: '0', ...env } });

    beforeEach(() => {
      // No real images: the run fails at "No image files" after key/collection validation, before any network call.
      for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f));
    });

    it('--jina-api-key prints exactly one deprecation warning and still works', () => {
      const r = run(['--jina-api-key', 'j', '--milvus-collection', 'col']);
      const warnings = (r.stderr.match(/\[deprecated\]/g) || []).length;
      expect(warnings).toBe(1);
      expect(r.stderr + r.stdout).toMatch(/No image files/);
    });

    it('--gemini-api-key prints no deprecation warning and accepts --collection', () => {
      const r = run(['--gemini-api-key', 'g', '--collection', 'scry_component_snapshots_g2_staging']);
      expect(r.stderr).not.toMatch(/deprecated/);
      expect(r.stderr + r.stdout).toMatch(/No image files/);
    });

    it('GEMINI_API_KEY + MILVUS_COLLECTION_G2 env work; MILVUS_COLLECTION alone is not used for Gemini', () => {
      const ok = run([], { GEMINI_API_KEY: 'g', MILVUS_COLLECTION_G2: 'c_g2' });
      expect(ok.stderr + ok.stdout).toMatch(/No image files/);
      const leak = run([], { GEMINI_API_KEY: 'g', MILVUS_COLLECTION: 'scry_component_snapshots' });
      expect(leak.status).not.toBe(0);
      expect(leak.stderr + leak.stdout).toMatch(/MILVUS_COLLECTION_G2/);
    });
  });
});
