-- weils_monitor frontend observability schema
-- All event timestamps are stored in UTC. Convert to the display timezone at query time.

CREATE DATABASE IF NOT EXISTS weils_monitor
ENGINE = Atomic
COMMENT 'Frontend observability data';

CREATE TABLE IF NOT EXISTS weils_monitor.frontend_performance
(
    -- Identity and time
    event_id UUID DEFAULT generateUUIDv4(),
    event_time DateTime64(3, 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),

    -- Application dimensions
    project_id LowCardinality(String),
    environment LowCardinality(String) DEFAULT 'production',
    release LowCardinality(String) DEFAULT '',
    sdk_name LowCardinality(String) DEFAULT 'web',
    sdk_version LowCardinality(String) DEFAULT '',

    -- User and page dimensions
    user_id String DEFAULT '',
    anonymous_id String DEFAULT '',
    session_id String DEFAULT '',
    trace_id String DEFAULT '',
    page_url String DEFAULT '',
    page_path String DEFAULT '',
    route_name LowCardinality(String) DEFAULT '',
    referrer String DEFAULT '',

    -- Client dimensions
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',
    network_type LowCardinality(String) DEFAULT '',

    -- Metric model. Examples: web_vital/LCP, navigation/TTFB, resource/duration.
    performance_type LowCardinality(String),
    metric_name LowCardinality(String),
    metric_value Float64,
    metric_unit LowCardinality(String) DEFAULT 'ms',
    rating LowCardinality(String) DEFAULT '',
    navigation_type LowCardinality(String) DEFAULT '',

    -- Resource timing fields; empty/zero for non-resource metrics.
    resource_url String DEFAULT '',
    initiator_type LowCardinality(String) DEFAULT '',
    protocol LowCardinality(String) DEFAULT '',
    http_status UInt16 DEFAULT 0,
    start_time_ms Float64 DEFAULT 0,
    duration_ms Float64 DEFAULT 0,
    transfer_size UInt64 DEFAULT 0,
    encoded_body_size UInt64 DEFAULT 0,
    decoded_body_size UInt64 DEFAULT 0,

    -- Sampling and extensibility
    sample_rate Float32 DEFAULT 1,
    tags Map(String, String) DEFAULT map(),
    attribution_json String DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_performance_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_performance_page page_path TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_performance_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    project_id,
    environment,
    event_date,
    performance_type,
    metric_name,
    event_time,
    event_id
)
TTL event_time + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'Web Vitals, navigation timing, resource timing and custom frontend metrics';

CREATE TABLE IF NOT EXISTS weils_monitor.frontend_error
(
    -- Identity and time
    event_id UUID DEFAULT generateUUIDv4(),
    event_time DateTime64(3, 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),

    -- Application dimensions
    project_id LowCardinality(String),
    environment LowCardinality(String) DEFAULT 'production',
    release LowCardinality(String) DEFAULT '',
    sdk_name LowCardinality(String) DEFAULT 'web',
    sdk_version LowCardinality(String) DEFAULT '',

    -- User and page dimensions
    user_id String DEFAULT '',
    anonymous_id String DEFAULT '',
    session_id String DEFAULT '',
    trace_id String DEFAULT '',
    page_url String DEFAULT '',
    page_path String DEFAULT '',
    route_name LowCardinality(String) DEFAULT '',

    -- Client dimensions
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',

    -- Error details
    error_type LowCardinality(String),
    error_level LowCardinality(String) DEFAULT 'error',
    error_name LowCardinality(String) DEFAULT '',
    message String,
    stack_trace String DEFAULT '' CODEC(ZSTD(3)),
    source LowCardinality(String) DEFAULT '',
    file_name String DEFAULT '',
    line_number UInt32 DEFAULT 0,
    column_number UInt32 DEFAULT 0,
    component_name LowCardinality(String) DEFAULT '',
    handled UInt8 DEFAULT 0,

    -- HTTP/resource error details; empty/zero for JavaScript errors.
    request_url String DEFAULT '',
    request_method LowCardinality(String) DEFAULT '',
    http_status UInt16 DEFAULT 0,
    request_duration_ms Float64 DEFAULT 0,

    -- The SDK may provide a stable grouping key. Otherwise core fields are hashed.
    fingerprint String DEFAULT '',
    fingerprint_hash UInt64 MATERIALIZED
        if(
            empty(fingerprint),
            cityHash64(concat(error_type, '|', error_name, '|', message, '|', file_name)),
            cityHash64(fingerprint)
        ),

    -- Sampling, debugging context and extensibility
    sample_rate Float32 DEFAULT 1,
    tags Map(String, String) DEFAULT map(),
    breadcrumbs_json String DEFAULT '[]' CODEC(ZSTD(3)),
    context_json String DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_error_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_error_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_error_page page_path TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    project_id,
    environment,
    event_date,
    fingerprint_hash,
    event_time,
    event_id
)
TTL event_time + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'JavaScript, promise, framework, resource and HTTP frontend errors';

CREATE TABLE IF NOT EXISTS weils_monitor.frontend_behavior
(
    -- Identity and time
    event_id UUID DEFAULT generateUUIDv4(),
    event_time DateTime64(3, 'UTC'),
    event_date Date MATERIALIZED toDate(event_time),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    sequence_no UInt32 DEFAULT 0,

    -- Application dimensions
    project_id LowCardinality(String),
    environment LowCardinality(String) DEFAULT 'production',
    release LowCardinality(String) DEFAULT '',
    sdk_name LowCardinality(String) DEFAULT 'web',
    sdk_version LowCardinality(String) DEFAULT '',

    -- User and page dimensions
    user_id String DEFAULT '',
    anonymous_id String DEFAULT '',
    session_id String,
    trace_id String DEFAULT '',
    page_url String DEFAULT '',
    page_path String DEFAULT '',
    route_name LowCardinality(String) DEFAULT '',
    referrer String DEFAULT '',

    -- Client dimensions
    browser_name LowCardinality(String) DEFAULT '',
    browser_version LowCardinality(String) DEFAULT '',
    os_name LowCardinality(String) DEFAULT '',
    os_version LowCardinality(String) DEFAULT '',
    device_type LowCardinality(String) DEFAULT '',

    -- Behavior details. Examples: page_view, click, input, scroll, route_change, custom.
    behavior_type LowCardinality(String),
    event_name LowCardinality(String) DEFAULT '',
    element_tag LowCardinality(String) DEFAULT '',
    element_id String DEFAULT '',
    element_selector String DEFAULT '',
    element_text String DEFAULT '',
    field_name String DEFAULT '',
    input_type LowCardinality(String) DEFAULT '',
    from_url String DEFAULT '',
    to_url String DEFAULT '',

    -- Coordinates and duration; zero when not applicable.
    client_x Int32 DEFAULT 0,
    client_y Int32 DEFAULT 0,
    scroll_x Int32 DEFAULT 0,
    scroll_y Int32 DEFAULT 0,
    viewport_width UInt32 DEFAULT 0,
    viewport_height UInt32 DEFAULT 0,
    duration_ms Float64 DEFAULT 0,

    -- Sampling and extensibility. Never store passwords or raw form values.
    sample_rate Float32 DEFAULT 1,
    tags Map(String, String) DEFAULT map(),
    properties_json String DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_behavior_session session_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_behavior_user user_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_behavior_page page_path TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY
(
    project_id,
    environment,
    event_date,
    behavior_type,
    event_time,
    event_id
)
TTL event_time + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192
COMMENT 'Page views, clicks, route changes, scrolls and privacy-safe custom behavior events';
