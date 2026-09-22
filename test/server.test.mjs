import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

async function fixture(t, opts={}) {
  const dir=mkdtempSync(join(tmpdir(),'alina-test-'));
  const calls=[];
  const server=createApp({password:'test-password-only',apiKey:'fake-key-for-tests',dataDir:dir,secure:false,fetcher:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('transcriptions'))return Response.json({text:'Распознанный текст'});
    if(url.endsWith('speech'))return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}});
    return Response.json({output:[{type:'message',content:[{type:'output_text',text:'Привет! Я Алина.'}]}]});
  },...opts});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  let cookie='';
  const request=async(path,method='GET',data,extra={})=>{
    const r=await fetch(base+path,{method,headers:{cookie,'X-Alina-Request':'1',...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
    if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  const login=()=>request('/api/login','POST',{password:'test-password-only'});
  t.after(async()=>{server.close();server.closeAllConnections();await once(server,'close');rmSync(dir,{recursive:true,force:true});});
  return {request,login,calls,server,dir,base};
}
test('authentication, CSRF, cookie and private routes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.request('/api/login','POST',{password:'wrong'})).status,401);
  assert.equal((await f.request('/api/login','POST',{password:'test-password-only'},{Origin:'https://other.example'})).status,403);
  const r=await f.login();assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await f.request('/api/state')).status,200);
  await f.request('/api/logout','POST');assert.equal((await f.request('/api/state')).status,401);
});
test('chat and memory persist; upstream receives limited context and no stored response',async t=>{
  const f=await fixture(t);await f.login();
  await f.request('/api/memory','PUT',{memory:'Обращайся на ты.'});
  const {id}=await(await f.request('/api/chats','POST')).json();
  const r=await f.request('/api/chat','POST',{chatId:id,message:'Привет'});assert.equal(r.status,200);
  const result=await r.json();assert.equal(result.content,'Привет! Я Алина.');
  const history=await(await f.request(`/api/chats/${id}`)).json();assert.equal(history.messages.length,2);
  const payload=JSON.parse(f.calls[0].init.body);assert.match(payload.instructions,/Обращайся на ты/);assert.equal(payload.store,false);assert.equal(payload.max_output_tokens,1600);
  const state=await(await f.request('/api/state')).json();assert.equal(state.memory,'Обращайся на ты.');assert.equal(state.usage.used,0.05);
  // A second server against the same data directory simulates a restart.
  const restored=createApp({password:'test-password-only',dataDir:f.dir});restored.listen(0,'127.0.0.1');await once(restored,'listening');
  const base=`http://127.0.0.1:${restored.address().port}`;
  const auth=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Alina-Request':'1'},body:JSON.stringify({password:'test-password-only'})});
  const state2=await(await fetch(base+'/api/state',{headers:{cookie:auth.headers.get('set-cookie').split(';')[0]}})).json();
  assert.equal(state2.memory,state.memory);assert.equal(state2.chats.length,1);assert.equal(state2.usage.used,0.05);
  restored.close();restored.closeAllConnections();await once(restored,'close');
});
test('quota stops API calls before overspending the internal allocation',async t=>{
  const f=await fixture(t,{quota:0.05});await f.login();const {id}=await(await f.request('/api/chats','POST')).json();
  assert.equal((await f.request('/api/chat','POST',{chatId:id,message:'Первый'})).status,200);
  assert.equal((await f.request('/api/chat','POST',{chatId:id,message:'Второй'})).status,429);assert.equal(f.calls.length,1);
});
test('unconfigured API is truthful and does not consume quota',async t=>{
  const f=await fixture(t,{apiKey:''});await f.login();const {id}=await(await f.request('/api/chats','POST')).json();
  assert.equal((await f.request('/api/chat','POST',{chatId:id,message:'Привет'})).status,503);
  const state=await(await f.request('/api/state')).json();assert.equal(state.aiReady,false);assert.equal(state.usage.used,0);assert.equal(f.calls.length,0);
});
test('audio validates duration on server; speech uses saved assistant messages only',async t=>{
  const f=await fixture(t);const auth=await f.login();const cookie=auth.headers.get('set-cookie').split(';')[0];
  const sendAudio=b=>fetch(f.base+'/api/transcribe',{method:'POST',headers:{cookie,'X-Alina-Request':'1','Content-Type':'audio/wav'},body:b});
  assert.equal((await sendAudio(Buffer.from('invalid'))).status,400);
  const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
  assert.equal((await sendAudio(wav)).status,200);
  const {id}=await(await f.request('/api/chats','POST')).json();const answer=await(await f.request('/api/chat','POST',{chatId:id,message:'Привет'})).json();
  assert.equal((await f.request('/api/speech','POST',{messageId:999})).status,404);
  assert.equal((await f.request('/api/speech','POST',{messageId:answer.id})).headers.get('content-type'),'audio/mpeg');
});
test('provider failure does not fabricate an answer; conservative reservation remains',async t=>{
  const f=await fixture(t,{fetcher:async()=>new Response('',{status:429})});await f.login();const {id}=await(await f.request('/api/chats','POST')).json();
  assert.equal((await f.request('/api/chat','POST',{chatId:id,message:'Привет'})).status,502);
  assert.equal((await(await f.request(`/api/chats/${id}`)).json()).messages.length,0);
  assert.equal((await(await f.request('/api/state')).json()).usage.used,0.05);
});
