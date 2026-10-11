const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { createLogger } = require('./logger.js');
const { UserInputError } = require('./errors.js');
const { findImageFiles } = require('./imageUpload.js');
const { sanitizeServerText } = require('./apiClient.js');

/**
 * A provider (OpenAI, Jina, Milvus) error body can quote the request, so it is
 * never printed raw (F113): only a string `error` / `error.message` / `message`
 * / `detail` field, sanitised and capped.
 */
function providerErrorText(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return 'non-JSON error body';
  }
  const pick = [body?.error?.message, body?.error, body?.message, body?.detail].find((v) => typeof v === 'string' && v);
  return pick ? sanitizeServerText(pick) : 'no error message';
}

// ───────────────────────── XML Parsing ─────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
});

function parseXmlToJson(xmlContent) {
  const wrapped = `<root>${xmlContent}</root>`;
  const parsed = xmlParser.parse(wrapped);
  const root = parsed.root || {};

  // Navigate into any wrapper element (e.g. component-documentation)
  const doc = root['component-documentation'] || root;

  const result = {};

  if (doc['screen-name']) result.screenName = String(doc['screen-name']).trim();
  if (doc.description) result.description = String(doc.description).trim();

  if (doc.tags) {
    const rawTags = doc.tags.tag;
    result.tags = Array.isArray(rawTags)
      ? rawTags.map(t => String(t).trim())
      : rawTags ? [String(rawTags).trim()] : [];
  }

  if (doc['search-queries']) {
    const rawQueries = doc['search-queries'].query;
    result.searchQueries = Array.isArray(rawQueries)
      ? rawQueries.map(q => String(q).trim())
      : rawQueries ? [String(rawQueries).trim()] : [];
  }

  return result;
}

function parseBatchXmlResponse(xmlResponse, count) {
  const wrapped = `<root>${xmlResponse}</root>`;
  const parsed = xmlParser.parse(wrapped);
  const root = parsed.root || {};
  const results = [];

  for (let i = 0; i < count; i++) {
    const key = `component-${i + 1}`;
    const component = root[key] || (root['batch-analysis'] && root['batch-analysis'][key]);
    if (!component) {
      results.push({});
      continue;
    }
    // Re-serialize the component back to extract fields
    const result = {};
    if (component['screen-name']) result.screenName = String(component['screen-name']).trim();
    if (component.description) result.description = String(component.description).trim();
    if (component.tags) {
      const rawTags = component.tags.tag;
      result.tags = Array.isArray(rawTags)
        ? rawTags.map(t => String(t).trim())
        : rawTags ? [String(rawTags).trim()] : [];
    }
    if (component['search-queries']) {
      const rawQueries = component['search-queries'].query;
      result.searchQueries = Array.isArray(rawQueries)
        ? rawQueries.map(q => String(q).trim())
        : rawQueries ? [String(rawQueries).trim()] : [];
    }
    results.push(result);
  }

  return results;
}

// ───────────────────────── Prompt ─────────────────────────

