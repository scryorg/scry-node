/**
 * Base class for all custom application errors.
 */
class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error for issues related to file system operations (e.g., zipping).
 */
class FileSystemError extends AppError {
  constructor(message) {
    super(message);
  }
}

/**
 * Error for failures in API communication.
 */
class ApiError extends AppError {
  /**
   * @param {string} message The error message.
   * @param {number} [statusCode] The HTTP status code of the response.
   * @param {string} [requestId] The x-scry-request-id of the failing response, shown as "Ref:".
   */
  constructor(message, statusCode, requestId) {
    super(message);
    this.statusCode = statusCode;
    this.requestId = requestId;
  }
}

/**
 * Error for failures during the file upload process to cloud storage.
 */
class UploadError extends AppError {
  constructor(message) {
    super(message);
  }
}

/**
 * The user's own mistake, with a message that already says how to fix it: a
 * missing or wrong folder, a folder with no images, a required key or env var
 * that was not given. The CLI prints the message and exits 1 like any other
 * error, but it is not a defect in the CLI, so it is never sent to error
 * reporting (it would only spend quota on something we cannot fix).
 */
class UserInputError extends AppError {
  constructor(message) {
    super(message);
  }
}

module.exports = {
  AppError,
  UserInputError,
  FileSystemError,
  ApiError,
  UploadError,
};
