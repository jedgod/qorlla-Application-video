// Configuration from the environment, validated once at start-up. Unsafe production settings stop the process.
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL || '';
  const provider = /^file:/i.test(databaseUrl) ? 'sqlite' : /^postgres(ql)?:/i.test(databaseUrl) ? 'postgresql' : '';
  if (!provider) throw new Error('DATABASE_URL must start with file: (SQLite) or postgresql:// (PostgreSQL)');

  const authMode = env.AUTH_MODE || (production ? 'qorlla' : 'dev');
  if (!['qorlla', 'dev'].includes(authMode)) throw new Error('AUTH_MODE must be "qorlla" or "dev"');
  if (production && authMode !== 'qorlla') throw new Error('AUTH_MODE=dev is not allowed when NODE_ENV=production');
  if (authMode === 'qorlla' && !env.QORLLA_MAIN_URL) throw new Error('QORLLA_MAIN_URL is required when AUTH_MODE=qorlla');
  if (production && provider === 'sqlite') throw new Error('SQLite is for local testing; use PostgreSQL when NODE_ENV=production');

  const MiB = 1048576;
  const partBytes = Math.round(Number(env.UPLOAD_PART_MB || 8) * MiB);
  const maxUploadBytes = Math.round(Number(env.MAX_UPLOAD_MB || 2048) * MiB);
  if (!(partBytes >= 5 * MiB)) throw new Error('UPLOAD_PART_MB must be at least 5 (object stores refuse smaller parts except the last)');
  if (Math.ceil(maxUploadBytes / partBytes) > 10000) throw new Error('MAX_UPLOAD_MB / UPLOAD_PART_MB would need more than 10000 parts, the object-store limit');
  const s3 = {
    endpoint: env.S3_ENDPOINT || '',
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || '',
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET || '',
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',
    sse: env.S3_SSE || '',
    autoCreateBucket: env.S3_AUTO_CREATE_BUCKET === '1',
  };
  if (production && s3.autoCreateBucket) throw new Error('S3_AUTO_CREATE_BUCKET is for development; create and secure the bucket yourself in production');

  const webhookSecret = env.QORLLA_WEBHOOK_SECRET || '';
  if (webhookSecret && webhookSecret.length < 32) throw new Error('QORLLA_WEBHOOK_SECRET must be at least 32 characters (generate one with: openssl rand -hex 32)');
  if (webhookSecret && !list(env.MEDIA_HOSTS).length) throw new Error('QORLLA_WEBHOOK_SECRET is set but MEDIA_HOSTS is empty: ingested links would have nowhere safe to point');

  return {
    production, webhookSecret, provider, databaseUrl, authMode,
    s3, storageEnabled: !!(s3.bucket && s3.accessKeyId && s3.secretAccessKey),
    uploadPartBytes: partBytes, maxUploadBytes,
    uploadTtlMs: Math.round(Number(env.UPLOAD_TTL_HOURS || 24) * 3600 * 1000),
    playbackSeconds: Number(env.PLAYBACK_URL_SECONDS || 900),
    port: Number(env.PORT || 5400),
    mainUrl: (env.QORLLA_MAIN_URL || '').replace(/\/+$/, ''),
    orgSlug: env.ORG_SLUG || 'default',
    orgName: env.ORG_NAME || 'Qorlla',
    adminUsernames: list(env.ADMIN_USERNAMES).map((s) => s.toLowerCase()),
    corsOrigins: list(env.CORS_ORIGINS),
    // completing a clip (attaching its media) is a service-to-service call, never a browser one
    serviceKey: env.SERVICE_KEY || '',
    mediaHosts: list(env.MEDIA_HOSTS).map((s) => s.toLowerCase()),
    // free-plan quota per account: the real defence against bulk account creation is that extra free accounts are worth very little
    freeMaxClips: Math.max(1, Number(env.FREE_MAX_CLIPS || 25)),
    freeStorageBytes: Math.round(Math.max(1, Number(env.FREE_MAX_STORAGE_MB || 1024)) * 1048576),
    trustProxy: env.TRUST_PROXY === '1',
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 600),
    identityCacheMs: Number(env.IDENTITY_CACHE_MS || 0),
  };
}
