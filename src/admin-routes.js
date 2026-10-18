import {Router} from 'express';
import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import {pool, audit, checkDatabase} from './db.js';
import {requireAdmin, requireCsrf, csrfToken, hasValidCsrf, rotateCsrfToken} from './auth.js';
import {config} from './config.js';
import {fixedWindowRateLimit} from './rate-limit.js';

const loginLimiter = fixedWindowRateLimit({windowMs:15*60*1000,limit:8,message:'Too many login attempts. Try again later.'});

export function adminRouter(queue, worker, startedAt) {
  const router = Router();
  router.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.csrf = () => csrfToken(req);
    next();
  });

  router.get('/login', (req, res) => {
    if (req.session?.adminUserId) return res.redirect('/admin');
    res.render('login', {title: 'Admin sign in', error: null});
  });

  router.post('/login', loginLimiter, (req, res, next) => {
    if (hasValidCsrf(req)) return next();
    rotateCsrfToken(req);
    return res.status(403).render('login', {
      title: 'Admin sign in',
      error: 'Your sign-in page expired. Please try again.',
    });
  }, async (req, res, next) => {
    try {
      const username = String(req.body.username || '').slice(0, 80);
      const password = String(req.body.password || '');
      const result = await pool.query('SELECT id,username,password_hash,session_version FROM admin_users WHERE username=$1', [username]);
      const admin = result.rows[0];
      const valid = admin ? await argon2.verify(admin.password_hash, password) : false;
      if (!valid) {
        await audit(null, 'admin.login_failed', 'admin', username || 'empty');
        return res.status(401).render('login', {title: 'Admin sign in', error: 'The username or password is incorrect.'});
      }
      req.session.regenerate(error => {
        if (error) return next(error);
        req.session.adminUserId = admin.id;
        req.session.adminUsername = admin.username;
        req.session.sessionVersion = admin.session_version;
        req.session.csrfToken = randomUUID().replaceAll('-', '');
        pool.query('UPDATE admin_users SET last_login_at=now() WHERE id=$1', [admin.id]).catch(() => {});
        audit(admin.id, 'admin.login', 'admin', admin.id).catch(() => {});
        res.redirect('/admin');
      });
    } catch (error) { next(error); }
  });

  router.use(requireAdmin);
  router.use(async (req, res, next) => {
    try {
      const result = await pool.query('SELECT session_version FROM admin_users WHERE id=$1', [req.session.adminUserId]);
      if (!result.rowCount || result.rows[0].session_version !== req.session.sessionVersion) {
        return req.session.destroy(() => res.redirect('/admin/login'));
      }
      res.locals.adminUsername = req.session.adminUsername;
      next();
    } catch (error) { next(error); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const [database, counts, errors] = await Promise.all([
        checkDatabase(),
        pool.query(`SELECT status,count(*)::int AS count FROM analysis_jobs GROUP BY status`),
        pool.query('SELECT code,component,occurred_at FROM operational_errors ORDER BY occurred_at DESC LIMIT 10'),
      ]);
      const jobs = Object.fromEntries(counts.rows.map(row => [row.status, row.count]));
      res.render('dashboard', {title: 'Operations', database, worker: worker.status(), queue: {depth: queue.depth, paused: queue.paused}, jobs, errors: errors.rows, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)});
    } catch (error) { next(error); }
  });

  router.get('/jobs', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT id,installation_id,status,entry_revision,created_at,started_at,completed_at,duration_ms,error_code FROM analysis_jobs ORDER BY created_at DESC LIMIT 200`);
      res.render('jobs', {title: 'Jobs', jobs: result.rows});
    } catch (error) { next(error); }
  });

  router.post('/jobs/:id/cancel', requireCsrf, async (req, res, next) => {
    try {
      await queue.cancel(req.params.id);
      await audit(req.session.adminUserId, 'job.cancel', 'analysis_job', req.params.id);
      res.redirect('/admin/jobs');
    } catch (error) { next(error); }
  });

  router.get('/worker', (req, res) => res.render('worker', {title: 'Text worker', status: worker.status(), configuredModel: config.nlpModel}));

  router.get('/installations', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT i.id,i.created_at,i.last_seen_at,i.revoked_at,i.deleted_at,count(j.id)::int AS job_count FROM installations i LEFT JOIN analysis_jobs j ON j.installation_id=i.id GROUP BY i.id ORDER BY i.created_at DESC LIMIT 200`);
      res.render('installations', {title: 'Installations', installations: result.rows});
    } catch (error) { next(error); }
  });

  router.post('/installations/:id/revoke', requireCsrf, async (req, res, next) => {
    try {
      const jobs = await pool.query('SELECT id FROM analysis_jobs WHERE installation_id=$1', [req.params.id]);
      await Promise.all(jobs.rows.map(row => queue.cancel(row.id)));
      await pool.query('UPDATE installations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [req.params.id]);
      await audit(req.session.adminUserId, 'installation.revoke', 'installation', req.params.id);
      res.redirect('/admin/installations');
    } catch (error) { next(error); }
  });

  router.post('/installations/:id/delete', requireCsrf, async (req, res, next) => {
    try {
      const jobs = await pool.query('SELECT id FROM analysis_jobs WHERE installation_id=$1', [req.params.id]);
      await Promise.all(jobs.rows.map(row => queue.cancel(row.id)));
      await pool.query('DELETE FROM analysis_jobs WHERE installation_id=$1', [req.params.id]);
      await pool.query(`UPDATE installations SET revoked_at=COALESCE(revoked_at,now()),deleted_at=now(),credential_hash=repeat('0',64) WHERE id=$1`, [req.params.id]);
      await audit(req.session.adminUserId, 'installation.delete_data', 'installation', req.params.id);
      res.redirect('/admin/installations');
    } catch (error) { next(error); }
  });

  router.get('/settings', (req, res) => res.render('settings', {title: 'Operational settings', queue: {paused: queue.paused}, config}));
  router.post('/settings', requireCsrf, async (req, res, next) => {
    try {
      queue.paused = req.body.paused === 'on';
      await pool.query(`INSERT INTO operational_settings(key,value,updated_by) VALUES('analysis_paused',$1::jsonb,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`, [JSON.stringify(queue.paused), req.session.adminUserId]);
      await audit(req.session.adminUserId, 'settings.update', 'setting', 'analysis_paused', {value: queue.paused});
      res.redirect('/admin/settings');
    } catch (error) { next(error); }
  });

  router.get('/audit', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT a.action,a.target_type,a.target_id,a.details,a.created_at,u.username FROM admin_audit a LEFT JOIN admin_users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 300`);
      res.render('audit', {title: 'Audit trail', events: result.rows});
    } catch (error) { next(error); }
  });

  router.get('/security', (req, res) => res.render('security', {title: 'Security', error: null, success: null}));
  router.post('/security/password', requireCsrf, async (req, res, next) => {
    try {
      const current = String(req.body.currentPassword || '');
      const nextPassword = String(req.body.newPassword || '');
      const confirmation = String(req.body.confirmPassword || '');
      const row = (await pool.query('SELECT password_hash FROM admin_users WHERE id=$1', [req.session.adminUserId])).rows[0];
      if (!row || !(await argon2.verify(row.password_hash, current))) return res.status(400).render('security', {title: 'Security', error: 'Current password is incorrect.', success: null});
      if (nextPassword.length < 12 || nextPassword !== confirmation) return res.status(400).render('security', {title: 'Security', error: 'New passwords must match and contain at least 12 characters.', success: null});
      const hash = await argon2.hash(nextPassword, {type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1});
      await pool.query('UPDATE admin_users SET password_hash=$1,session_version=session_version+1,updated_at=now() WHERE id=$2', [hash, req.session.adminUserId]);
      req.session.sessionVersion += 1;
      await audit(req.session.adminUserId, 'admin.password_change', 'admin', req.session.adminUserId);
      res.render('security', {title: 'Security', error: null, success: 'Password changed. Other sessions have been invalidated.'});
    } catch (error) { next(error); }
  });

  router.post('/security/invalidate-sessions', requireCsrf, async (req, res, next) => {
    try {
      await pool.query('UPDATE admin_users SET session_version=session_version+1 WHERE id=$1', [req.session.adminUserId]);
      await audit(req.session.adminUserId, 'admin.sessions_invalidated', 'admin', req.session.adminUserId);
      req.session.destroy(() => res.redirect('/admin/login'));
    } catch (error) { next(error); }
  });

  router.post('/logout', requireCsrf, (req, res) => {
    const adminId = req.session.adminUserId;
    req.session.destroy(() => {
      audit(adminId, 'admin.logout', 'admin', adminId).catch(() => {});
      res.clearCookie('innerfolio.admin');
      res.redirect('/admin/login');
    });
  });

  return router;
}
