import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import ejs from 'ejs';

const headerFile = fileURLToPath(new URL('../views/partials/header.ejs', import.meta.url));

test('authenticated admin header renders every action with a visible logout control', async () => {
  const html = await ejs.renderFile(headerFile, {
    title: 'Operations',
    adminUsername: 'owner',
    currentPath: '/settings',
    csrf: () => 'test-csrf-token',
  });

  for (const label of ['Dashboard', 'Jobs', 'Text worker', 'Installations', 'Settings', 'Audit', 'Security', 'Log out']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /class="nav-logout"/);
  assert.match(html, /class="logout-button"[^>]*>Log out</);
  assert.match(html, /class="active" href="\/admin\/settings"[^>]*aria-current="page"/);
});

test('admin stylesheet isolates navigation forms and defines responsive layouts', async () => {
  const css = await readFile(new URL('../public/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.nav-logout\s*\{/);
  assert.match(css, /\.logout-button\s*\{/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /article,\s*\.auth,\s*form,\s*dl/);
});
