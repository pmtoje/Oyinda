/**
 * The only /api routes that answer without a session (deny by default). Everything else under /api gets 401 from
 * the gate in http/app.ts before any parsing, validation or lookup, so an anonymous caller learns nothing about
 * records or input formats. Each entry is "METHOD /route/template". A test fails if a route is added that is
 * neither gated nor listed, or if this list names a route that no longer exists.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // Platform
  'GET /api/meta',
  'GET /api/reference/sectors',
  // Customer onboarding (SWR §1) — protected by its own OTP challenge and strict rate limits
  'GET /api/onboarding/password-policy',
  'POST /api/onboarding/start',
  'POST /api/onboarding/resend-otp',
  'POST /api/onboarding/verify-otp',
  'POST /api/onboarding/complete',
  // Customer sign-in (password, then OTP) and the e-mail verification link
  'POST /api/auth/customer/login/start',
  'POST /api/auth/customer/login/verify',
  'POST /api/auth/customer/email/verify-link',
  // Staff sign-in (directory or interim Gazelle password; MFA is completed with the pre-MFA session)
  'POST /api/auth/staff/login',
  'GET /api/auth/staff/password/link',
  'POST /api/auth/staff/password/set',
  'POST /api/auth/staff/password/forgot',
  // Session probing and sign-out are safe without a session
  'GET /api/auth/session',
  'POST /api/auth/logout',
  // Invitation to join a business's portal (single-use token + OTP to the invitee's own mobile)
  'GET /api/portal-invites',
  'POST /api/portal-invites/phone',
  'POST /api/portal-invites/accept',
]);

export const routeKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;
