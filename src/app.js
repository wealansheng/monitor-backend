'use strict';

const express = require('express');
const { requestDataMiddleware } = require('./middlewares/request-data.middleware');
const { notFoundMiddleware } = require('./middlewares/not-found.middleware');
const { errorMiddleware } = require('./middlewares/error.middleware');
const { createRouter } = require('./routes');
const { createSourceMapRouter } = require('./routes/sourcemap.routes');
const { createDashboardRouter } = require('./routes/dashboard.routes');

function createApp({ monitorService, sourceMapService, dashboardService, config }) {
  const app = express();

  app.disable('x-powered-by');
  if (config.sourceMaps?.token && sourceMapService) {
    app.use(createSourceMapRouter({
      service: sourceMapService,
      token: config.sourceMaps.token,
      maxBodySize: config.sourceMaps.maxBodySize,
    }));
  }
  app.use(requestDataMiddleware(config.app.maxBodySize));
  if (config.dashboard?.token && dashboardService) {
    app.use('/api/v1/dashboard', createDashboardRouter({
      service: dashboardService,
      token: config.dashboard.token,
    }));
  }
  app.use(createRouter({ monitorService, clickhouseConfig: config.clickhouse }));
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = { createApp };
