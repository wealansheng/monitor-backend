'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { DashboardService } = require('../src/services/dashboard.service');

test('聚合查询要求令牌，且校验查询范围', async () => {
  const service = new DashboardService({
    async findDashboardApps() { return [{ appId: 'portal' }]; },
    async findDashboardOverview() {
      return {
        behaviorSummary: { pageViews: '12', visitors: '5', sessions: '6' },
        errorSummary: { errors: '2', stabilityIssues: '1' },
        performanceSummary: { requests: '8', failedRequests: '1' },
        timeline: [], vitals: [], errorTypes: [], issues: [], routes: [], recentEvents: [],
      };
    },
  });
  const app = createApp({
    monitorService: { async receive() {} },
    dashboardService: service,
    config: {
      app: { maxBodySize: '5mb' },
      dashboard: { token: 'secret-token' },
      clickhouse: { database: 'weils_monitor', tables: {} },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1/dashboard`;
  try {
    const unauthorized = await fetch(`${base}/apps`);
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${base}/overview?app_id=portal&hours=2`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(invalid.status, 400);
    const response = await fetch(`${base}/overview?app_id=portal&hours=24`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.summary.pageViews, 12);
    assert.equal(data.summary.errors, 2);
    assert.equal(data.hours, 24);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
