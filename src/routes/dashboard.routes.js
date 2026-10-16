'use strict';

const crypto = require('node:crypto');
const express = require('express');

function matchesToken(actual, expected) {
  if (typeof actual !== 'string' || !actual.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(actual.slice(7));
  const target = Buffer.from(expected);
  return supplied.length === target.length && crypto.timingSafeEqual(supplied, target);
}

function createDashboardRouter({ service, token }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!matchesToken(req.get('authorization'), token)) {
      return res.status(401).json({ ok: false, error: 'Dashboard token required' });
    }
    next();
  });
  router.get('/apps', async (_req, res) => {
    res.json({ ok: true, ...(await service.apps()) });
  });
  router.get('/overview', async (req, res) => {
    res.json({ ok: true, ...(await service.overview({
      appId: req.query.app_id,
      hours: req.query.hours,
    })) });
  });
  return router;
}

module.exports = { createDashboardRouter, matchesToken };
