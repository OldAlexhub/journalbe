import pg from 'pg';
import {createHash, timingSafeEqual} from 'node:crypto';
import {databaseConfig} from './database-config.js';

const {Pool} = pg;
export const pool = new Pool({
  connectionString: databaseConfig.databaseUrl || undefined,
  ssl: databaseConfig.databaseSsl ? {rejectUnauthorized: true} : false,
  max: 10,
  application_name: 'innerfolio-server',
});

pool.on('error', error => {
  console.error(JSON.stringify({event: 'postgres_pool_error', code: error.code || 'unknown'}));
});

export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function secureHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export async function checkDatabase() {
  const started = Date.now();
  try {
    await pool.query('SELECT 1');
    return {ready: true, latencyMs: Date.now() - started};
  } catch (error) {
    return {ready: false, code: error.code || 'DATABASE_UNAVAILABLE'};
  }
}

export async function audit(adminId, action, targetType, targetId, details = {}) {
  await pool.query(
    `INSERT INTO admin_audit (admin_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [adminId || null, action, targetType || null, targetId || null, JSON.stringify(details)],
  );
}
