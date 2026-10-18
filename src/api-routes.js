import {Router} from 'express';
import {randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool, sha256} from './db.js';
import {config} from './config.js';
import {installationAuth} from './auth.js';

const jobSchema = z.object({
  entryId: z.string().min(1).max(128),
  entryRevision: z.number().int().positive(),
  text: z.string().min(1).max(100000),
  context: z.array(z.object({entryId: z.string().max(128), entryRevision: z.number().int().positive(), text: z.string().max(20000)}).strict()).max(12).default([]),
  features: z.array(z.enum(['entities', 'statements', 'keywords', 'summary', 'related'])).min(1).max(5).default(['entities', 'statements', 'keywords', 'summary']),
}).strict();

const idempotency = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export function apiRouter(queue) {
  const router = Router();

  router.post('/installations', async (req, res, next) => {
    try {
      const id = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO installations(id, credential_hash) VALUES($1,$2)', [id, sha256(secret)]);
      res.status(201).json({installationId: id, credential: `${id}.${secret}`});
    } catch (error) { next(error); }
  });

  router.get('/capabilities', (req, res) => res.json({
    schemaVersion: 1,
    textOnly: true,
    audioAccepted: false,
    languages: [{code: 'en', features: ['entities', 'statements', 'keywords', 'summary', 'related']}],
    offsetConvention: 'utf16-code-unit',
    resultTtlSeconds: config.resultTtlSeconds,
    models: ['spaCy en_core_web_sm', 'TF-IDF', 'NMF', 'TextRank-style sentence ranking'],
    generativeModels: false,
  }));

  router.use(installationAuth);

  router.post('/analysis/jobs', async (req, res, next) => {
    try {
      if (queue.paused) return res.status(503).json({error: {code: 'ANALYSIS_PAUSED', retryable: true}});
      if (queue.full) return res.status(503).set('Retry-After', '10').json({error: {code: 'QUEUE_BUSY', retryable: true}});
      const parsed = jobSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({error: {code: 'INVALID_TEXT_JOB', issues: parsed.error.issues.map(item => ({path: item.path, code: item.code}))}});
      const key = idempotency.safeParse(req.get('idempotency-key'));
      if (!key.success) return res.status(400).json({error: {code: 'INVALID_IDEMPOTENCY_KEY'}});
      const existing = await pool.query('SELECT id,status,entry_revision,created_at,expires_at FROM analysis_jobs WHERE installation_id=$1 AND idempotency_key=$2', [req.installationId, key.data]);
      if (existing.rowCount) return res.status(200).json(existing.rows[0]);
      const jobId = randomUUID();
      const expiry = new Date(Date.now() + config.resultTtlSeconds * 1000);
      await pool.query(
        `INSERT INTO analysis_jobs(id,installation_id,idempotency_key,entry_id,entry_revision,status,feature_set,expires_at)
         VALUES($1,$2,$3,$4,$5,'queued',$6::jsonb,$7)`,
        [jobId, req.installationId, key.data, parsed.data.entryId, parsed.data.entryRevision, JSON.stringify(parsed.data.features), expiry],
      );
      if (!queue.enqueue(jobId, parsed.data)) {
        await pool.query('DELETE FROM analysis_jobs WHERE id=$1', [jobId]);
        return res.status(503).json({error: {code: 'QUEUE_BUSY', retryable: true}});
      }
      res.status(202).json({id: jobId, status: 'queued', entryRevision: parsed.data.entryRevision, expiresAt: expiry.toISOString()});
    } catch (error) { next(error); }
  });

  router.get('/analysis/jobs/:id', async (req, res, next) => {
    try {
      const result = await pool.query('SELECT id,status,entry_id,entry_revision,created_at,started_at,completed_at,expires_at,error_code FROM analysis_jobs WHERE id=$1 AND installation_id=$2', [req.params.id, req.installationId]);
      if (!result.rowCount) return res.status(404).json({error: {code: 'JOB_NOT_FOUND'}});
      const job = result.rows[0];
      const payload = job.status === 'completed' ? queue.getResult(job.id) : null;
      if (job.status === 'completed' && !payload) {
        await pool.query(`UPDATE analysis_jobs SET status='interrupted',error_code='RESULT_NOT_IN_MEMORY' WHERE id=$1`, [job.id]);
        job.status = 'interrupted';
        job.error_code = 'RESULT_NOT_IN_MEMORY';
      }
      res.json({...job, result: payload});
    } catch (error) { next(error); }
  });

  router.post('/analysis/jobs/:id/ack', async (req, res, next) => {
    try {
      const result = await pool.query(`UPDATE analysis_jobs SET acknowledged_at=now() WHERE id=$1 AND installation_id=$2 AND status='completed' RETURNING id`, [req.params.id, req.installationId]);
      if (!result.rowCount) return res.status(404).json({error: {code: 'COMPLETED_JOB_NOT_FOUND'}});
      queue.acknowledge(req.params.id);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete('/analysis/jobs/:id', async (req, res, next) => {
    try {
      const result = await pool.query('SELECT id FROM analysis_jobs WHERE id=$1 AND installation_id=$2', [req.params.id, req.installationId]);
      if (!result.rowCount) return res.status(404).json({error: {code: 'JOB_NOT_FOUND'}});
      await queue.cancel(req.params.id);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.delete('/installation-data', async (req, res, next) => {
    try {
      const jobs = await pool.query('SELECT id FROM analysis_jobs WHERE installation_id=$1', [req.installationId]);
      await Promise.all(jobs.rows.map(row => queue.cancel(row.id)));
      await pool.query('UPDATE installations SET revoked_at=now(), deleted_at=now(), credential_hash=$2 WHERE id=$1', [req.installationId, sha256(randomBytes(32).toString('hex'))]);
      await pool.query('DELETE FROM analysis_jobs WHERE installation_id=$1', [req.installationId]);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
