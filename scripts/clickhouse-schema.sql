-- Schema derived from docs/字段要求.md.
-- SDK timestamps are Unix epoch milliseconds. Query event_time for DateTime operations.

CREATE DATABASE IF NOT EXISTS weils_monitor
ENGINE = Atomic
COMMENT 'Frontend observability data';

-- event_type: performance, request, resource
CREATE TABLE IF NOT EXISTS weils_monitor.frontend_performance
(
    -- Common fields
    event_id UUID DEFAULT generateUUIDv4(),
    event_type LowCardinality(String),
    timestamp UInt64,
    event_time DateTime64(3, 'UTC') MATERIALIZED
        fromUnixTimestamp64Milli(toInt64(timestamp), 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    app_id LowCardinality(String),
    project_name LowCardinality(String) DEFAULT '',
    release LowCardinality(String) DEFAULT '',
    environment LowCardinality(String) DEFAULT 'production',
    user_id String DEFAULT '',
    session_id String DEFAULT '',
    page_url String DEFAULT '',
    route String DEFAULT '',
    referrer String DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',
    device_model LowCardinality(String) DEFAULT '',
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    network LowCardinality(String) DEFAULT '',
    locale LowCardinality(String) DEFAULT '',
    screen LowCardinality(String) DEFAULT '',
    viewport LowCardinality(String) DEFAULT '',
    sdk_version LowCardinality(String) DEFAULT '',
    sample_rate Float64 DEFAULT 1,
    send_time UInt64 DEFAULT 0,
    trace_id String DEFAULT '',
    client_ip String DEFAULT '',
    user_agent String DEFAULT '',

    -- Core Web Vitals and runtime performance
    metric_name LowCardinality(String) DEFAULT '',
    value Float64 DEFAULT 0,
    rating LowCardinality(String) DEFAULT '',
    start_time Float64 DEFAULT 0,

    -- Navigation timing, in milliseconds
    dns Float64 DEFAULT 0,
    tcp Float64 DEFAULT 0,
    ssl Float64 DEFAULT 0,
    request Float64 DEFAULT 0,
    response Float64 DEFAULT 0,
    dom_ready Float64 DEFAULT 0,
    load Float64 DEFAULT 0,

    -- Resource timing metric fields
    name String DEFAULT '',
    initiator_type LowCardinality(String) DEFAULT '',
    duration Float64 DEFAULT 0,
    transfer_size UInt64 DEFAULT 0,
    encoded_body_size UInt64 DEFAULT 0,

    -- Request event fields
    url String DEFAULT '',
    method LowCardinality(String) DEFAULT '',
    status_code UInt16 DEFAULT 0,
    request_size UInt64 DEFAULT 0,
    response_size UInt64 DEFAULT 0,
    success UInt8 DEFAULT 0,
    request_body String DEFAULT '' CODEC(ZSTD(3)),
    response_body String DEFAULT '' CODEC(ZSTD(3)),

    -- Standalone resource event fields
    resource_url String DEFAULT '',
    resource_type LowCardinality(String) DEFAULT '',
    cached UInt8 DEFAULT 0,
    status UInt16 DEFAULT 0,

    INDEX idx_performance_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_performance_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_performance_route route TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    app_id,
    environment,
    event_date,
    event_type,
    metric_name,
    event_time,
    event_id
)
TTL event_time + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'Performance, request and resource events';

ALTER TABLE weils_monitor.frontend_performance
    ADD COLUMN IF NOT EXISTS project_name LowCardinality(String) DEFAULT '' AFTER app_id;
ALTER TABLE weils_monitor.frontend_performance
    ADD COLUMN IF NOT EXISTS sample_rate Float64 DEFAULT 1 AFTER sdk_version;
ALTER TABLE weils_monitor.frontend_performance
    ADD COLUMN IF NOT EXISTS send_time UInt64 DEFAULT 0 AFTER sample_rate;
ALTER TABLE weils_monitor.frontend_performance
    MODIFY COLUMN start_time Float64 DEFAULT 0;

-- event_type: error, stability
CREATE TABLE IF NOT EXISTS weils_monitor.frontend_error
(
    -- Common fields
    event_id UUID DEFAULT generateUUIDv4(),
    event_type LowCardinality(String),
    timestamp UInt64,
    event_time DateTime64(3, 'UTC') MATERIALIZED
        fromUnixTimestamp64Milli(toInt64(timestamp), 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    app_id LowCardinality(String),
    project_name LowCardinality(String) DEFAULT '',
    release LowCardinality(String) DEFAULT '',
    environment LowCardinality(String) DEFAULT 'production',
    user_id String DEFAULT '',
    session_id String DEFAULT '',
    page_url String DEFAULT '',
    route String DEFAULT '',
    referrer String DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',
    device_model LowCardinality(String) DEFAULT '',
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    network LowCardinality(String) DEFAULT '',
    locale LowCardinality(String) DEFAULT '',
    screen LowCardinality(String) DEFAULT '',
    viewport LowCardinality(String) DEFAULT '',
    sdk_version LowCardinality(String) DEFAULT '',
    sample_rate Float64 DEFAULT 1,
    send_time UInt64 DEFAULT 0,
    trace_id String DEFAULT '',
    client_ip String DEFAULT '',
    user_agent String DEFAULT '',

    -- JavaScript, Promise, resource, HTTP, framework and business errors
    error_type LowCardinality(String) DEFAULT '',
    message String DEFAULT '',
    name LowCardinality(String) DEFAULT '',
    stack String DEFAULT '' CODEC(ZSTD(3)),
    stack_frames String DEFAULT '[]' CODEC(ZSTD(3)),
    filename String DEFAULT '',
    lineno UInt32 DEFAULT 0,
    colno UInt32 DEFAULT 0,
    component LowCardinality(String) DEFAULT '',
    component_stack String DEFAULT '' CODEC(ZSTD(3)),
    props String DEFAULT '{}' CODEC(ZSTD(3)),
    reason String DEFAULT '',
    resource_url String DEFAULT '',
    resource_type LowCardinality(String) DEFAULT '',
    tag_name LowCardinality(String) DEFAULT '',
    url String DEFAULT '',
    method LowCardinality(String) DEFAULT '',
    status_code UInt16 DEFAULT 0,
    response_body String DEFAULT '' CODEC(ZSTD(3)),
    duration Float64 DEFAULT 0,
    breadcrumbs String DEFAULT '[]' CODEC(ZSTD(3)),
    tags Map(String, String) DEFAULT map(),
    extra String DEFAULT '{}' CODEC(ZSTD(3)),
    fingerprint String DEFAULT '',
    fingerprint_hash UInt64 MATERIALIZED
        if(
            empty(fingerprint),
            cityHash64(concat(error_type, '|', name, '|', message, '|', filename)),
            cityHash64(fingerprint)
        ),

    -- Blank screen, crash and other stability events
    issue_type LowCardinality(String) DEFAULT '',
    blank_time UInt64 DEFAULT 0,
    root_node_count UInt32 DEFAULT 0,

    INDEX idx_error_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_error_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_error_route route TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    app_id,
    environment,
    event_date,
    event_type,
    fingerprint_hash,
    event_time,
    event_id
)
TTL event_time + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'Error and stability events';

ALTER TABLE weils_monitor.frontend_error
    ADD COLUMN IF NOT EXISTS stack_frames String DEFAULT '[]' CODEC(ZSTD(3)) AFTER stack;
ALTER TABLE weils_monitor.frontend_error
    ADD COLUMN IF NOT EXISTS project_name LowCardinality(String) DEFAULT '' AFTER app_id;
ALTER TABLE weils_monitor.frontend_error
    ADD COLUMN IF NOT EXISTS sample_rate Float64 DEFAULT 1 AFTER sdk_version;
ALTER TABLE weils_monitor.frontend_error
    ADD COLUMN IF NOT EXISTS send_time UInt64 DEFAULT 0 AFTER sample_rate;

-- event_type: behavior
CREATE TABLE IF NOT EXISTS weils_monitor.frontend_behavior
(
    -- Common fields
    event_id UUID DEFAULT generateUUIDv4(),
    event_type LowCardinality(String),
    timestamp UInt64,
    event_time DateTime64(3, 'UTC') MATERIALIZED
        fromUnixTimestamp64Milli(toInt64(timestamp), 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    app_id LowCardinality(String),
    project_name LowCardinality(String) DEFAULT '',
    release LowCardinality(String) DEFAULT '',
    environment LowCardinality(String) DEFAULT 'production',
    user_id String DEFAULT '',
    session_id String DEFAULT '',
    page_url String DEFAULT '',
    route String DEFAULT '',
    referrer String DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',
    device_model LowCardinality(String) DEFAULT '',
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    network LowCardinality(String) DEFAULT '',
    locale LowCardinality(String) DEFAULT '',
    screen LowCardinality(String) DEFAULT '',
    viewport LowCardinality(String) DEFAULT '',
    sdk_version LowCardinality(String) DEFAULT '',
    sample_rate Float64 DEFAULT 1,
    send_time UInt64 DEFAULT 0,
    trace_id String DEFAULT '',
    client_ip String DEFAULT '',
    user_agent String DEFAULT '',

    -- Page views, route changes, interactions and custom business behavior
    action LowCardinality(String),
    from_route String DEFAULT '',
    to_route String DEFAULT '',
    duration Float64 DEFAULT 0,
    target_selector String DEFAULT '',
    target_text String DEFAULT '',
    target_tag LowCardinality(String) DEFAULT '',
    category LowCardinality(String) DEFAULT '',
    properties String DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_behavior_session session_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_behavior_user user_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_behavior_route route TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    app_id,
    environment,
    event_date,
    action,
    event_time,
    event_id
)
TTL event_time + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'Behavior events';

ALTER TABLE weils_monitor.frontend_behavior
    ADD COLUMN IF NOT EXISTS project_name LowCardinality(String) DEFAULT '' AFTER app_id;
ALTER TABLE weils_monitor.frontend_behavior
    ADD COLUMN IF NOT EXISTS sample_rate Float64 DEFAULT 1 AFTER sdk_version;
ALTER TABLE weils_monitor.frontend_behavior
    ADD COLUMN IF NOT EXISTS send_time UInt64 DEFAULT 0 AFTER sample_rate;

-- Replay payloads are already gzip/base64 encoded by the browser.
CREATE TABLE IF NOT EXISTS weils_monitor.event_record
(
    app_id LowCardinality(String),
    record_id UUID,
    session_id String,
    user_id String DEFAULT '',
    route String DEFAULT '',
    started_at UInt64,
    ended_at UInt64,
    event_time DateTime64(3, 'UTC') MATERIALIZED fromUnixTimestamp64Milli(toInt64(started_at), 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    error_ids Array(String),
    chunk_index UInt8,
    chunk_count UInt8,
    chunk_checksum FixedString(64),
    metadata_hash FixedString(64),
    variant_hash FixedString(64),
    metadata String CODEC(ZSTD(3)),
    payload String,
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX idx_record_error error_ids TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_record_session session_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (app_id, record_id, chunk_index, variant_hash)
TTL event_time + INTERVAL 30 DAY DELETE
COMMENT 'Error replay chunks - variant hash preserves evidence of conflicting retries';
