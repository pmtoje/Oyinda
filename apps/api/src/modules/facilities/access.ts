import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/pool.js';
import { maybe } from '../../db/pool.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import type { StaffPrincipal } from '../identity/session.js';

/**
 * Object-level authorisation. Every facility/customer lookup goes through here.
 * A record the caller may not access is reported as NOT FOUND (no existence oracle).
 */
export async function staffCanSeeCustomer(db: Db, s: StaffPrincipal, customerId: string): Promise<boolean> {
  if (s.permissions.has('customer.view.all')) return true;
  if (!s.permissions.has('customer.view.assigned')) return false;
  const c = await maybe<{ relationship_manager_id: string | null; business_unit_code: string | null }>(db, 'SELECT relationship_manager_id, business_unit_code FROM customer WHERE id=$1', [customerId]);
  if (!c) return false;
  if (c.relationship_manager_id === s.id) return true;
  // BM/RBE/DH see their business unit's portfolio; RMs see only their own customers.
  return !s.roles.every((r) => r === 'RM') && !!s.businessUnit && c.business_unit_code === s.businessUnit;
}

export async function staffCanSeeFacility(db: Db, s: StaffPrincipal, f: { id: string; customer_id: string; status: string }): Promise<boolean> {
  if (s.permissions.has('facility.view.all') && f.status !== 'DRAFT') return true;
  if (await staffCanSeeCustomer(db, s, f.customer_id)) return true;
  // Anyone who holds or held a task on the facility (e.g. committee member).
  const t = await maybe(db, 'SELECT 1 FROM workflow_task WHERE facility_id=$1 AND (assigned_user_id=$2 OR claimed_by=$2 OR completed_by=$2 OR role_code = ANY($3)) LIMIT 1', [f.id, s.id, s.roles]);
  return !!t;
}

export async function loadFacility(db: Db, req: FastifyRequest, facilityId: string, opts: { forUpdate?: boolean } = {}) {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (!/^[0-9a-f-]{36}$/i.test(facilityId)) throw notFound('Facility');
  const f = await maybe<any>(db, `SELECT * FROM facility_request WHERE id=$1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`, [facilityId]);
  if (!f) throw notFound('Facility');
  if (a.subjectType === 'CUSTOMER') {
    if (f.customer_id !== a.customer!.customerId) throw notFound('Facility');
    return f;
  }
  if (!a.mfaSatisfied || !a.staff) throw unauthorized();
  if (!(await staffCanSeeFacility(db, a.staff, f))) throw notFound('Facility');
  return f;
}

/** Resolve the customer a request acts on. Customers act only on themselves; staff need portfolio access. */
export async function resolveCustomer(db: Db, req: FastifyRequest, customerId?: string, needManage = false): Promise<string> {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (a.subjectType === 'CUSTOMER') {
    if (customerId && customerId !== a.customer!.customerId) throw notFound('Customer');
    return a.customer!.customerId;
  }
  if (!a.mfaSatisfied || !a.staff) throw unauthorized();
  if (!customerId || !/^[0-9a-f-]{36}$/i.test(customerId)) throw notFound('Customer');
  if (!(await staffCanSeeCustomer(db, a.staff, customerId))) throw notFound('Customer');
  if (needManage && !a.staff.permissions.has('customer.manage')) throw forbidden();
  return customerId;
}
