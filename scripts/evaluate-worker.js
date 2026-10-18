import 'dotenv/config';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configured = String(process.env.PYTHON_BIN || '').trim();
const configuredPath = configured
  ? (path.isAbsolute(configured) ? configured : path.resolve(serverRoot, configured))
  : '';
const managedPython = path.join(
  serverRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
const python = configuredPath && existsSync(configuredPath) ? configuredPath : managedPython;

if (!existsSync(python)) {
  console.error('Text-worker environment is missing. Run npm run worker:prepare.');
  process.exitCode = 1;
} else {
  const result = spawnSync(python, [path.join(serverRoot, 'worker', 'evaluate.py')], {
    cwd: serverRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
}
