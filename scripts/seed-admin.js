import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/db.js';

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_INITIAL_PASSWORD;
if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD in the private environment');
if (username.length < 3 || username.length > 80 || password.length < 12) throw new Error('Admin username or password does not meet length requirements');

try {
  const existing = await pool.query('SELECT id FROM admin_users WHERE username=$1', [username]);
  if (existing.rowCount) {
    console.log('Administrator already exists; no changes made.');
  } else {
    const passwordHash = await argon2.hash(password, {type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1});
    await pool.query('INSERT INTO admin_users(id, username, password_hash) VALUES($1,$2,$3)', [randomUUID(), username, passwordHash]);
    console.log('Administrator created. Remove ADMIN_INITIAL_PASSWORD from the process environment now.');
  }
} finally {
  await pool.end();
}
