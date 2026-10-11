const fs = require('fs');
const path = require('path');
const os = require('os');
const { zipDirectory } = require('./archive.js');
const { getApiClient, requestPresignedUrl, putToPresignedUrl } = require('./apiClient.js');
const { createLogger } = require('./logger.js');
const { UserInputError } = require('./errors.js');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Recursively find image files in a directory.
 * Excludes __MACOSX and hidden files.
 *
 * @param {string} dir
 * @returns {string[]} Array of absolute file paths
 */
function findImageFiles(dir) {
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files/dirs and __MACOSX
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Run queue-mode image upload.
 * ZIPs the directory, uploads via presigned URL, signals completion.
 *
 * @param {object} config
 * @param {string} config.dir - Path to image directory
 * @param {string} config.project - Project identifier
 * @param {string} config.apiKey - API key
 * @param {string} config.apiUrl - API base URL
 * @param {boolean} [config.verbose]
 */
async function runQueueImageUpload(config) {
  const logger = createLogger(config);

  // 1. Validate directory and count images
  logger.info('Scanning for images...');
  const imageFiles = findImageFiles(config.dir);
  if (imageFiles.length === 0) {
    throw new UserInputError(`No image files (.png, .jpg, .jpeg) found in: ${config.dir}`);
  }
  logger.success(`Found ${imageFiles.length} images`);

  const zipPath = path.join(os.tmpdir(), `scry-image-upload-${Date.now()}.zip`);

  try {
    // 2. ZIP the directory
    logger.info('Creating ZIP archive...');
    await zipDirectory(config.dir, zipPath);
    const zipSize = fs.statSync(zipPath).size;
    logger.success(`ZIP created: ${(zipSize / 1024 / 1024).toFixed(1)} MB`);
    logger.debug(`ZIP path: ${zipPath}`);

    // 3. Initialize upload — get presigned URL and uploadId
    logger.info('Initializing upload...');
    const apiClient = getApiClient(config.apiUrl, config.apiKey);

    const initResponse = await apiClient.post(
      `/upload-images/${config.project}`,
      { imageCount: imageFiles.length },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const { uploadId, uploadNumber, presignedUrl, zipKey } = initResponse.data;
    logger.info(`Upload #${uploadNumber} initialized (id: ${uploadId})`);
    logger.debug(`Presigned URL received, zipKey: ${zipKey}`);

    // 4. PUT ZIP to presigned URL (stream to avoid loading entire file into memory)
    logger.info('Uploading ZIP to storage...');
    const fileStream = fs.createReadStream(zipPath);
    await putToPresignedUrl(presignedUrl, fileStream, 'application/zip');
    logger.success('ZIP uploaded to storage');

    // 5. Signal completion
    logger.info('Signaling upload complete...');
    await apiClient.post(
      `/upload-images/${config.project}/complete`,
      { uploadId, zipKey },
      { headers: { 'Content-Type': 'application/json' } }
    );

    logger.success(`\nUpload #${uploadNumber} queued for processing (${imageFiles.length} images)`);
    logger.info(`Upload ID: ${uploadId}`);

    return { uploadId, uploadNumber, imageCount: imageFiles.length };
  } finally {
    // 6. Cleanup
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
      logger.debug(`Cleaned up temporary ZIP: ${zipPath}`);
    }
  }
}

module.exports = {
  findImageFiles,
  runQueueImageUpload,
};
