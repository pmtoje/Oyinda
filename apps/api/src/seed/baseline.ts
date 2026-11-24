import type { Db } from '../db/pool.js';
import { q } from '../db/pool.js';
import { SYSTEM } from '../modules/audit/audit.js';
import { reconcileBaseline } from '../modules/config/service.js';
import { PERMISSIONS, ROLES } from '../modules/identity/rbac.js';
import { BASELINE, BASELINE_RELEASE, BASELINE_RETIRED } from './baseline-config.js';
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
  // Roles removed from the catalogue keep their rows for history but lose their permissions.
  const current = new Set(ROLES.map((r) => r.code));
  const stale = (await q<{ code: string }>(db, 'SELECT code FROM role')).map((r) => r.code).filter((c) => !current.has(c));
  if (stale.length) await q(db, 'DELETE FROM role_permission WHERE role_code = ANY($1)', [stale]);
  await reconcileBaseline(db, SYSTEM, BASELINE_RELEASE, BASELINE, BASELINE_RETIRED);
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
  { username: 'demo.ed', name: 'Aisha Danjuma (DEMO Line ED)', roles: ['ED'], bu: 'EXECUTIVE' },
  { username: 'demo.ed2', name: 'Yemi Coker (DEMO ED)', roles: ['ED'], bu: 'EXECUTIVE' },
  { username: 'demo.md', name: 'Kabir Sani (DEMO MD)', roles: ['MD'], bu: 'EXECUTIVE' },
  { username: 'demo.ned1', name: 'NED One (DEMO)', roles: ['NED'], bu: 'EXECUTIVE' },
  { username: 'demo.ned2', name: 'NED Two (DEMO)', roles: ['NED'], bu: 'EXECUTIVE' },
  { username: 'demo.ned3', name: 'NED Three (DEMO)', roles: ['NED'], bu: 'EXECUTIVE' },
  { username: 'demo.brmcchair', name: 'BRMC Chairman (DEMO)', roles: ['BRMC_CHAIR'], bu: 'EXECUTIVE' },
  { username: 'demo.brmc1', name: 'BRMC Member One (DEMO NED)', roles: ['BRMC_MEMBER', 'NED'], bu: 'EXECUTIVE' },
  { username: 'demo.brmc2', name: 'BRMC Member Two (DEMO NED)', roles: ['BRMC_MEMBER', 'NED'], bu: 'EXECUTIVE' },
  { username: 'demo.boardchair', name: 'Board Chairman (DEMO)', roles: ['BOARD_CHAIR'], bu: 'EXECUTIVE' },
  { username: 'demo.board1', name: 'Board Member One (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.board4', name: 'Board Member Two (DEMO)', roles: ['BOARD_MEMBER'], bu: 'EXECUTIVE' },
  { username: 'demo.legal', name: 'Bisi Akande (DEMO Legal)', roles: ['LEGAL'], bu: 'LEGAL-SERV' },
  { username: 'demo.shariah', name: 'Mallam Usman Idris (DEMO Shariah)', roles: ['SHARIAH'], bu: 'SHARIAH-COMP' },
  { username: 'demo.creditops', name: 'Kemi Adeleke (DEMO Credit Ops)', roles: ['CREDIT_OPS'], bu: 'CREDIT-OPS' },
  { username: 'demo.creditops2', name: 'Sola Bakare (DEMO Credit Ops checker)', roles: ['CREDIT_OPS'], bu: 'CREDIT-OPS' },
  { username: 'demo.kyc', name: 'Rukayat Bello (DEMO KYC Officer)', roles: ['KYC_OFFICER'], bu: 'KYC-COMP' },
  { username: 'demo.kyc2', name: 'Femi Ojo (DEMO KYC checker)', roles: ['KYC_OFFICER'], bu: 'KYC-COMP' },
  { username: 'demo.admin', name: 'Credit360 Admin (DEMO)', roles: ['ADMIN'], bu: 'GAZELLE-ADMIN' },
  { username: 'demo.superadmin', name: 'Credit360 Super Admin (DEMO)', roles: ['SUPER_ADMIN'], bu: 'GAZELLE-ADMIN' },
  { username: 'demo.auditor', name: 'Internal Audit (DEMO)', roles: ['AUDITOR'], bu: 'GAZELLE-ADMIN' },
];

export async function seedDemoUsers(db: Db) {
  for (const u of DEMO_USERS) {
    const bu = BUSINESS_UNITS.find((b) => b.code === u.bu)!;
    const [row] = await q<{ id: string }>(
      db,
      `INSERT INTO app_user(ad_username, display_name, email, staff_number, directorate_code, business_unit_code, is_demo, source)
       VALUES ($1,$2,$3,$4,$5,$6,true,'SEED') ON CONFLICT (ad_username) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
      [u.username, u.name, `${u.username}@altbank.demo`, u.staffNumber ?? null, bu.directorate, u.bu],
    );
    for (const r of u.roles) await q(db, 'INSERT INTO user_role(user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row!.id, r]);
  }
  // DEMO reporting line: the Lagos RM reports to the Lagos Team Lead.
  await q(db, `UPDATE app_user SET manager_id=(SELECT id FROM app_user WHERE ad_username='demo.bm') WHERE ad_username='demo.rm' AND manager_id IS NULL`);
}

