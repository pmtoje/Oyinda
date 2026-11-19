import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../config/dotenv.js';
import type { Db } from '../db/pool.js';
import { q } from '../db/pool.js';
import { SYSTEM } from '../modules/audit/audit.js';
import { bootstrap } from '../modules/config/service.js';
import { PERMISSIONS, ROLES } from '../modules/identity/rbac.js';
import { BASELINE } from './baseline-config.js';
import { BUSINESS_UNITS, DIRECTORATES, SECTORS } from './reference-data.js';

/** Baseline: reference data, roles/permissions and default configuration. Safe to run repeatedly. */
export async function seedBaseline(db: Db) {
  for (const d of DIRECTORATES) await q(db, 'INSERT INTO directorate(code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [d.code, d.name]);
  for (const b of BUSINESS_UNITS) await q(db, 'INSERT INTO business_unit(code,name,directorate_code) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [b.code, b.name, b.directorate]);
  for (const s of SECTORS) await q(db, 'INSERT INTO sector(code,name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [s.code, s.name]);
  for (const [code, description] of Object.entries(PERMISSIONS)) await q(db, 'INSERT INTO permission(code,description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description', [code, description]);
  for (const r of ROLES) {
    await q(db, 'INSERT INTO role(code,name,is_privileged) VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING', [r.code, r.name, !!r.privileged]);
    for (const p of r.perms) await q(db, 'INSERT INTO role_permission(role_code, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.code, p]);
  }
  for (const item of BASELINE) await bootstrap(db, SYSTEM, item.kind, item.key, item.title, item.payload);
}

/** DEMO / NON-PRODUCTION staff users — one per role. Authentication is via the mock directory and TOTP enrolment. */
export const DEMO_USERS: { username: string; name: string; roles: string[]; bu: string; staffNumber?: string }[] = [
  { username: 'demo.rm', name: 'Amina Bello (DEMO RM)', roles: ['RM'], bu: 'LAG-CORP-1', staffNumber: 'DEMO-RM-01' },
  { username: 'demo.rm2', name: 'Tunde Okafor (DEMO RM)', roles: ['RM'], bu: 'ABJ-CORP-1', staffNumber: 'DEMO-RM-02' },
  { username: 'demo.bm', name: 'Chidi Nwosu (DEMO BM)', roles: ['BM'], bu: 'LAG-CORP-1' },
  { username: 'demo.rbe', name: 'Halima Yusuf (DEMO RBE)', roles: ['RBE'], bu: 'LAG-CORP-1' },
  { username: 'demo.dh', name: 'Olusegun Adeyemi (DEMO DH)', roles: ['DH'], bu: 'LAG-CORP-1' },
  { username: 'demo.analyst', name: 'Fatima Abubakar (DEMO Credit Analyst)', roles: ['CREDIT_ANALYST'], bu: 'CREDIT-RISK' },
  { username: 'demo.analyst2', name: 'Emeka Eze (DEMO Credit Analyst)', roles: ['CREDIT_ANALYST'], bu: 'CREDIT-RISK' },
  { username: 'demo.es', name: 'Zainab Lawal (DEMO E&S Analyst)', roles: ['ES_ANALYST'], bu: 'CREDIT-RISK' },
  { username: 'demo.ctl', name: 'Ibrahim Musa (DEMO Credit Team Lead)', roles: ['CREDIT_TEAM_LEAD'], bu: 'CREDIT-RISK' },
  { username: 'demo.ghcr', name: 'Ngozi Obi (DEMO GH Credit Risk)', roles: ['GH_CREDIT_RISK'], bu: 'CREDIT-RISK' },
  { username: 'demo.cro', name: 'Adebayo Ogunleye (DEMO CRO)', roles: ['CRO'], bu: 'CREDIT-RISK' },
  { username: 'demo.ed', name: 'Aisha Danjuma (DEMO ED)', roles: ['ED', 'MIC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.md', name: 'Kabir Sani (DEMO MD)', roles: ['MD', 'MIC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.mic1', name: 'Grace Etim (DEMO MIC)', roles: ['MIC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.bcc1', name: 'BCC Member One (DEMO)', roles: ['BCC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.bcc2', name: 'BCC Member Two (DEMO)', roles: ['BCC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.bcc3', name: 'BCC Member Three (DEMO)', roles: ['BCC_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.board1', name: 'Board Member One (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.board2', name: 'Board Member Two (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.board3', name: 'Board Member Three (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.board4', name: 'Board Member Four (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.legal', name: 'Bisi Akande (DEMO Legal)', roles: ['LEGAL'], bu: 'LEGAL-SERV' },
  { username: 'demo.shariah', name: 'Mallam Usman Idris (DEMO Shariah)', roles: ['SHARIAH'], bu: 'SHARIAH-COMP' },
  { username: 'demo.creditops', name: 'Kemi Adeleke (DEMO Credit Ops)', roles: ['CREDIT_OPS'], bu: 'CREDIT-OPS' },
  { username: 'demo.creditops2', name: 'Sola Bakare (DEMO Credit Ops checker)', roles: ['CREDIT_OPS'], bu: 'CREDIT-OPS' },
  { username: 'demo.admin', name: 'Gazelle Admin (DEMO)', roles: ['ADMIN'], bu: 'GAZELLE-ADMIN' },
  { username: 'demo.superadmin', name: 'Gazelle Super Admin (DEMO)', roles: ['SUPER_ADMIN'], bu: 'GAZELLE-ADMIN' },
  { username: 'demo.auditor', name: 'Internal Audit (DEMO)', roles: ['AUDITOR'], bu: 'GAZELLE-ADMIN' },
];

export async function seedDemoUsers(db: Db) {
  for (const u of DEMO_USERS) {
    const bu = BUSINESS_UNITS.find((b) => b.code === u.bu)!;
    const [row] = await q<{ id: string }>(
      db,
      `INSERT INTO app_user(ad_username, display_name, email, staff_number, directorate_code, business_unit_code, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (ad_username) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [u.username, u.name, `${u.username}@altbank.demo`, u.staffNumber ?? null, bu.directorate, u.bu],
    );
    for (const r of u.roles) await q(db, 'INSERT INTO user_role(user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row!.id, r]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEnvFile();
  const { env } = await import('../config/env.js');
  const { getPool, closePool } = await import('../db/pool.js');
  const { migrate } = await import('../db/migrate.js');
  await migrate();
  const pool = getPool();
  const { tx } = await import('../db/pool.js');
  await tx((c) => seedBaseline(c));
  console.log('baseline configuration seeded');
  if (env().APP_ENV !== 'production') {
    await tx((c) => seedDemoUsers(c));
    const { seedDemoData } = await import('./demo.js');
    await seedDemoData(pool);
    console.log('DEMO / NON-PRODUCTION users and data seeded');
  }
  await closePool();
}
