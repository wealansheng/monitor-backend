'use strict';

const { randomUUID } = require('node:crypto');

function formatClickHouseDateTime(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function normalizePayload(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

class MonitorService {
  constructor(repository) {
    this.repository = repository;
  }

  async receive(data) {
    const eventId = randomUUID();
    const event = {
      event_id: eventId,
      received_at: formatClickHouseDateTime(new Date()),
      content_type: data.contentType,
      source_ip: data.ip,
      user_agent: data.userAgent,
      payload: normalizePayload(data.raw),
      payload_size: data.bytes,
    };

    await this.repository.insert(event);

    return {
      eventId,
      bytes: data.bytes,
    };
  }
}

module.exports = { MonitorService, normalizePayload };
