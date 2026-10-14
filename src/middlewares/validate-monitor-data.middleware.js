'use strict';

const { AppError } = require('../utils/app-error');

function validateMonitorData(req, _res, next) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return next(new AppError(400, 'Empty body'));
  }

  req.monitorData = {
    raw: req.body.toString('utf8'),
    bytes: req.body.length,
    contentType: req.get('content-type') || 'application/octet-stream',
    ip: req.ip || '',
    userAgent: req.get('user-agent') || '',
  };

  return next();
}

module.exports = { validateMonitorData };
