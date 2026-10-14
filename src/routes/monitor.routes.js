'use strict';

const express = require('express');
const { createMonitorController } = require('../controllers/monitor.controller');
const { validateMonitorData } = require('../middlewares/validate-monitor-data.middleware');

function createMonitorRouter(monitorService) {
  const router = express.Router();
  const controller = createMonitorController(monitorService);

  router.post('/', validateMonitorData, controller.receive);

  return router;
}

module.exports = { createMonitorRouter };
