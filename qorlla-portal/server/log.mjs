// One JSON object per line on stdout (easy to ship). Never pass cookies, tokens, request bodies or secrets in here.
import crypto from 'node:crypto';
export function createLogger(sink = (line) => process.stdout.write(line + '\n'), service = 'qorlla-portal') {
  const emit = (level, msg, fields = {}) => sink(JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...fields }));
  return { info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
export function requestLogger(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    req.id = (req.get('x-request-id') || crypto.randomUUID()).slice(0, 64).replace(/[^\w.-]/g, '');
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // path only (no query string: it can carry tokens); actor is an opaque UUID
      log.info('request', { req_id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10, actor: req.actor || undefined, workspace: req.workspace || undefined });
    });
    next();
  };
}
