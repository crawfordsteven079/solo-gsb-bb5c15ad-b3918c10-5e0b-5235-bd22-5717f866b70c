'use strict';

// 初始化本地账号（幂等）：账号与密码可通过环境变量覆盖
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const SEED_USERS = [
  {
    username: process.env.CONSERVATOR_USER || 'conservator',
    password: process.env.CONSERVATOR_PASSWORD || 'conservator123',
    display_name: '保管员',
    role: 'conservator'
  },
  {
    username: process.env.INSTALLER_USER || 'installer',
    password: process.env.INSTALLER_PASSWORD || 'installer123',
    display_name: '布展员',
    role: 'installer'
  }
];

async function seed() {
  for (const u of SEED_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             display_name  = EXCLUDED.display_name,
             role          = EXCLUDED.role`,
      [u.username, u.display_name, hash, u.role]
    );
    console.log(`[seed] 账号就绪: ${u.username} (${u.role === 'conservator' ? '保管员' : '布展员'})`);
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = seed;
