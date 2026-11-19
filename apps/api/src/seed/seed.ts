import { loadEnvFile } from '../config/dotenv.js';
loadEnvFile();
const { env } = await import('../config/env.js');
const { getPool, closePool, tx } = await import('../db/pool.js');
const { migrate } = await import('../db/migrate.js');
const { seedBaseline, seedDemoUsers } = await import('./baseline.js');
await migrate();
await tx((c) => seedBaseline(c));
console.log('baseline configuration seeded');
if (env().APP_ENV !== 'production') {
  await tx((c) => seedDemoUsers(c));
  const { seedDemoData } = await import('./demo.js');
  await seedDemoData(getPool());
  console.log('DEMO / NON-PRODUCTION users and data seeded');
}
await closePool();
process.exit(0);
