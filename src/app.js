'use strict';

const express = require('express');
const { requestDataMiddleware } = require('./middlewares/request-data.middleware');
const { notFoundMiddleware } = require('./middlewares/not-found.middleware');
const { errorMiddleware } = require('./middlewares/error.middleware');
const { createRouter } = require('./routes');

function createApp({ monitorService, config }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestDataMiddleware(config.app.maxBodySize));
  app.use(createRouter({ monitorService, clickhouseConfig: config.clickhouse }));
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}

module.exports = { createApp };
