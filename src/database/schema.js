'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '../../scripts/clickhouse-schema.sql');

function quoteIdentifier(identifier) {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function splitSqlStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function getSchemaStatements({ database, tables }) {
  const qualifiedTables = {
    performance: `${quoteIdentifier(database)}.${quoteIdentifier(tables.performance)}`,
    error: `${quoteIdentifier(database)}.${quoteIdentifier(tables.error)}`,
    behavior: `${quoteIdentifier(database)}.${quoteIdentifier(tables.behavior)}`,
  };

  const sql = fs
    .readFileSync(SCHEMA_PATH, 'utf8')
    .replace(
      'CREATE DATABASE IF NOT EXISTS weils_monitor',
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database)}`,
    )
    .replaceAll('weils_monitor.frontend_performance', qualifiedTables.performance)
    .replaceAll('weils_monitor.frontend_error', qualifiedTables.error)
    .replaceAll('weils_monitor.frontend_behavior', qualifiedTables.behavior);

  return splitSqlStatements(sql);
}

module.exports = { getSchemaStatements, quoteIdentifier, splitSqlStatements };
