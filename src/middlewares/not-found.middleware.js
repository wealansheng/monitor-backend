'use strict';

const { AppError } = require('../utils/app-error');

function notFoundMiddleware(_req, _res, next) {
  next(new AppError(404, 'Not Found'));
}

module.exports = { notFoundMiddleware };
