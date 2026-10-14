'use strict';

const { AppError } = require('../utils/app-error');

const EVENT_TABLE = Object.freeze({
  performance: 'performance',
  request: 'performance',
  resource: 'performance',
  error: 'error',
  stability: 'error',
  behavior: 'behavior',
});

const COMMON_FIELDS = [
  'app_id',
  'release',
  'environment',
  'user_id',
  'session_id',
  'page_url',
  'route',
  'referrer',
  'network',
  'locale',
  'screen',
  'viewport',
  'sdk_version',
  'sample_rate',
  'send_time',
  'trace_id',
];

const TABLE_FIELDS = {
  performance: [
    'metric_name',
    'value',
    'rating',
    'start_time',
    'dns',
    'tcp',
    'ssl',
    'request',
    'response',
    'dom_ready',
    'load',
    'name',
    'initiator_type',
    'duration',
    'transfer_size',
    'encoded_body_size',
    'url',
    'method',
    'status_code',
    'request_size',
    'response_size',
    'success',
    'request_body',
    'response_body',
    'resource_url',
    'resource_type',
    'cached',
    'status',
  ],
  error: [
    'error_type',
    'message',
    'name',
    'stack',
    'filename',
    'lineno',
    'colno',
    'component',
    'component_stack',
    'props',
    'reason',
    'resource_url',
    'resource_type',
    'tag_name',
    'url',
    'method',
    'status_code',
    'response_body',
    'duration',
    'breadcrumbs',
    'tags',
    'extra',
    'fingerprint',
    'issue_type',
    'blank_time',
    'root_node_count',
  ],
  behavior: [
    'action',
    'from_route',
    'to_route',
    'duration',
    'category',
    'properties',
  ],
};

const FIELD_ALIASES = Object.freeze({
  initiatorType: 'initiator_type',
  transferSize: 'transfer_size',
  encodedBodySize: 'encoded_body_size',
  startTime: 'start_time',
  sdk_verion: 'sdk_version',
});

const JSON_STRING_FIELDS = new Set([
  'breadcrumbs',
  'extra',
  'props',
  'properties',
  'request_body',
  'response_body',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatClickHouseDateTime(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function parsePayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'Invalid JSON body');
  }

  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new AppError(400, 'JSON body must be an object');
  }
  return payload;
}

function expandEnvelope(envelope) {
  const payload =
    envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? { ...envelope, ...envelope.data }
      : { ...envelope };
  delete payload.data;

  if (payload.app_id === undefined && payload.app_key !== undefined) {
    payload.app_id = payload.app_key;
  }
  for (const [source, target] of Object.entries(FIELD_ALIASES)) {
    if (payload[target] === undefined && payload[source] !== undefined) {
      payload[target] = payload[source];
    }
  }
  return payload;
}

function assertBatchFields(envelope) {
  if (envelope.sample_rate !== undefined) {
    const sampleRate = Number(envelope.sample_rate);
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
      throw new AppError(400, 'sample_rate must be a number between 0 and 1');
    }
    envelope.sample_rate = sampleRate;
  }

  if (envelope.send_time !== undefined) {
    const sendTime = Number(envelope.send_time);
    if (!Number.isSafeInteger(sendTime) || sendTime <= 0) {
      throw new AppError(400, 'send_time must be a positive Unix millisecond integer');
    }
    envelope.send_time = sendTime;
  }
}

function expandEvents(envelope) {
  if (envelope.events === undefined) {
    return { isBatch: false, payloads: [expandEnvelope(envelope)] };
  }
  if (!Array.isArray(envelope.events) || envelope.events.length === 0) {
    throw new AppError(400, 'events must be a non-empty array');
  }

  const batchFields = expandEnvelope({
    app_id: envelope.app_id,
    app_key: envelope.app_key,
    sample_rate: envelope.sample_rate,
    sdk_version: envelope.sdk_version,
    sdk_verion: envelope.sdk_verion,
    send_time: envelope.send_time,
  });
  assertBatchFields(batchFields);

  const payloads = envelope.events.map((event, index) => {
    if (event === null || Array.isArray(event) || typeof event !== 'object') {
      throw new AppError(400, `events[${index}] must be an object`);
    }
    return expandEnvelope({ ...batchFields, ...event });
  });

  return { isBatch: true, payloads };
}

