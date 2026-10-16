'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { AppError } = require('../utils/app-error');

function createSourceMapRouter({ service, token, maxBodySize }) {
  const router = express.Router();
  const authenticate = (req, _res, next) => {
    const provided = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '';
    const expected = Buffer.from(token);
    const actual = Buffer.from(provided);
    if (!provided || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return next(new AppError(401, 'Unauthorized'));
    }
    return next();
  };
  router.post('/api/v1/sourcemaps', authenticate, express.raw({ type: 'application/json', limit: maxBodySize }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'Empty body');
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch { throw new AppError(400, 'Invalid JSON body'); }
    const result = await service.upload(payload);
    res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  });
  router.get('/api/v1/monitor/errors/:eventId/symbolication', authenticate, async (req, res) => {
    const result = await service.symbolicate(req.query.app_id, req.params.eventId);
    res.status(200).json({ ok: true, ...result });
  });
  return router;
}

module.exports = { createSourceMapRouter };
