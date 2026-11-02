import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    APP_BASE_URL: z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, '')),
    DATABASE_PATH: z.string().default('./data/app.db'),
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    WIX_APP_ID: z.string().min(1),
    WIX_APP_SECRET: z.string().min(1),
    WIX_PUBLIC_KEY: z
      .string()
      .min(1)
      .transform((k) => k.replace(/\\n/g, '\n')),
    HUBSPOT_CLIENT_ID: z.string().min(1),
    HUBSPOT_CLIENT_SECRET: z.string().min(1),
    SECRET_STORE: z.enum(['local', 'gcp']).default('local'),
    TOKEN_ENCRYPTION_KEY: z.string().optional(),
    GCP_PROJECT_ID: z.string().optional(),
    DEV_LOGIN_ENABLED: flag,
  })
  .superRefine((c, ctx) => {
    if (c.SECRET_STORE === 'local' && !c.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['TOKEN_ENCRYPTION_KEY'], message: 'required when SECRET_STORE=local' });
    }
    if (c.SECRET_STORE === 'gcp' && !c.GCP_PROJECT_ID) {
      ctx.addIssue({ code: 'custom', path: ['GCP_PROJECT_ID'], message: 'required when SECRET_STORE=gcp' });
    }
    if (c.NODE_ENV === 'production' && c.DEV_LOGIN_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_ENABLED'], message: 'must be false in production' });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
