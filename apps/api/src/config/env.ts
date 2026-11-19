import { z } from 'zod';

const integrationMode = z.enum(['mock', 'live']);

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** 32-byte base64 key used for keyed hashing (OTP, lookup hashes, CSRF). Supplied by the secrets manager. */
  HMAC_KEY: z.string().min(40),
  /** 32-byte base64 master key for the local KMS adapter. In production a real KMS/HSM adapter is used instead. */
  DATA_KEY: z.string().min(40),
  DATA_KEY_ID: z.string().default('local-v1'),
  STORAGE_DIR: z.string().default('./storage'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(8),
  AUTH_RATE_LIMIT_PER_15MIN: z.coerce.number().int().positive().default(10),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CBA_MODE: integrationMode.default('mock'),
  IDENTITY_MODE: integrationMode.default('mock'),
  MESSAGING_MODE: integrationMode.default('mock'),
  AD_MODE: integrationMode.default('mock'),
  BUREAU_MODE: integrationMode.default('mock'),
  RARORAC_MODE: integrationMode.default('mock'),
  AV_MODE: integrationMode.default('mock'),
  AI_MODE: z.enum(['off', 'local', 'private-endpoint']).default('local'),
  AI_ENDPOINT_URL: z.string().url().optional(),
  AI_ENDPOINT_HOST_ALLOWLIST: z.string().default(''),
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().int().optional(),
  LDAP_URL: z.string().optional(),
  ALLOW_MOCK_IN_PRODUCTION: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.APP_ENV === 'production') {
    const mocks = (['CBA_MODE', 'IDENTITY_MODE', 'MESSAGING_MODE', 'AD_MODE', 'BUREAU_MODE', 'RARORAC_MODE', 'AV_MODE'] as const).filter(
      (k) => env[k] === 'mock',
    );
    if (mocks.length && !env.ALLOW_MOCK_IN_PRODUCTION) {
      throw new Error(`Refusing to start in production with mock integrations: ${mocks.join(', ')}`);
    }
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  }
  return env;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function setEnvForTests(e: Env): void {
  cached = e;
}

export function integrationModes(e: Env = env()) {
  return {
    cba: e.CBA_MODE,
    identity: e.IDENTITY_MODE,
    messaging: e.MESSAGING_MODE,
    activeDirectory: e.AD_MODE,
    bureau: e.BUREAU_MODE,
    rarorac: e.RARORAC_MODE,
    antivirus: e.AV_MODE,
    ai: e.AI_MODE,
  };
}
