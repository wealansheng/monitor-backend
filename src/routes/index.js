'use strict';

const express = require('express');
const { createHealthController } = require('../controllers/health.controller');
const { createMonitorRouter } = require('./monitor.routes');

function createRouter({ monitorService, clickhouseConfig }) {
  const router = express.Router();

  router.get('/', createHealthController(clickhouseConfig));
  router.use('/api/v1/monitor', createMonitorRouter(monitorService));

  return router;
}

module.exports = { createRouter };
