import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import session from 'express-session';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../src/app.js';

const execFileAsync = promisify(execFile);

const worker={ready:false,status:()=>({ready:false,model:null,completed:0,failed:0,restarts:0})};
const queue={paused:false,full:false,depth:0};
const app=createApp({queue,worker,sessionStore:new session.MemoryStore()});

test('health is minimal liveness',async()=>{const response=await request(app).get('/health');assert.equal(response.status,200);assert.equal(response.text,'ok');});
test('base URL redirects directly to admin sign in',async()=>{const response=await request(app).get('/');assert.equal(response.status,302);assert.equal(response.headers.location,'/admin/login');});
test('capabilities disclose text-only non-generative processing',async()=>{const response=await request(app).get('/api/v1/capabilities');assert.equal(response.status,200);assert.equal(response.body.textOnly,true);assert.equal(response.body.audioAccepted,false);assert.equal(response.body.generativeModels,false);});
test('published privacy copy matches default-on journal insights',async()=>{const response=await request(app).get('/privacy');assert.equal(response.status,200);assert.match(response.text,/enabled by default/);assert.doesNotMatch(response.text,/must be supplied|opt in and choose/i);});
test('multipart and audio uploads are rejected before routing',async()=>{const response=await request(app).post('/api/v1/analysis/jobs').attach('audio',Buffer.from([0,1,2]),'voice.wav');assert.equal(response.status,415);assert.equal(response.body.error.code,'JSON_ONLY');});
test('admin views require authentication',async()=>{const response=await request(app).get('/admin/jobs');assert.equal(response.status,302);assert.equal(response.headers.location,'/admin/login');});
test('admin login rejects missing CSRF',async()=>{const response=await request(app).post('/admin/login').type('form').send({username:'x',password:'x'});assert.equal(response.status,403);});
test('admin sign-in preserves its CSRF session over HTTP and is never cached',async()=>{
  const loginApp=createApp({queue,worker,sessionStore:new session.MemoryStore()});
  const agent=request.agent(loginApp);
  const first=await agent.get('/admin/login');
  const token=first.text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  assert.equal(first.status,200);assert.ok(token);assert.match(first.headers['cache-control'],/no-store/);
  assert.ok(first.headers['set-cookie']?.some(cookie=>cookie.startsWith('innerfolio.admin=')));
  assert.equal(first.headers['set-cookie']?.some(cookie=>/;\s*Secure/i.test(cookie)),false);
  const second=await agent.get('/admin/login');
  assert.equal(second.text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1],token);
  const proxiedHttps=await request(loginApp).get('/admin/login').set('X-Forwarded-Proto','https');
  assert.ok(proxiedHttps.headers['set-cookie']?.some(cookie=>/;\s*Secure/i.test(cookie)));
});
test('expired admin sign-in form returns a fresh usable form',async()=>{
  const loginApp=createApp({queue,worker,sessionStore:new session.MemoryStore()});
  const agent=request.agent(loginApp);
  const first=await agent.get('/admin/login');
  const oldToken=first.text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  const response=await agent.post('/admin/login').type('form').send({_csrf:'0'.repeat(32),username:'x',password:'x'});
  const newToken=response.text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
  assert.equal(response.status,403);assert.match(response.text,/sign-in page expired/i);assert.ok(newToken);assert.notEqual(newToken,oldToken);
});
test('server dependency list contains no speech or upload middleware',async()=>{const source=await readFile(new URL('../package.json',import.meta.url),'utf8');assert.equal(/multer|whisper|vosk|speech/i.test(source),false);});
test('database commands ignore unrelated Nexus PORT values',async()=>{
  const cwd=new URL('..',import.meta.url);
  const {stdout}=await execFileAsync(process.execPath,['--input-type=module','--eval',"const {pool}=await import('./src/db.js'); await pool.end(); console.log('database-config-ok')"],{cwd,env:{...process.env,PORT:'nexus-database-setup'}});
  assert.match(stdout,/database-config-ok/);
});
