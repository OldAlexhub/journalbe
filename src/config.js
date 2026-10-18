import 'dotenv/config';
import {databaseConfig} from './database-config.js';

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
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://jorunal.server.oldalexhub.com',
  databaseUrl: databaseConfig.databaseUrl,
  databaseSsl: databaseConfig.databaseSsl,
  pythonBin: process.env.PYTHON_BIN || (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'),
  nlpModel: process.env.NLP_MODEL || 'en_core_web_sm',
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
