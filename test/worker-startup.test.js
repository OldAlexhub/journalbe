import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {WorkerClient} from '../src/worker-client.js';

test('install and start automatically prepare the text model', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.postinstall, 'node scripts/prepare-worker.js');
  assert.equal(packageJson.scripts.prestart, 'node scripts/prepare-worker.js');
});

test('the managed worker starts with its configured model loaded', async t => {
  const worker = new WorkerClient();
  t.after(() => worker.stop());
  worker.start();
  const model = await worker.waitUntilReady(30000);
  assert.ok(model.name);
  assert.ok(model.version);
  assert.ok(model.pipes.includes('ner'));
  assert.equal(worker.status().ready, true);
});