const IMAGE_UPLOAD_INSPECTOR_PROMPT = `# UI Screenshot Documentation Instructions

## Overview
You will analyze UI screenshots (mobile app screens, web pages, or other user interface captures) and generate standardized documentation in XML format consisting of a screen name, description, tags, and search queries.

## Input Materials
- **Screenshot**: Visual representation of a UI screen

## Output Format (XML Structure)

\`\`\`xml
<component-documentation>
  <screen-name>
    [Short, descriptive name for this screen, e.g. "Home Feed", "Login Page", "Settings Menu"]
  </screen-name>
  <description>
    [2-3 sentence description following the template below]
  </description>
  <tags>
    <tag>Screen Type</tag>
    <tag>App Category</tag>
    <tag>Visual Descriptor</tag>
    <tag>UI Pattern</tag>
    <tag>Functional Category</tag>
    <!-- 8-15 total tags -->
  </tags>
  <search-queries>
    <query>UI screen type keyword</query>
    <query>Visual description phrase</query>
    <query>User-friendly search phrase</query>
    <query>Functional description</query>
    <query>Design pattern query</query>
    <!-- 5-7 total queries -->
  </search-queries>
</component-documentation>
\`\`\`

## Content Guidelines

### 1. Screen Name (short label)
- A concise, human-readable name for the screen
- Examples: "Home Feed", "Product Detail", "Search Results", "User Profile", "Checkout Flow"

### 2. Description (2-3 sentences)
- **First sentence**: Screen type and primary purpose
- **Second sentence**: Visual characteristics and key UI elements
- **Third sentence** (if needed): Notable features or interaction patterns

**Template**: "This is a [screen type] that [primary function]. It features [key UI elements and visual characteristics]. [Additional notable features]."

### 3. Tags (8-15 keywords)
List relevant tags in this priority order:
1. Screen type (Home, Settings, Profile, etc.)
2. App category (Social, E-commerce, Productivity, etc.)
3. Visual descriptors (colors, layout style)
4. UI patterns (tab bar, card layout, list view, etc.)
5. Functional categories (navigation, content, form, etc.)
6. Platform indicators (iOS, Android, Web)

### 4. Search Queries (5-7 phrases)
Create search-friendly phrases without quotes:
- Include screen type + descriptive terms
- Use common UI/UX terminology
- Consider both technical and casual language
- Include design pattern references

## Quality Standards
- **Accuracy**: Description must match the visual exactly
- **Completeness**: Include all significant visual and functional aspects
- **Consistency**: Use the same terminology and format for similar screens
- **Searchability**: Tags and queries should help users find this screen easily
- **Valid XML**: Ensure all tags are properly closed and content is escaped if needed

Remember: Accuracy and consistency are critical. When in doubt, describe exactly what you see in the screenshot.`;

// ───────────────────────── Batch Processor ─────────────────────────

async function processBatches(items, batchSize, maxConcurrent, processFn, options = {}) {
  if (items.length === 0) return [];

  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  const results = [];
  let batchIndex = 0;
  let completedItems = 0;

  const processBatch = async () => {
    while (batchIndex < batches.length) {
      const currentIndex = batchIndex++;
      const batch = batches[currentIndex];

      if (options.delayMs && currentIndex > 0) {
        await new Promise(resolve => setTimeout(resolve, options.delayMs));
      }

      const batchResults = await processFn(batch);
      results.push(...batchResults);
      completedItems += batch.length;

      if (options.onProgress) {
        options.onProgress(completedItems, items.length);
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrent, batches.length) },
    () => processBatch()
  );
  await Promise.all(workers);

  return results;
}

// ───────────────────────── Vector Utils ─────────────────────────

const DEFAULT_TARGET_DIM = 2048;

function padVector(vector, targetDim) {
  if (!vector || !Array.isArray(vector)) {
    return new Array(targetDim).fill(0);
  }
  if (vector.length === targetDim) return vector;
  if (vector.length > targetDim) return vector.slice(0, targetDim);
  const padded = [...vector];
  while (padded.length < targetDim) padded.push(0);
  return padded;
}

// ───────────────────────── LLM Inspector ─────────────────────────

function createImageBatchPrompt(count) {
  const batchInstructions = `

## Batch Analysis Instructions

You will analyze ${count} UI screenshot(s) in a single request.

**Format your response as:**
\`\`\`xml
<batch-analysis>
  <component-1>
    <screen-name>...</screen-name>
    <description>...</description>
    <tags><tag>...</tag>...</tags>
    <search-queries><query>...</query>...</search-queries>
  </component-1>
  ${count > 1 ? `<component-2>...</component-2>` : ''}
  ${count > 2 ? `<!-- ... up to component-${count} -->` : ''}
</batch-analysis>
\`\`\`

- Component numbers must match the image order exactly (1st image = component-1, etc.)
- Each screenshot must have complete documentation including screen-name
`;

  return IMAGE_UPLOAD_INSPECTOR_PROMPT + batchInstructions;
}

