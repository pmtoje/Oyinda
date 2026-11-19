/** DEV ONLY: show the latest messages in the MOCK SMS/email outbox (where demo OTPs are delivered). */
import { loadEnvFile } from '../config/dotenv.js';
loadEnvFile();
const { env } = await import('../config/env.js');
if (env().APP_ENV === 'production' || env().MESSAGING_MODE !== 'mock') { console.error('Only available with the mock messaging provider outside production.'); process.exit(1); }
const { getPool, closePool, q } = await import('../db/pool.js');
for (const r of await q<any>(getPool(), 'SELECT channel, destination, body, created_at FROM mock_outbox ORDER BY id DESC LIMIT 5')) console.log(`[${r.channel}] ${r.destination} ${new Date(r.created_at).toISOString()}\n  ${r.body}`);
await closePool();
