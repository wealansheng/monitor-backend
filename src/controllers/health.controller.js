'use strict';

function createHealthController({ database, tables }) {
  return function health(_req, res) {
    res.status(200).json({
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'ClickHouse',
      tables: Object.values(tables).map((table) => `${database}.${table}`),
    });
  };
}

module.exports = { createHealthController };
