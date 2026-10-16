'use strict';

const { AppError } = require('../utils/app-error');

const ALLOWED_HOURS = new Set([1, 6, 24, 72, 168]);

function number(value) {
  return Number(value || 0);
}

class DashboardService {
  constructor(repository) {
    this.repository = repository;
  }

  async apps() {
    return { apps: await this.repository.findDashboardApps() };
  }

  async overview({ appId, hours }) {
    if (typeof appId !== 'string' || !appId.trim() || appId.length > 128) {
      throw new AppError(400, 'app_id is required and must be at most 128 characters');
    }
    const rangeHours = Number(hours || 24);
    if (!ALLOWED_HOURS.has(rangeHours)) {
      throw new AppError(400, 'hours must be 1, 6, 24, 72, or 168');
    }

    const to = Date.now();
    const from = to - rangeHours * 60 * 60 * 1000;
    const data = await this.repository.findDashboardOverview({
      appId,
      from,
      to,
      bucket: rangeHours <= 24 ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000,
    });
    return {
      appId,
      from,
      to,
      hours: rangeHours,
      summary: {
        pageViews: number(data.behaviorSummary.pageViews),
        visitors: number(data.behaviorSummary.visitors),
        sessions: number(data.behaviorSummary.sessions),
        errors: number(data.errorSummary.errors),
        stabilityIssues: number(data.errorSummary.stabilityIssues),
        requests: number(data.performanceSummary.requests),
        failedRequests: number(data.performanceSummary.failedRequests),
      },
      timeline: data.timeline,
      vitals: data.vitals,
      errorTypes: data.errorTypes,
      issues: data.issues,
      routes: data.routes,
      recentEvents: data.recentEvents,
    };
  }
}

module.exports = { DashboardService, ALLOWED_HOURS };
