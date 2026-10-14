'use strict';

function createMonitorController(monitorService) {
  return {
    async receive(req, res) {
      const result = await monitorService.receive(req.monitorData);
      res.status(200).json({ ok: true, ...result });
    },
  };
}

module.exports = { createMonitorController };
