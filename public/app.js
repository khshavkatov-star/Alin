const $ = id => document.getElementById(id);
let state, chatId = null, busy = false, recording = null, player = null, audioUrl = null, spokenId = null;
let theme = 'dark';
try { theme = localStorage.getItem('alina-theme') || 'dark'; } catch {}
document.documentElement.dataset.theme = theme;
document.querySelectorAll('.theme-switch').forEach(b => b.onclick = () => {
  theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('alina-theme', theme); } catch {}
});
function error(e) { $('error').textContent = e.message || String(e); $('error').hidden = false; }
function activity(text = '') { $('activity').textContent = text; }
function setBusy(value) {
  busy = value;
  ['send','new-chat','mic'].forEach(id => $(id).disabled = value);
  $('message').disabled = value;
  document.querySelectorAll('#chats button,.suggestions button,.listen').forEach(b=>b.disabled=value);
}
async function api(path, options = {}) {
  const headers = { 'X-Alina-Request': '1', ...options.headers };
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { ...options, headers });
  if (!r.ok) {
    const data = await r.json().catch(()=>({error:'Ошибка соединения с сервером.'}));
    if (r.status === 401 && path !== '/api/login') showLogin();
    throw new Error(data.error || 'Не удалось выполнить запрос.');
  }
  return options.audio ? r.blob() : r.json();
}
function stopAudio() { if(player) {player.pause();player.removeAttribute('src');player.load();} player=null; if(audioUrl) URL.revokeObjectURL(audioUrl); audioUrl=null;spokenId=null;$('audio-player').hidden=true; }
function showLogin() {
  stopAudio(); if(recording) recording.cancel();
  $('memory-dialog').close(); $('memory').value=''; $('messages').replaceChildren();
  $('login').hidden=false; $('app').hidden=true; chatId=null; state=null;
}
function updateUsage(u) {
  $('quota-number').textContent = `$${u.used.toFixed(2)} / $${u.limit}`;
  $('quota-progress').max=u.limit; $('quota-progress').value=u.used;
  if(u.used>=u.limit*.8) { $('quota-number').title='Использовано более 80% внутренней квоты.'; }
}
async function refresh() {
  state = await api('/api/state'); updateUsage(state.usage);
  $('setup-note').hidden=state.aiReady;
  $('connection').textContent=state.aiReady?'AI подключён':'Нужен API-ключ';
  $('connection').classList.toggle('ready',state.aiReady);
  $('chats').replaceChildren();
  if(!state.chats.length){const p=document.createElement('p');p.className='empty-history';p.textContent='Здесь появятся ваши разговоры';$('chats').append(p);}
  state.chats.forEach(c=>{const b=document.createElement('button');b.textContent=c.title;b.classList.toggle('active',c.id===chatId);b.disabled=busy;b.onclick=()=>openChat(c.id).catch(error);$('chats').append(b);});
  $('chat-title').textContent=state.chats.find(c=>c.id===chatId)?.title||'Новый разговор';
}
function addMessage(role, content, id) {
  const article=document.createElement('article');article.className=`message ${role}`;
  const label=document.createElement('div');label.className='label';label.textContent=role==='user'?'Вы':'АЛИНА';
  const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=content;
  article.append(label,bubble);
  if(role==='assistant' && id){const b=document.createElement('button');b.className='listen';b.textContent=content.length>1500?'▷ Озвучить начало · AI':'▷ Послушать · AI';b.disabled=busy;b.onclick=()=>speak(id,b);article.append(b);}
  $('messages').append(article);$('welcome').hidden=true;
}
function scrollEnd(){ $('conversation').scrollTop=$('conversation').scrollHeight; }
async function openChat(id) {
  if(busy)return; stopAudio(); setBusy(true);
  try{const data=await api(`/api/chats/${id}`);chatId=id;$('messages').replaceChildren();$('welcome').hidden=Boolean(data.messages.length);data.messages.forEach(m=>addMessage(m.role,m.content,m.id));$('sidebar').classList.remove('open');await refresh();scrollEnd();}finally{setBusy(false);}
}
async function enter() {
  await refresh();$('login').hidden=true;$('app').hidden=false;
  if(state.chats.length)await openChat(state.chats[0].id);
  else {$('messages').replaceChildren();$('welcome').hidden=false;}
}
$('login-form').onsubmit=async e=>{e.preventDefault();$('login-error').textContent='';$('login-submit').disabled=true;try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';await enter();}catch(e){$('login-error').textContent=e.message;}finally{$('login-submit').disabled=false;}};
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'});showLogin();}catch(e){error(e);}};
$('menu').onclick=()=>$('sidebar').classList.toggle('open');
$('new-chat').onclick=()=>{if(busy)return;stopAudio();chatId=null;$('messages').replaceChildren();$('welcome').hidden=false;$('message').value='';$('error').hidden=true;activity();$('sidebar').classList.remove('open');refresh().catch(error);$('message').focus();};
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{if(busy)return;$('message').value=b.dataset.prompt;$('message').focus();});
$('message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
$('chat-form').onsubmit=async e=>{
  e.preventDefault();const message=$('message').value.trim();if(!message||busy||recording)return;
  setBusy(true);stopAudio();$('error').hidden=true;activity('Алина думает…');
  try{
    if(!chatId)chatId=(await api('/api/chats',{method:'POST'})).id;
    const result=await api('/api/chat',{method:'POST',body:JSON.stringify({chatId,message})});
    addMessage('user',message);addMessage('assistant',result.content,result.id);$('message').value='';scrollEnd();await refresh();activity();
  }catch(e){error(e);activity();await refresh().catch(()=>{});}finally{setBusy(false);$('message').focus();}
};
$('memory-open').onclick=()=>{$('memory').value=state?.memory||'';$('memory-status').textContent='';$('memory-dialog').showModal();};
$('memory-close').onclick=()=>$('memory-dialog').close();
$('memory-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/memory',{method:'PUT',body:JSON.stringify({memory:$('memory').value})});await refresh();$('memory-dialog').close();activity('Память сохранена.');}catch(e){$('memory-status').textContent=e.message;}};
async function speak(id, button){
  if(busy)return;
  if(spokenId===id && player){player.currentTime=0;player.play().catch(()=>activity('Нажмите ▶ на аудиоплеере.'));return;}
  stopAudio();setBusy(true);const label=button.textContent;button.textContent='Готовлю голос…';activity('Создаю озвучку…');
  try{
    const blob=await api('/api/speech',{method:'POST',body:JSON.stringify({messageId:id}),audio:true});
    audioUrl=URL.createObjectURL(blob);player=$('audio-player');player.src=audioUrl;player.hidden=false;spokenId=id;player.onended=()=>activity();
    try{await player.play();activity('Алина говорит.');}catch{activity('Нажмите ▶ на аудиоплеере.');}
  }catch(e){error(e);activity();}finally{button.textContent=label;await refresh().catch(()=>{});setBusy(false);}
}
async function toWav(blob){
  const ctx=new AudioContext();let decoded;
  try{decoded=await ctx.decodeAudioData(await blob.arrayBuffer());}finally{await ctx.close();}
  const seconds=Math.min(decoded.duration,60);
  const offline=new OfflineAudioContext(1,Math.max(1,Math.floor(seconds*16000)),16000);
  const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
  const pcm=(await offline.startRendering()).getChannelData(0);
  const buffer=new ArrayBuffer(44+pcm.length*2),view=new DataView(buffer);
  const str=(offset,s)=>[...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  str(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,pcm.length*2,true);
  pcm.forEach((s,i)=>view.setInt16(44+i*2,Math.max(-1,Math.min(1,s))*(s<0?32768:32767),true));
  return new Blob([buffer],{type:'audio/wav'});
}
$('mic').onclick=async()=>{
  if(recording){recording.stop();return;}if(busy)return;
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){error(new Error('Запись недоступна. Откройте сайт по HTTPS в современном браузере.'));return;}
  stopAudio();$('error').hidden=true;
  let stream;
  try{
    $('mic').disabled=true;stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const recorder=new MediaRecorder(stream),parts=[];let cancelled=false;
    const started=Date.now();
    const stop=()=>{if(recorder.state!=='inactive')recorder.stop();};
    const timer=setTimeout(stop,59000);
    const ticker=setInterval(()=>activity(`Записываю: ${Math.floor((Date.now()-started)/1000)} с · Нажмите ■, чтобы закончить`),1000);
    recording={stop,cancel:()=>{cancelled=true;stop();}};
    recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
    recorder.onerror=()=>{cancelled=true;stop();error(new Error('Ошибка микрофона. Попробуйте ещё раз.'));};
    recorder.onstop=async()=>{
      clearTimeout(timer);clearInterval(ticker);stream.getTracks().forEach(t=>t.stop());recording=null;$('mic').textContent='♩';$('mic').classList.remove('recording');$('mic').setAttribute('aria-label','Записать голос');
      if(cancelled){activity();setBusy(false);return;}
      setBusy(true);activity('Распознаю речь…');
      try{const wav=await toWav(new Blob(parts,{type:recorder.mimeType}));const result=await api('/api/transcribe',{method:'POST',body:wav,headers:{'Content-Type':'audio/wav'}});$('message').value=(result.text||'').slice(0,4000);updateUsage(result.usage);activity('Проверьте текст и нажмите отправить.');}catch(e){error(e);activity();await refresh().catch(()=>{});}finally{setBusy(false);$('message').focus();}
    };
    recorder.start();$('mic').disabled=false;$('mic').textContent='■';$('mic').classList.add('recording');$('mic').setAttribute('aria-label','Закончить запись');$('send').disabled=true;activity('Записываю… Нажмите ■, чтобы закончить.');
  }catch(e){stream?.getTracks().forEach(t=>t.stop());$('mic').disabled=false;error(new Error(e.name==='NotAllowedError'?'Разрешите доступ к микрофону в браузере.':'Не удалось включить микрофон.'));}
};
enter().catch(()=>showLogin());
