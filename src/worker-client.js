import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from './config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export class WorkerClient {
  constructor() {
    this.process = null;
    this.ready = false;
    this.model = null;
    this.pending = new Map();
    this.restarts = 0;
    this.stopping = false;
    this.stats = {completed: 0, failed: 0, totalDurationMs: 0};
  }

  start() {
    if (this.process || this.stopping) return;
    const env = {...process.env, NLP_MODEL: config.nlpModel, PYTHONUNBUFFERED: '1'};
    const child = spawn(config.pythonBin, [path.join(root, 'worker', 'worker.py')], {
      cwd: path.join(root, 'worker'), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.process = child;
    const lines = createInterface({input: child.stdout});
    lines.on('line', line => this.#message(line));
    child.stderr.on('data', data => {
      const message = String(data).slice(0, 1000).replace(/[\r\n]+/g, ' ');
      console.error(JSON.stringify({event: 'worker_diagnostic', message}));
    });
    child.on('error', error => console.error(JSON.stringify({event: 'worker_spawn_failed', code: error.code || 'unknown'})));
    child.on('exit', code => this.#exited(code));
  }

  #message(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'ready') {
      this.ready = true;
      this.model = {name: message.model, version: message.version, pipes: message.pipes};
      this.restarts = 0;
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.type === 'result') pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.message || 'Analysis failed'), {code: message.code || 'ANALYSIS_FAILED'}));
  }

  #exited(code) {
    this.process = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('Text worker stopped'), {code: 'WORKER_INTERRUPTED'}));
    }
    this.pending.clear();
    if (!this.stopping) {
      this.restarts += 1;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(this.restarts, 5)));
      setTimeout(() => this.start(), delay).unref();
    }
    if (code && code !== 0) console.error(JSON.stringify({event: 'worker_exit', code}));
  }

  analyze(payload) {
    if (!this.ready || !this.process) return Promise.reject(Object.assign(new Error('Text worker unavailable'), {code: 'WORKER_UNAVAILABLE'}));
    const requestId = randomUUID();
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.stats.failed += 1;
        reject(Object.assign(new Error('Analysis timed out'), {code: 'ANALYSIS_TIMEOUT'}));
      }, config.jobTimeoutMs);
      this.pending.set(requestId, {
        timer,
        resolve: result => {
          this.stats.completed += 1;
          this.stats.totalDurationMs += Date.now() - started;
          resolve(result);
        },
        reject: error => {
          this.stats.failed += 1;
          reject(error);
        },
      });
      this.process.stdin.write(`${JSON.stringify({type: 'analyze', requestId, payload})}\n`);
    });
  }

  status() {
    return {
      ready: this.ready,
      model: this.model,
      restarts: this.restarts,
      inFlight: this.pending.size,
      ...this.stats,
      averageDurationMs: this.stats.completed ? Math.round(this.stats.totalDurationMs / this.stats.completed) : null,
    };
  }

  stop() {
    this.stopping = true;
    this.process?.kill();
  }
}
