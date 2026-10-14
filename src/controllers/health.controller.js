'use strict';

function createHealthController({ database, table }) {
  return function health(_req, res) {
    res.status(200).json({
      service: 'monitor service',
      endpoint: 'POST /api/v1/monitor',
      storage: 'ClickHouse',
      table: `${database}.${table}`,
    });
  };
}

module.exports = { createHealthController };
