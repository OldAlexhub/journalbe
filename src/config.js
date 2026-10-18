import 'dotenv/config';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {databaseConfig} from './database-config.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configuredPython = String(process.env.PYTHON_BIN || '').trim();
const configuredPythonPath = configuredPython
  ? (path.isAbsolute(configuredPython) ? configuredPython : path.resolve(serverRoot, configuredPython))
  : '';
const defaultPython = path.join(
  serverRoot,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);

const integer = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 8787, 1, 65535),
  publicBaseUrl: 'https://journal.server.oldalexhub.com',
  databaseUrl: databaseConfig.databaseUrl,
  databaseSsl: databaseConfig.databaseSsl,
  pythonBin: configuredPythonPath && existsSync(configuredPythonPath) ? configuredPythonPath : defaultPython,
  nlpModel: process.env.NLP_MODEL || 'en_core_web_sm',
  workerStartupTimeoutMs: integer('WORKER_STARTUP_TIMEOUT_MS', 120000, 5000, 300000),
  queueMax: integer('QUEUE_MAX', 24, 1, 1000),
  workerConcurrency: integer('WORKER_CONCURRENCY', 1, 1, 4),
  jobTimeoutMs: integer('JOB_TIMEOUT_MS', 45000, 1000, 300000),
  resultTtlSeconds: integer('RESULT_TTL_SECONDS', 900, 60, 3600),
  trustProxyHops: integer('TRUST_PROXY_HOPS', 1, 0, 4),
  sessionSecret: process.env.SESSION_SECRET || '',
});

export function assertProductionConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
}
