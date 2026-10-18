import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/app.js';

const execFileAsync = promisify(execFile);

const worker={ready:false,status:()=>({ready:false,model:null,completed:0,failed:0,restarts:0})};
const queue={paused:false,full:false,depth:0};
const app=createApp({queue,worker});

test('health is minimal liveness',async()=>{const response=await request(app).get('/health');assert.equal(response.status,200);assert.equal(response.text,'ok');});
test('capabilities disclose text-only non-generative processing',async()=>{const response=await request(app).get('/api/v1/capabilities');assert.equal(response.status,200);assert.equal(response.body.textOnly,true);assert.equal(response.body.audioAccepted,false);assert.equal(response.body.generativeModels,false);});
test('published privacy copy matches default-on journal insights',async()=>{const response=await request(app).get('/privacy');assert.equal(response.status,200);assert.match(response.text,/enabled by default/);assert.doesNotMatch(response.text,/must be supplied|opt in and choose/i);});
test('multipart and audio uploads are rejected before routing',async()=>{const response=await request(app).post('/api/v1/analysis/jobs').attach('audio',Buffer.from([0,1,2]),'voice.wav');assert.equal(response.status,415);assert.equal(response.body.error.code,'JSON_ONLY');});
test('admin views require authentication',async()=>{const response=await request(app).get('/admin/jobs');assert.equal(response.status,302);assert.equal(response.headers.location,'/admin/login');});
test('admin login rejects missing CSRF',async()=>{const response=await request(app).post('/admin/login').type('form').send({username:'x',password:'x'});assert.equal(response.status,403);});
test('server dependency list contains no speech or upload middleware',async()=>{const source=await readFile(new URL('../package.json',import.meta.url),'utf8');assert.equal(/multer|whisper|vosk|speech/i.test(source),false);});
test('database commands ignore unrelated Nexus PORT values',async()=>{
  const cwd=new URL('..',import.meta.url);
  const {stdout}=await execFileAsync(process.execPath,['--input-type=module','--eval',"const {pool}=await import('./src/db.js'); await pool.end(); console.log('database-config-ok')"],{cwd,env:{...process.env,PORT:'nexus-database-setup'}});
  assert.match(stdout,/database-config-ok/);
});
