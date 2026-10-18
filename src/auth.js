import {randomUUID, timingSafeEqual} from 'node:crypto';
import {sha256, secureHexEqual, pool} from './db.js';

export async function installationAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/.exec(header);
  if (!match) return res.status(401).json({error: {code: 'INSTALLATION_AUTH_REQUIRED'}});
  try {
    const result = await pool.query('SELECT id, credential_hash FROM installations WHERE id=$1 AND revoked_at IS NULL AND deleted_at IS NULL', [match[1]]);
    const row = result.rows[0];
    if (!row || !secureHexEqual(row.credential_hash, sha256(match[2]))) return res.status(401).json({error: {code: 'INVALID_INSTALLATION_CREDENTIAL'}});
    req.installationId = row.id;
    await pool.query('UPDATE installations SET last_seen_at=now() WHERE id=$1', [row.id]);
    next();
  } catch (error) { next(error); }
}

export function requireAdmin(req, res, next) {
  if (!req.session?.adminUserId) return res.redirect('/admin/login');
  next();
}

export function requireAdminApi(req, res, next) {
  if (!req.session?.adminUserId) return res.status(401).json({error: {code: 'ADMIN_AUTH_REQUIRED'}});
  next();
}

export function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = randomUUID().replaceAll('-', '');
  return req.session.csrfToken;
}

export function rotateCsrfToken(req) {
  req.session.csrfToken = randomUUID().replaceAll('-', '');
  return req.session.csrfToken;
}

export function hasValidCsrf(req) {
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrfToken;
  if (typeof supplied !== 'string' || typeof expected !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
}

export function requireCsrf(req, res, next) {
  if (!hasValidCsrf(req)) return res.status(403).send('This form has expired. Refresh the page and try again.');
  next();
}