async function batchInspectImages(images, apiKey, options = {}) {
  const model = options.model || 'gpt-5-mini';
  const maxRetries = options.maxRetries ?? 2;

  const batchPrompt = createImageBatchPrompt(images.length);

  const content = [
    {
      type: 'text',
      text: batchPrompt + `\n\nAnalyze these ${images.length} UI screenshots and provide numbered documentation for each.`,
    },
  ];

  for (const image of images) {
    const base64 = image.screenshotBytes.toString('base64');
    const ext = image.filename.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:image/${ext};base64,${base64}`,
        detail: 'high',
      },
    });
  }

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: 1500 * images.length,
          messages: [{ role: 'user', content }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${providerErrorText(errorText)}`);
      }

      const data = await response.json();
      const xmlResponse = data.choices?.[0]?.message?.content;

      if (!xmlResponse) {
        throw new Error('No response content from OpenAI API');
      }

      const parsedComponents = parseBatchXmlResponse(xmlResponse, images.length);

      return parsedComponents.map((parsed, i) => ({
        screenName: parsed.screenName || images[i].filename.replace(/\.[^.]+$/, ''),
        description: parsed.description || '',
        tags: parsed.tags || [],
        searchQueries: parsed.searchQueries || [],
        metadata: {
          imagePath: images[i].screenshotPath,
          model,
          timestamp: new Date().toISOString(),
          batchIndex: i + 1,
        },
      }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[LLM] Image batch inspection attempt ${attempt + 1} failed:`, lastError.message);

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Image batch inspection failed');
}

// ───────────────────────── Searchable Text ─────────────────────────

function createSearchableTextFromImage(inspection) {
  if (!inspection) return '';

  const parts = [
    inspection.screenName || '',
    inspection.description || '',
    ...(inspection.tags || []).map(tag => `${tag} element`),
    ...(inspection.searchQueries || []),
    'mobile app screen',
    'UI screenshot',
    'user interface',
  ];

  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── Embedding Generator ─────────────────────────

async function callJinaEmbeddings(input, apiKey, maxRetries = 4) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.jina.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'jina-embeddings-v4',
          task: 'retrieval.document',
          input,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const is429 = response.status === 429;
        const err = new Error(`Jina API error ${response.status}: ${providerErrorText(errorText)}`);
        if (is429 && attempt < maxRetries) {
          const backoff = 15000 * Math.pow(2, attempt);
          console.warn(`[EMBEDDINGS] Rate limited, waiting ${backoff / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          lastError = err;
          continue;
        }
        throw err;
      }

      const data = await response.json();
      if (!data.data) {
        throw new Error('No embedding data in Jina API response');
      }
      return data.data.map(d => d.embedding);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[EMBEDDINGS] Attempt ${attempt + 1} failed:`, lastError.message);

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Embedding generation failed');
}

const JINA_MODEL_ID = 'jina-embeddings-v4';
const JINA_DIM = 2048;
const GEMINI_MODEL_ID = 'gemini-embedding-2';
const GEMINI_DIM = 1024;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MAX_RETRY_WAIT_MS = 60000;

/** Retry-After (seconds or HTTP date) in ms, or null when absent/unusable. */
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, GEMINI_MAX_RETRY_WAIT_MS) : null;
}

function l2Normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (!norm || Math.abs(norm - 1) <= 1e-3) return vector;
  return vector.map(v => v / norm);
}

/** Document text prefix (gemini-embeddings contract): `title: {name|none} | text: {text}`. */
function geminiDocumentText(componentName, searchableText) {
  return `title: ${componentName || 'none'} | text: ${searchableText}`;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait time before retrying a Gemini response, or null when it is not retryable. */
function geminiRetryWait(response, attempt, maxRetries) {
  const retryable = response.status === 429 || response.status >= 500;
  if (!retryable || attempt >= maxRetries) return null;
  return retryAfterMs(response) ?? 2000 * Math.pow(2, attempt);
}

/** One Gemini call: `{ data }`, or `{ error, wait }` where `wait` is null when not retryable. */
async function geminiOnce(endpoint, body, apiKey, attempt, maxRetries) {
  try {
    const response = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL_ID}:${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (response.ok) return { data: await response.json() };
    const error = new Error(`Gemini API error ${response.status}: ${providerErrorText(await response.text())}`);
    return { error, wait: geminiRetryWait(response, attempt, maxRetries) };
  } catch (error) {
    // Network/parse failure: linear backoff.
    return { error: error instanceof Error ? error : new Error(String(error)), wait: attempt < maxRetries ? 2000 * (attempt + 1) : null };
  }
}

async function callGemini(endpoint, body, apiKey, maxRetries = 4) {
  for (let attempt = 0; ; attempt++) {
    const { data, error, wait } = await geminiOnce(endpoint, body, apiKey, attempt, maxRetries);
    if (data) return data;
    if (wait === null) throw error;
    console.warn(`[EMBEDDINGS] Gemini attempt ${attempt + 1} failed (${error.message}); retrying in ${wait / 1000}s...`);
    await sleep(wait);
  }
}

function geminiRequest(parts) {
  return { model: `models/${GEMINI_MODEL_ID}`, content: { parts }, outputDimensionality: GEMINI_DIM };
}

async function geminiEmbedImages(imageBuffers, apiKey) {
  const out = [];
  for (const buf of imageBuffers) {
    const data = await callGemini('embedContent', geminiRequest([
      { inline_data: { mime_type: 'image/png', data: buf.toString('base64') } },
    ]), apiKey);
    if (!data.embedding?.values) throw new Error('No embedding data in Gemini API response');
    out.push(l2Normalize(data.embedding.values));
  }
  return out;
}

async function geminiEmbedTexts(items, apiKey) {
  const data = await callGemini('batchEmbedContents', {
    requests: items.map(({ name, text }) => geminiRequest([{ text: geminiDocumentText(name, text) }])),
  }, apiKey);
  if (!data.embeddings) throw new Error('No embedding data in Gemini API response');
  return data.embeddings.map(e => l2Normalize(e.values));
}

/**
 * Pick the embedder. A Gemini key wins over a Jina key. Gemini writes 1024-dim rows
 * with `embed_model`; Jina rows stay 2048-dim with no `embed_model` (G1: the two are
 * never mixed in one collection).
 */
function resolveEmbedder(config) {
  if (config.geminiApiKey) {
    return {
      model: GEMINI_MODEL_ID,
      dim: GEMINI_DIM,
      images: (bufs) => geminiEmbedImages(bufs, config.geminiApiKey),
      texts: (items) => geminiEmbedTexts(items, config.geminiApiKey),
    };
  }
  return {
    model: JINA_MODEL_ID,
    dim: JINA_DIM,
    images: (bufs) => callJinaEmbeddings(bufs.map(buf => ({ image: `data:image/png;base64,${buf.toString('base64')}` })), config.jinaApiKey),
    texts: (items) => callJinaEmbeddings(items.map(({ text }) => ({ text })), config.jinaApiKey),
  };
}

/** G1: a Gemini run may only write to a `_g2` collection, a Jina run never to one. */
function assertCollectionMatchesModel(model, collection) {
  const name = collection || '';
  const isG2 = name.endsWith('_g2') || name.includes('_g2_');
  if (model === GEMINI_MODEL_ID && !isG2) {
    throw new Error(`Refusing to write Gemini (1024-dim) vectors to "${collection}": use a g2 collection (e.g. scry_component_snapshots_g2_staging) via --collection or MILVUS_COLLECTION_G2.`);
  }
  if (model === JINA_MODEL_ID && isG2) {
    throw new Error(`Refusing to write Jina (2048-dim) vectors to g2 collection "${collection}": pass --gemini-api-key or use a Jina collection.`);
  }
}

// ───────────────────────── Vector Inserter ─────────────────────────

function transformImageData(image, index, projectId, uploadId, targetDim, embedModel) {
  const timestamp = Date.now();

  return {
    primary_key: crypto.randomUUID(),
    text_embedding: padVector(image.textEmbedding, targetDim),
    image_embedding: padVector(image.imageEmbedding, targetDim),
    ...(embedModel === GEMINI_MODEL_ID ? { embed_model: GEMINI_MODEL_ID } : {}),
    searchable_text: (image.searchableText || '').substring(0, 65535),
    component_name: image.screenName || 'unknown',
    project_id: projectId,
    timestamp,
    json_content: {
      source_type: 'upload',
      uploadId,
      filename: image.filename,
      screenName: image.screenName,
      screenshotPath: image.screenshotPath,
      inspection: image.inspection,
    },
  };
}

async function insertImageVectors(images, projectId, uploadId, milvusConfig, options = {}) {
  const batchSize = options.batchSize || 50;
  const maxRetries = options.maxRetries || 1;
  const targetDim = options.targetDim || DEFAULT_TARGET_DIM;
  let totalInserted = 0;

  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    const records = batch.map((image, idx) => transformImageData(image, i + idx, projectId, uploadId, targetDim, options.embedModel));

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const base = milvusConfig.address.startsWith('https://') || milvusConfig.address.startsWith('http://')
          ? milvusConfig.address
          : `https://${milvusConfig.address}`;
        const url = `${base.replace(/\/+$/, '')}/v2/vectordb/entities/insert`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${milvusConfig.token}`,
          },
          body: JSON.stringify({
            collectionName: milvusConfig.collectionName,
            data: records,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Milvus HTTP error ${response.status}: ${providerErrorText(errorText)}`);
        }

        const result = await response.json();

        if (result.code && result.code !== 0) {
          throw new Error(`Milvus API error (code ${result.code}): ${typeof result.message === 'string' && result.message ? sanitizeServerText(result.message) : 'no error message'}`);
        }

        const insertCount = result.data?.insertCount ?? 0;
        totalInserted += insertCount;
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[MILVUS] Insert attempt ${attempt + 1} failed:`, lastError.message);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (lastError) throw lastError;
  }

  return { insertCount: totalInserted };
}

// ───────────────────────── Orchestrator ─────────────────────────

/**
 * Run the full local image processing pipeline.
 * Replicates the worker processUpload() flow but reads from local disk.
 *
 * @param {object} config
 * @param {string} config.dir - Path to image directory
 * @param {string} config.project - Project identifier
 * @param {string} config.openaiApiKey - OpenAI API key
 * @param {string} [config.geminiApiKey] - Gemini API key (preferred; 1024-dim g2 rows)
 * @param {string} [config.jinaApiKey] - Jina API key (deprecated)
 * @param {string} config.milvusAddress - Milvus/Zilliz endpoint
 * @param {string} config.milvusToken - Milvus/Zilliz auth token
 * @param {string} config.milvusCollection - Milvus collection name
 * @param {boolean} [config.verbose]
 */
async function runLocalImageProcessing(config) {
  const logger = createLogger(config);
  const startTime = Date.now();
  const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  const embedder = resolveEmbedder(config);
  assertCollectionMatchesModel(embedder.model, config.milvusCollection);

  // Generate a local upload ID
  const uploadId = `local-${Date.now()}`;

  logger.info('=== Local Image Processing Pipeline ===');
  logger.info(`Project: ${config.project}`);
  logger.info(`Embedding model: ${embedder.model} (${embedder.dim} dims)`);
  logger.info(`Upload ID: ${uploadId}`);

  // Step 1: Find images
  logger.info('Step 1: Scanning for images...');
  const imageFiles = findImageFiles(config.dir);
  if (imageFiles.length === 0) {
    throw new UserInputError(`No image files (.png, .jpg, .jpeg) found in: ${config.dir}`);
  }
  logger.success(`Found ${imageFiles.length} images (${elapsed()})`);

  // Build image items with file bytes
  const images = imageFiles.map(filePath => {
    const relativePath = path.relative(config.dir, filePath);
    return {
      filename: path.basename(filePath),
      screenshotPath: relativePath,
      screenshotBytes: fs.readFileSync(filePath),
    };
  });

  // Step 2: LLM Vision Inspection
  logger.info(`Step 2: LLM inspection for ${images.length} images (batch=5, concurrency=2)...`);
  const inspectionResults = await processBatches(
    images,
    5,
    2,
    async (batch) => batchInspectImages(batch, config.openaiApiKey),
    {
      delayMs: 2000,
      onProgress: (done, total) => logger.debug(`  LLM inspection: ${done}/${total} images`),
    }
  );
  logger.success(`LLM inspection complete (${elapsed()})`);

  // Step 3: Create searchable text
  logger.info('Step 3: Creating searchable text...');
  const searchableTexts = inspectionResults.map(inspection => createSearchableTextFromImage(inspection));
  logger.success(`Searchable text created (${elapsed()})`);

  // Step 4: Generate image embeddings
  logger.info(`Step 4: Generating image embeddings (batch=3, delay=3s)...`);
  const imageEmbeddings = await processBatches(
    images.map(img => img.screenshotBytes),
    3,
    1,
    async (batch) => embedder.images(batch),
    {
      delayMs: 3000,
      onProgress: (done, total) => logger.debug(`  Image embeddings: ${done}/${total}`),
    }
  );
  logger.success(`Image embeddings complete (${elapsed()})`);

  // Step 5: Generate text embeddings
  logger.info(`Step 5: Generating text embeddings (batch=5, delay=2s)...`);
  const textEmbeddings = await processBatches(
    searchableTexts.map((text, i) => ({ text, name: inspectionResults[i]?.screenName })),
    5,
    1,
    async (batch) => embedder.texts(batch),
    {
      delayMs: 2000,
      onProgress: (done, total) => logger.debug(`  Text embeddings: ${done}/${total}`),
    }
  );
  logger.success(`Text embeddings complete (${elapsed()})`);

  // Step 6: Assemble
  logger.info('Step 6: Assembling processed images...');
  const processedImages = [];
  let failedCount = 0;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const inspection = inspectionResults[i];
    const searchableText = searchableTexts[i];
    const imageEmbedding = imageEmbeddings[i];
    const textEmbedding = textEmbeddings[i];

    if (!inspection || !imageEmbedding || !textEmbedding) {
      failedCount++;
      continue;
    }

    processedImages.push({
      filename: image.filename,
      screenName: inspection.screenName,
      screenshotPath: image.screenshotPath,
      inspection,
      searchableText,
      imageEmbedding,
      textEmbedding,
    });
  }
  logger.success(`Assembled: ${processedImages.length} ok, ${failedCount} failed (${elapsed()})`);

  // Step 7: Insert into Milvus
  if (processedImages.length > 0) {
    logger.info(`Step 7: Inserting ${processedImages.length} vectors into Milvus...`);
    const insertResult = await insertImageVectors(
      processedImages,
      config.project,
      uploadId,
      {
        address: config.milvusAddress,
        token: config.milvusToken,
        collectionName: config.milvusCollection,
      },
      { targetDim: embedder.dim, embedModel: embedder.model }
    );
    logger.success(`Milvus insert complete: ${insertResult.insertCount} records (${elapsed()})`);
  } else {
    logger.info('Step 7: No images to insert into Milvus');
  }

  // Summary
  const status = failedCount === 0
    ? 'completed'
    : processedImages.length > 0
      ? 'partial'
      : 'failed';

  logger.success(`\n=== Processing Complete (${elapsed()}) ===`);
  logger.info(`Status: ${status}`);
  logger.info(`Processed: ${processedImages.length}/${images.length} images`);
  if (failedCount > 0) logger.info(`Failed: ${failedCount} images`);
  logger.info(`Upload ID: ${uploadId}`);

  return {
    uploadId,
    projectId: config.project,
    totalImages: images.length,
    processedImages: processedImages.length,
    failedImages: failedCount,
    status,
  };
}

module.exports = {
  runLocalImageProcessing,
  geminiDocumentText,
  assertCollectionMatchesModel,
  providerErrorText,
};
