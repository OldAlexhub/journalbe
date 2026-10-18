import assert from 'node:assert/strict';
import test from 'node:test';
import {provisionInitialAdministrator} from '../src/admin-provisioning.js';

function databaseWithExistingCount(existingCount) {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({sql, parameters});
      if (sql === 'SELECT id FROM admin_users LIMIT 1') return {rowCount: existingCount};
      return {rowCount: 1};
    },
    release() {
      calls.push({sql: 'RELEASE', parameters: []});
    },
  };
  return {database: {connect: async () => client}, calls};
}

test('first database setup inserts a hash and never the cleartext password', async () => {
  const {database, calls} = databaseWithExistingCount(0);
  const cleartext = 'a-long-private-password';
  const result = await provisionInitialAdministrator(database, {
    username: 'owner',
    password: cleartext,
    passwordHasher: async supplied => {
      assert.equal(supplied, cleartext);
      return '$argon2id$test-only-hash';
    },
  });

  assert.deepEqual(result, {created: true});
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO admin_users'));
  assert.equal(insert.parameters[1], 'owner');
  assert.equal(insert.parameters[2], '$argon2id$test-only-hash');
  assert.ok(!insert.parameters.includes(cleartext));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('an existing administrator is never changed by deployment variables', async () => {
  const {database, calls} = databaseWithExistingCount(1);
  let hashCalls = 0;
  const result = await provisionInitialAdministrator(database, {
    username: 'replacement',
    password: 'another-private-password',
    passwordHasher: async () => {
      hashCalls += 1;
      return 'unused';
    },
  });

  assert.deepEqual(result, {created: false});
  assert.equal(hashCalls, 0);
  assert.ok(!calls.some(call => call.sql.startsWith('INSERT INTO admin_users')));
});

test('first setup fails safely when private credentials are missing', async () => {
  const {database, calls} = databaseWithExistingCount(0);
  await assert.rejects(
    provisionInitialAdministrator(database, {username: '', password: ''}),
    /ADMIN_USERNAME and ADMIN_INITIAL_PASSWORD/,
  );
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!calls.some(call => call.sql.startsWith('INSERT INTO admin_users')));
});
