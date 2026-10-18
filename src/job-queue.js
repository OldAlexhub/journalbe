import {config} from './config.js';
import {pool} from './db.js';

export class JobQueue {
  constructor(worker) {
    this.worker = worker;
    this.waiting = [];
    this.payloads = new Map();
    this.results = new Map();
    this.running = new Set();
    this.paused = false;
    this.completed = 0;
    this.failed = 0;
    this.expiryTimer = setInterval(() => this.expire(), 30000).unref();
  }

  get depth() { return this.waiting.length + this.running.size; }
  get full() { return this.depth >= config.queueMax; }

  enqueue(jobId, payload) {
    if (this.full || this.paused) return false;
    this.payloads.set(jobId, payload);
    this.waiting.push(jobId);
    this.#pump();
    return true;
  }

  async #pump() {
    while (!this.paused && this.running.size < config.workerConcurrency && this.waiting.length) {
      const jobId = this.waiting.shift();
      if (!this.payloads.has(jobId)) continue;
      this.running.add(jobId);
      void this.#run(jobId);
    }
  }

  async #run(jobId) {
    const payload = this.payloads.get(jobId);
    const started = Date.now();
    try {
      const changed = await pool.query(`UPDATE analysis_jobs SET status='processing', started_at=now() WHERE id=$1 AND status='queued' RETURNING id`, [jobId]);
      if (!changed.rowCount) return;
      const result = await this.worker.analyze(payload);
      const current = await pool.query('SELECT status FROM analysis_jobs WHERE id=$1', [jobId]);
      if (current.rows[0]?.status !== 'processing') return;
      this.results.set(jobId, {result, expiresAt: Date.now() + config.resultTtlSeconds * 1000});
      await pool.query(`UPDATE analysis_jobs SET status='completed', completed_at=now(), duration_ms=$2 WHERE id=$1 AND status='processing'`, [jobId, Date.now() - started]);
      this.completed += 1;
    } catch (error) {
      const code = String(error.code || 'ANALYSIS_FAILED').slice(0, 64);
      await pool.query(`UPDATE analysis_jobs SET status=$2, completed_at=now(), duration_ms=$3, error_code=$4 WHERE id=$1 AND status='processing'`, [jobId, code === 'WORKER_INTERRUPTED' ? 'interrupted' : 'failed', Date.now() - started, code]).catch(() => {});
      this.failed += 1;
    } finally {
      this.payloads.delete(jobId);
      this.running.delete(jobId);
      this.#pump();
    }
  }

  async cancel(jobId) {
    this.payloads.delete(jobId);
    this.waiting = this.waiting.filter(id => id !== jobId);
    this.results.delete(jobId);
    await pool.query(`UPDATE analysis_jobs SET status='cancelled', completed_at=now() WHERE id=$1 AND status IN ('queued','processing','completed')`, [jobId]);
  }

  acknowledge(jobId) {
    this.results.delete(jobId);
  }

  getResult(jobId) { return this.results.get(jobId)?.result || null; }

  async expire() {
    const now = Date.now();
    for (const [jobId, value] of this.results) {
      if (value.expiresAt <= now) this.results.delete(jobId);
    }
    await pool.query(`UPDATE analysis_jobs SET status='expired', completed_at=COALESCE(completed_at,now()) WHERE expires_at < now() AND status IN ('queued','processing','completed')`).catch(() => {});
  }

  close() { clearInterval(this.expiryTimer); }
}