function assertCommonFields(payload) {
  if (!UUID_PATTERN.test(payload.event_id || '')) {
    throw new AppError(400, 'event_id must be a UUID');
  }
  if (!Object.hasOwn(EVENT_TABLE, payload.event_type)) {
    throw new AppError(
      400,
      'event_type must be performance, request, resource, error, stability, or behavior',
    );
  }
  if (typeof payload.app_id !== 'string' || payload.app_id.trim() === '') {
    throw new AppError(400, 'app_id is required');
  }

  const timestamp = Number(payload.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new AppError(400, 'timestamp must be a positive Unix millisecond integer');
  }
  payload.timestamp = timestamp;
}

function assertEventFields(payload) {
  switch (payload.event_type) {
    case 'performance':
      if (!payload.metric_name) {
        throw new AppError(400, 'metric_name is required for performance events');
      }
      break;
    case 'request':
      if (!payload.url || !payload.method) {
        throw new AppError(400, 'url and method are required for request events');
      }
      break;
    case 'resource':
      if (!payload.resource_url) {
        throw new AppError(400, 'resource_url is required for resource events');
      }
      break;
    case 'error':
      if (!payload.error_type) {
        throw new AppError(400, 'error_type is required for error events');
      }
      break;
    case 'stability':
      if (!payload.issue_type) {
        throw new AppError(400, 'issue_type is required for stability events');
      }
      break;
    case 'behavior':
      if (!payload.action) {
        throw new AppError(400, 'action is required for behavior events');
      }
      break;
    default:
      break;
  }
}

function normalizeJsonField(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function copyFields(event, payload, fields) {
  for (const field of fields) {
    if (payload[field] !== undefined) {
      event[field] = JSON_STRING_FIELDS.has(field)
        ? normalizeJsonField(payload[field])
        : payload[field];
    }
  }
}

function flattenClientFields(event, payload) {
  if (payload.device && typeof payload.device === 'object') {
    event.device_type = payload.device.type || '';
    event.device_model = payload.device.model || '';
  }
  if (payload.browser && typeof payload.browser === 'object') {
    event.browser_name = payload.browser.name || '';
    event.browser_version = payload.browser.version || '';
  }
  if (payload.os && typeof payload.os === 'object') {
    event.os_name = payload.os.name || '';
    event.os_version = payload.os.version || '';
  }
  if (payload.target && typeof payload.target === 'object') {
    event.target_selector = payload.target.selector || '';
    event.target_text = payload.target.text || '';
    event.target_tag = payload.target.tag || '';
  }
}

function buildEvent(tableCategory, payload, requestData) {
  const event = {
    event_id: payload.event_id,
    event_type: payload.event_type,
    timestamp: payload.timestamp,
    received_at: formatClickHouseDateTime(new Date()),
    client_ip: requestData.ip,
    user_agent: requestData.userAgent,
  };

  copyFields(event, payload, COMMON_FIELDS);
  copyFields(event, payload, TABLE_FIELDS[tableCategory]);
  flattenClientFields(event, payload);

  if (event.success !== undefined) event.success = event.success ? 1 : 0;
  if (event.cached !== undefined) event.cached = event.cached ? 1 : 0;
  return event;
}

class MonitorService {
  constructor(repository) {
    this.repository = repository;
  }

  async receive(data) {
    const { isBatch, payloads } = expandEvents(parsePayload(data.raw));
    const groupedEvents = new Map();
    const events = payloads.map((payload, index) => {
      try {
        assertCommonFields(payload);
        assertEventFields(payload);
        assertBatchFields(payload);
      } catch (error) {
        if (isBatch && error instanceof AppError) {
          throw new AppError(error.statusCode, `events[${index}]: ${error.message}`);
        }
        throw error;
      }

      const tableCategory = EVENT_TABLE[payload.event_type];
      const event = buildEvent(tableCategory, payload, data);
      const tableEvents = groupedEvents.get(tableCategory) || [];
      tableEvents.push(event);
      groupedEvents.set(tableCategory, tableEvents);
      return event;
    });

    for (const [tableCategory, tableEvents] of groupedEvents) {
      await this.repository.insertMany(tableCategory, tableEvents);
    }

    if (!isBatch) {
      return {
        eventId: events[0].event_id,
        eventType: events[0].event_type,
        bytes: data.bytes,
      };
    }

    return {
      eventIds: events.map((event) => event.event_id),
      eventCount: events.length,
      bytes: data.bytes,
    };
  }
}

module.exports = {
  EVENT_TABLE,
  MonitorService,
  buildEvent,
  expandEnvelope,
  expandEvents,
  formatClickHouseDateTime,
  parsePayload,
};
