'use strict';

class MonitorRepository {
  constructor({ client, database, table }) {
    this.client = client;
    this.database = database;
    this.table = table;
    this.qualifiedTable = `\`${database}\`.\`${table}\``;
  }

  async initialize() {
    await this.client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${this.qualifiedTable}
        (
          event_id UUID,
          received_at DateTime64(3, 'UTC'),
          content_type LowCardinality(String),
          source_ip String,
          user_agent String,
          payload String,
          payload_size UInt64
        )
        ENGINE = MergeTree
        ORDER BY (received_at, event_id)
      `,
    });
  }

  async insert(event) {
    await this.client.insert({
      table: this.qualifiedTable,
      values: [event],
      format: 'JSONEachRow',
    });
  }
}

module.exports = { MonitorRepository };
