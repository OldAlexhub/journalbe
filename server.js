import {config, assertProductionConfig} from './src/config.js';
import {pool} from './src/db.js';
import {WorkerClient} from './src/worker-client.js';
import {JobQueue} from './src/job-queue.js';
import {createApp} from './src/app.js';

if (config.env === 'production') assertProductionConfig();

const startedAt = Date.now();
const worker = new WorkerClient();
const queue = new JobQueue(worker);
worker.start();
try {
  await worker.waitUntilReady();
  console.log(JSON.stringify({event: 'text_worker_ready', model: worker.status().model?.name}));
} catch (error) {
  console.error(JSON.stringify({event: 'text_worker_startup_failed', code: error.code || 'WORKER_STARTUP_FAILED'}));
  worker.stop();
  await pool.end();
  throw error;
}

await pool.query(`UPDATE analysis_jobs SET status='interrupted',error_code='SERVER_RESTART',completed_at=now() WHERE status IN ('queued','processing')`).catch(error => {
  console.error(JSON.stringify({event: 'startup_database_unavailable', code: error.code || 'unknown'}));
});

const app = createApp({queue, worker, startedAt});
const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({event: 'server_started', host: config.host, port: config.port, textOnly: true}));
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({event: 'shutdown', signal}));
  server.close(async () => {
    queue.close();
    worker.stop();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export {app};
