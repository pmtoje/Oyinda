import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import type { Actor } from '../modules/audit/audit.js';
import type { AuthContext, CustomerPrincipal, StaffPrincipal } from '../modules/identity/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function actorOf(req: FastifyRequest): Actor {
  const a = req.auth;
  return {
    type: a ? a.subjectType : 'ANONYMOUS',
    id: a?.subjectId ?? null,
    label: a?.staff?.name ?? a?.customer?.fullName ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id,
  };
}

export function requireStaff(req: FastifyRequest, ...perms: string[]): StaffPrincipal {
  const a = req.auth;
  if (!a || a.subjectType !== 'STAFF' || !a.staff) throw unauthorized();
  if (!a.mfaSatisfied) throw unauthorized('Multi-factor authentication is required.');
  for (const p of perms) if (!a.staff.permissions.has(p)) throw forbidden();
  return a.staff;
}

export function requireAnyPerm(req: FastifyRequest, perms: string[]): StaffPrincipal {
  const s = requireStaff(req);
  if (!perms.some((p) => s.permissions.has(p))) throw forbidden();
  return s;
}

/** A customer user holding a portal right (SUBMIT_REQUESTS, RESPOND_TO_OFFERS, MANAGE_USERS). */
export function requireCustomerRight(req: FastifyRequest, right: 'SUBMIT_REQUESTS' | 'RESPOND_TO_OFFERS' | 'MANAGE_USERS'): CustomerPrincipal {
  const c = requireCustomer(req);
  if (!c.permissions.includes(right)) throw forbidden(right === 'SUBMIT_REQUESTS' ? 'Your portal access does not include submitting requests. Ask a colleague with that right, or your user administrator.' : right === 'RESPOND_TO_OFFERS' ? 'Your portal access does not include responding to offers on behalf of the business.' : 'Your portal access does not include managing users.');
  return c;
}

export function requireCustomer(req: FastifyRequest): CustomerPrincipal {
  const a = req.auth;
  if (!a || a.subjectType !== 'CUSTOMER' || !a.customer) throw unauthorized();
  return a.customer;
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('VALIDATION', 'Some fields need attention.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

export const ok = <T>(reply: FastifyReply, data: T, status = 200) => reply.status(status).send({ data });
