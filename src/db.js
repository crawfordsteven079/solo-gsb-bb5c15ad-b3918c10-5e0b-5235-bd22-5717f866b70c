'use strict';

const pg = require('pg');
const { Pool } = pg;
const fs = require('fs');
const path = require('path');

// DATE 列以字符串返回（避免驱动按 UTC 解析造成日期偏移）；NUMERIC 同样保留字符串
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'lightuser',
  password: process.env.PGPASSWORD || 'lightpass',
  database: process.env.PGDATABASE || 'lightquota',
  max: 10
});

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function waitForDatabase(retries = 60, delayMs = 1000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === 1) console.log('[db] 等待 PostgreSQL 就绪…');
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { pool, withTransaction, waitForDatabase, initSchema };
