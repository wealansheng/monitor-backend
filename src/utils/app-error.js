'use strict';

class AppError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.expose = options.expose !== false;
  }
}

module.exports = { AppError };
