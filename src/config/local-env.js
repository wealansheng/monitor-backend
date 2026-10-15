'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const localEnvPath = resolve(__dirname, '../../.env');

function readLocalEnv(path = localEnvPath) {
  if (!existsSync(path)) return {};

  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

module.exports = { readLocalEnv };
