'use strict';

const { waitForDatabase, initSchema } = require('./db');
const seed = require('./seed');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);

async function main() {
  await waitForDatabase();
  await initSchema();
  await seed();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`光照额度管理系统已启动: http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
