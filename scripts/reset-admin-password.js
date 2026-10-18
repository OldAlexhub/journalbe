import argon2 from 'argon2';
import {pool} from '../src/db.js';

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_RESET_PASSWORD;
if (!username || !password || password.length < 12) throw new Error('Set ADMIN_USERNAME and ADMIN_RESET_PASSWORD (12+ characters) locally');
try {
  const hash = await argon2.hash(password, {type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1});
  const result = await pool.query(
    'UPDATE admin_users SET password_hash=$1, session_version=session_version+1, updated_at=now() WHERE username=$2',
    [hash, username],
  );
  if (!result.rowCount) throw new Error('Administrator not found');
  await pool.query(`DELETE FROM "session" WHERE sess->>'adminUserId' IN (SELECT id::text FROM admin_users WHERE username=$1)`, [username]).catch(() => {});
  console.log('Administrator password reset and existing sessions invalidated.');
} finally {
  await pool.end();
}
