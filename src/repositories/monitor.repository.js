'use strict';

const { getSchemaStatements, quoteIdentifier } = require('../database/schema');

class MonitorRepository {
  constructor({ client, database, tables }) {
    this.client = client;
    this.database = database;
    this.tables = tables;
    this.qualifiedTables = Object.fromEntries(
      Object.entries(tables).map(([category, table]) => [
        category,
        `${quoteIdentifier(database)}.${quoteIdentifier(table)}`,
      ]),
    );
  }

  async initialize() {
    const statements = getSchemaStatements({ database: this.database, tables: this.tables });
    for (const query of statements) {
      await this.client.command({ query });
    }
  }

  async insert(category, event) {
    return this.insertMany(category, [event]);
  }

  async insertMany(category, events) {
    const table = this.qualifiedTables[category];
    if (!table) {
      throw new Error(`不支持的监控事件类型: ${category}`);
    }

    await this.client.insert({
      table,
      values: events,
      format: 'JSONEachRow',
      clickhouse_settings: {
        input_format_defaults_for_omitted_fields: 1,
      },
    });
  }
}

module.exports = { MonitorRepository };
