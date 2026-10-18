import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';

const hashPassword = password => argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});

/**
 * Creates the first administrator after migrations have created admin_users.
 * Once any administrator exists, deployment never changes credentials or adds
 * another account from environment variables.
 */
export async function provisionInitialAdministrator(database, options = {}) {
  const username = String(options.username ?? process.env.ADMIN_USERNAME ?? '').trim();
  const password = String(options.password ?? process.env.ADMIN_INITIAL_PASSWORD ?? '');
  const passwordHasher = options.passwordHasher ?? hashPassword;
  const client = typeof database.connect === 'function' ? await database.connect() : database;

  try {
    await client.query('BEGIN');
    // Serialize first-account provisioning if two setup processes overlap.
    await client.query('SELECT pg_advisory_xact_lock(105879, 1)');
    const existing = await client.query('SELECT id FROM admin_users LIMIT 1');
    if (existing.rowCount) {
      await client.query('COMMIT');
      return {created: false};
    }

    if (!username || !password) {
      throw new Error('Set ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD in the private environment before the first database setup');
    }
    if (username.length < 3 || username.length > 80 || password.length < 12) {
      throw new Error('Admin username or password does not meet length requirements');
    }

    const passwordHash = await passwordHasher(password);
    await client.query(
      'INSERT INTO admin_users(id, username, password_hash) VALUES($1,$2,$3)',
      [randomUUID(), username, passwordHash],
    );
    await client.query('COMMIT');
    return {created: true};
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the provisioning error if PostgreSQL has already disconnected.
    }
    throw error;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}
