import { z } from 'zod';
export const config = z.object({
 DATABASE_URL:z.string().min(1), JWT_ISSUER:z.string().url(), JWT_AUDIENCE:z.string().min(1),
 JWKS_URL:z.string().url(), PORT:z.coerce.number().int().min(1).max(65535).default(3105),
 PROVIDER_MODE:z.enum(['disabled','mock']).default('disabled'),
 WORKER_ENABLED:z.enum(['true','false']).default('false'),
 PROVIDER_WEBHOOK_SECRET:z.string().min(32),
 COUNTRY_ALLOWLIST:z.string().default('US,GB'),
}).parse(process.env);
export const allowedCountries = new Set(config.COUNTRY_ALLOWLIST.split(',').map(x=>x.trim().toUpperCase()));
