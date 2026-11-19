/**
 * OPERATOR TOOL (interim staff sign-in): send an activation link to a staff member's work e-mail.
 * Used to bootstrap the first administrators when STAFF_AUTH_MODE=local, before anyone can sign in to do it from
 * the Control Centre. The link is delivered only by e-mail; outside production it is also printed for testing.
 * Usage: pnpm --filter @gazelle/api staff:activation-link <username>
 */
import { loadEnvFile } from '../config/dotenv.js';
loadEnvFile();
const { env } = await import('../config/env.js');
if (env().STAFF_AUTH_MODE !== 'local') { console.error('STAFF_AUTH_MODE is not "local": staff sign in with Active Directory.'); process.exit(1); }
const { getPool, closePool, tx, maybe, q } = await import('../db/pool.js');
const { SYSTEM } = await import('../modules/audit/audit.js');
const { issueStaffLink } = await import('../modules/identity/staff-credentials.js');
const username = process.argv[2];
if (!username) { console.error('Usage: staff:activation-link <username>'); process.exit(1); }
const u = await maybe<any>(getPool(), `SELECT id FROM app_user WHERE lower(ad_username)=lower($1) AND status='ACTIVE'`, [username]);
if (!u) { console.error('No active staff user with that username.'); process.exit(1); }
const link = await tx((c) => issueStaffLink(c, { ...SYSTEM, label: 'operator CLI (staff:activation-link)' }, u.id, 'ACTIVATE'));
await link.send();
console.log(`Activation link sent to ${link.sentTo} (valid 72 hours).`);
if (env().APP_ENV !== 'production' && env().MESSAGING_MODE === 'mock') {
  const [m] = await q<any>(getPool(), 'SELECT body FROM mock_outbox ORDER BY id DESC LIMIT 1');
  console.log(`NON-PRODUCTION: ${/(https?:\/\/\S+set-password\?token=\S+)/.exec(m?.body ?? '')?.[1] ?? '(see mock outbox)'}`);
}
await closePool();
