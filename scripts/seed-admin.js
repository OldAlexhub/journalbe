import {pool} from '../src/db.js';
import {provisionInitialAdministrator} from '../src/admin-provisioning.js';

try {
  const administrator = await provisionInitialAdministrator(pool);
  console.log(administrator.created
    ? 'Initial administrator created with an Argon2id password hash.'
    : 'Administrator already exists; no changes made.');
} finally {
  await pool.end();
}
