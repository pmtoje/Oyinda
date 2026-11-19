import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { env, integrationModes } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { resolveSession, SESSION_COOKIE } from '../modules/identity/session.js';
import { safeEqualHex } from '../lib/crypto.js';
import { metrics } from '../lib/metrics.js';
import { registerRoutes } from './routes.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Pre-authentication endpoints that cannot carry a CSRF token yet; protected by Origin checks + SameSite=Strict.
const CSRF_EXEMPT = [/^\/api\/onboarding\//, /^\/api\/auth\/(customer|staff)\/login/, /^\/api\/auth\/staff\/mfa/, /^\/api\/auth\/csrf$/];

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: e.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization'] },
    genReqId: () => randomUUID(),
    trustProxy: e.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        // React style attributes only; style elements and all scripts remain 'self'.
        styleSrcAttr: ["'unsafe-inline'"],
        scriptSrcAttr: ["'none'"],
        upgradeInsecureRequests: [],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    return payload;
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (r) => r.ip });
  await app.register(multipart, { limits: { fileSize: e.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20, fieldSize: 10_000 } });

  // Authentication: resolve the session cookie on every request.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = (await resolveSession(getPool(), token)) ?? undefined;
  });

  // CSRF: Origin check + synchroniser token for all state-changing requests.
  app.addHook('preHandler', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== e.WEB_ORIGIN) throw new AppError(403, 'CSRF', 'Request origin is not permitted.');
    if (CSRF_EXEMPT.some((r) => r.test(req.url))) return;
    if (!req.auth) return; // unauthenticated requests fail authorisation in the handler
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !/^[0-9a-f]{48}$/.test(header) || !safeEqualHex(header, req.auth.csrfToken)) {
      throw new AppError(403, 'CSRF', 'Your session security token is missing or invalid. Refresh the page and try again.');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    metrics.observeRequest(req.routeOptions?.url ?? 'unmatched', req.method, reply.statusCode, reply.elapsedTime);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err?.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', requestId: req.id } });
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.code === 'FST_FILES_LIMIT') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: `Files must be ${e.MAX_UPLOAD_MB} MB or smaller.`, requestId: req.id } });
    }
    if (err?.validation || err?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err instanceof SyntaxError) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be understood.', requestId: req.id } });
    }
    if (err?.statusCode === 413) return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.', requestId: req.id } });
    if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 && String(err?.code ?? '').startsWith('FST_')) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be understood.', requestId: req.id } });
    }
    // Database constraint violations → safe messages
    if (err?.code === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'This record already exists.', requestId: req.id } });
    if (err?.code === '23514' || err?.code === '22P02' || err?.code === '23503') {
      req.log.warn({ err: { code: err.code, constraint: err.constraint } }, 'constraint violation');
      return reply.status(422).send({ error: { code: 'INVALID_DATA', message: 'One or more values are not valid.', requestId: req.id } });
    }
    if (err?.code === '23P01' || String(err?.message ?? '').startsWith('GZ_IMMUTABLE')) {
      return reply.status(409).send({ error: { code: 'IMMUTABLE', message: 'This record is final and cannot be changed. Create a new version instead.', requestId: req.id } });
    }
    req.log.error({ err }, 'unhandled error');
    if (process.env.GZ_TEST_TRACE && env().APP_ENV === 'test') console.error(err);
    metrics.inc('gazelle_unhandled_errors_total');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again. If it persists, quote this reference.', requestId: req.id } });
  });

  if (!process.env.WEB_DIST_DIR) app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: req.id } }));

  app.get('/api/meta', async () => ({ data: { product: 'Gazelle by Alternative Bank', environment: e.APP_ENV, integrationModes: integrationModes(e), nonProduction: e.APP_ENV !== 'production', staffAuthMode: env().STAFF_AUTH_MODE } }));

  await registerRoutes(app);

  // Production: serve the built web app from the same origin, under the same security headers.
  const webDist = process.env.WEB_DIST_DIR;
  if (webDist) {
    const { default: fastifyStatic } = await import('@fastify/static');
    const { resolve } = await import('node:path');
    await app.register(fastifyStatic, { root: resolve(webDist), wildcard: false, index: false, maxAge: '1h', immutable: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/internal/') && !req.url.startsWith('/health')) {
        reply.header('Cache-Control', 'no-store');
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: req.id } });
    });
  }
  return app;
}
