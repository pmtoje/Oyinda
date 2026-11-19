import { loadEnvFile } from './config/dotenv.js';
loadEnvFile();
const { buildApp } = await import('./http/app.js');
const { env } = await import('./config/env.js');
const { migrate } = await import('./db/migrate.js');

const e = env();
await migrate((m) => console.log(m));
const app = await buildApp();
await app.listen({ port: e.PORT, host: e.HOST });
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
