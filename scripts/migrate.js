import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pool} from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(here, '..', 'migrations');

try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()) {
    const seen = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (seen.rowCount) continue;
    const sql = await readFile(path.join(migrationDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
