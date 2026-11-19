/** DEV ONLY: print the current authenticator code for an enrolled DEMO user (refuses outside non-production). */
import { loadEnvFile } from '../config/dotenv.js';
loadEnvFile();
const { env } = await import('../config/env.js');
if (env().APP_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }
const { getPool, closePool, q } = await import('../db/pool.js');
const { decryptField } = await import('../lib/crypto.js');
const { hotp, totpStep } = await import('../modules/identity/totp.js');
const user = process.argv[2];
const [row] = await q<any>(getPool(), 'SELECT mfa_secret_enc, is_demo FROM app_user WHERE ad_username=$1', [user]);
if (!row?.is_demo || !row.mfa_secret_enc) { console.error('Not an enrolled DEMO user.'); process.exit(1); }
console.log(`${user}: ${hotp(decryptField(row.mfa_secret_enc), totpStep())} (valid ~30s; DEMO only)`);
await closePool();
