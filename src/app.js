import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';
import {pool, checkDatabase} from './db.js';
import {apiRouter} from './api-routes.js';
import {adminRouter} from './admin-routes.js';
import {fixedWindowRateLimit} from './rate-limit.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PgSession = connectPgSimple(session);

export function createApp({queue, worker, startedAt = Date.now()}) {
  const app = express();
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.use(helmet({contentSecurityPolicy: {directives: {defaultSrc: ["'self'"], styleSrc: ["'self'"]}}}));
  app.use('/admin-assets', express.static(path.join(root, 'public'), {dotfiles: 'deny', index: false, maxAge: config.env === 'production' ? '1h' : 0}));

  app.get(['/health', '/healthz'], (_req, res) => res.status(200).type('text/plain').send('ok'));
  app.get('/ready', async (_req, res) => {
    const database = await checkDatabase();
    const status = {ready: database.ready && worker.ready, express: true, database, textWorker: worker.status()};
    res.status(status.ready ? 200 : 503).json(status);
  });
  app.get('/privacy', (_req, res) => res.sendFile(path.join(root, 'public', 'privacy.html')));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && ['POST','PUT','PATCH'].includes(req.method) && req.get('content-type')?.split(';')[0] !== 'application/json') {
      return res.status(415).json({error: {code: 'JSON_ONLY'}});
    }
    next();
  });
  app.use(express.json({limit: '256kb', strict: true, type: 'application/json'}));
  app.use(express.urlencoded({extended: false, limit: '32kb'}));

  app.use('/api/v1', fixedWindowRateLimit({windowMs: 60_000, limit: 90, json: true}), apiRouter(queue));

  app.use(session({
    name: 'innerfolio.admin',
    store: new PgSession({pool, tableName: 'session', createTableIfMissing: true, pruneSessionInterval: 60}),
    secret: config.sessionSecret || 'development-only-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {httpOnly: true, secure: config.env === 'production', sameSite: 'lax', maxAge: 30 * 60 * 1000},
  }));
  app.use('/admin', adminRouter(queue, worker, startedAt));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({error: {code: 'NOT_FOUND'}});
    res.status(404).type('text/plain').send('Not found');
  });
  app.use((error, req, res, _next) => {
    const code = error.type === 'entity.too.large' ? 'REQUEST_TOO_LARGE' : error.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'INTERNAL_ERROR';
    console.error(JSON.stringify({event: 'request_error', code, method: req.method, path: req.path}));
    if (req.path.startsWith('/api/')) return res.status(code === 'INTERNAL_ERROR' ? 500 : 400).json({error: {code}});
    res.status(500).type('text/plain').send('The request could not be completed.');
  });
  return app;
}
