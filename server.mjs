import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const month = () => new Date().toISOString().slice(0, 7);
const instructions = `Ты Алина, личная AI-помощница. Отвечай на русском, если пользователь не просит другой язык. Пиши ясно и дружелюбно. Не выдумывай факты или выполненные действия. У тебя пока нет доступа к интернету, календарю, Google Таблицам и компьютеру. Ты умеешь отвечать, помогать с текстами и учитывать сохранённую память. Не обещай отправить напоминание или выполнить действие в будущем. Память пользователь редактирует в разделе «Память». Голос синтезирован искусственным интеллектом.`;

export function createApp(config = {}) {
  const password = config.password ?? process.env.APP_PASSWORD ?? '';
  if (password.length < 12) throw new Error('APP_PASSWORD must contain at least 12 characters. Set it in Railway Variables.');
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const fetcher = config.fetcher ?? fetch;
  const dataDir = config.dataDir ?? process.env.DATA_DIR ?? join(root, 'data');
  const quota = Math.round(Number(config.quota ?? process.env.AI_MONTHLY_QUOTA_USD ?? 30) * 100);
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 3000) throw new Error('AI_MONTHLY_QUOTA_USD must be between 0.01 and 30.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'alina.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), role TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER NOT NULL, version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quota(month TEXT PRIMARY KEY, cents INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS throttle(bucket TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);`);
  let saltValue = db.prepare("SELECT value FROM settings WHERE key='auth-salt'").get()?.value;
  if (!saltValue) { saltValue = randomBytes(32).toString('hex'); db.prepare("INSERT INTO settings VALUES ('auth-salt',?)").run(saltValue); }
  const salt = Buffer.from(saltValue, 'hex');
  const passwordHash = scryptSync(password, salt, 64);
  const passwordVersion = passwordHash.toString('hex');
  let aiBusy = false;
  const secure = config.secure ?? process.env.NODE_ENV === 'production';
  const cookie = (token, age) => `alina_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const usage = () => ({ used: (db.prepare('SELECT cents FROM quota WHERE month=?').get(month())?.cents ?? 0) / 100, limit: quota / 100, month: month() });
  function reserve(cents) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO quota VALUES (?,0)').run(month());
      const r = db.prepare('UPDATE quota SET cents=cents+? WHERE month=? AND cents+?<=?').run(cents, month(), cents, quota);
      if (!r.changes) throw fail(429, 'Месячная квота AI исчерпана. История и память остаются доступны.');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function throttle(bucket, max, period) {
    const now = Date.now();
    const row = db.prepare('SELECT * FROM throttle WHERE bucket=?').get(bucket);
    if (!row || now - row.started > period) {
      db.prepare('INSERT OR REPLACE INTO throttle VALUES (?,?,1)').run(bucket, now);
    } else {
      if (row.count >= max) throw fail(429, 'Слишком много попыток. Подождите несколько минут.');
      db.prepare('UPDATE throttle SET count=count+1 WHERE bucket=?').run(bucket);
    }
  }
  async function body(req, max = 24000) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > max) throw fail(413, 'Запрос слишком большой.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function jsonBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Ожидается JSON.');
    try { return JSON.parse((await body(req)).toString()); } catch(e) { if(e.status) throw e; throw fail(400, 'Некорректный JSON.'); }
  }
  const textField = (value, max) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, `Введите текст от 1 до ${max} символов.`); return value.trim(); };
  async function upstream(path, payload, multipart = false) {
    let r;
    try {
      r = await fetcher(`https://api.openai.com/v1/${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
        body: multipart ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(60000)
      });
    } catch { throw fail(502, 'AI не ответил вовремя. Попробуйте позже.'); }
    if (!r.ok) throw fail(502, r.status === 401 ? 'Проверьте API-ключ в настройках сервера.' : r.status === 429 ? 'Лимит или баланс OpenAI исчерпан. Проверьте кабинет OpenAI.' : 'Сервис AI временно недоступен. Попробуйте позже.');
    return r;
  }
  async function ai(cents, work) {
    if (!apiKey) throw fail(503, 'Добавьте OPENAI_API_KEY в Variables сервиса Railway.');
    if (aiBusy) throw fail(409, 'Алина ещё обрабатывает предыдущий запрос.');
    throttle('ai', 12, 60000);
    reserve(cents); // No refund on timeout: provider may still bill the request.
    aiBusy = true;
    try { return await work(); } finally { aiBusy = false; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true });
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(readFileSync(join(root, 'public', file)));
      }
      if (!path.startsWith('/api/')) throw fail(404, 'Не найдено.');
      if (!['GET', 'POST', 'PUT'].includes(req.method)) throw fail(405, 'Метод не поддерживается.');
      if (req.method !== 'GET') {
        if (req.headers['x-alina-request'] !== '1') throw fail(403, 'Недопустимый запрос.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail(403, 'Недопустимый источник запроса.');
      }
      if (path === '/api/login' && req.method === 'POST') {
        throttle('login', 10, 600000); // Single-user account: global limit cannot be bypassed with spoofed IP headers.
        const data = await jsonBody(req);
        if (typeof data.password !== 'string' || data.password.length > 512 || !timingSafeEqual(scryptSync(data.password, salt, 64), passwordHash)) throw fail(401, 'Неверный пароль.');
        const token = randomBytes(32).toString('hex');
        db.prepare('DELETE FROM sessions WHERE expires<? OR version<>?').run(Date.now(), passwordVersion);
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), Date.now() + 7 * 86400000, passwordVersion);
        res.setHeader('Set-Cookie', cookie(token, 7 * 86400)); return send(200, { ok: true });
      }
      const token = (req.headers.cookie ?? '').split(';').map(s=>s.trim()).find(s=>s.startsWith('alina_session='))?.slice(14) ?? '';
      const session = db.prepare('SELECT * FROM sessions WHERE token=? AND expires>? AND version=?').get(hash(token), Date.now(), passwordVersion);
      if (!session) throw fail(401, 'Войдите в Алину.');
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); res.setHeader('Set-Cookie', cookie('', 0)); return send(200, { ok: true });
      }
      if (path === '/api/state' && req.method === 'GET') return send(200, {
        chats: db.prepare('SELECT * FROM chats ORDER BY created DESC').all(),
        memory: db.prepare("SELECT value FROM settings WHERE key='memory'").get()?.value ?? '',
        usage: usage(), aiReady: Boolean(apiKey)
      });
      if (path === '/api/memory' && req.method === 'PUT') {
        const { memory } = await jsonBody(req);
        if (typeof memory !== 'string' || memory.length > 4000) throw fail(400, 'Память: максимум 4000 символов.');
        db.prepare("INSERT OR REPLACE INTO settings VALUES ('memory',?)").run(memory.trim()); return send(200, { ok: true });
      }
      if (path === '/api/chats' && req.method === 'POST') {
        throttle('new-chat', 20, 60000);
        const id = randomBytes(12).toString('hex');
        db.prepare('INSERT INTO chats VALUES (?,?,?)').run(id, 'Новый разговор', Date.now()); return send(201, { id });
      }
      const match = path.match(/^\/api\/chats\/([a-f0-9]{24})$/);
      if (match && req.method === 'GET') {
        if (!db.prepare('SELECT id FROM chats WHERE id=?').get(match[1])) throw fail(404, 'Разговор не найден.');
        return send(200, { messages: db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY id').all(match[1]) });
      }
      if (path === '/api/chat' && req.method === 'POST') {
        const data = await jsonBody(req); const message = textField(data.message, 4000);
        if (typeof data.chatId !== 'string' || !db.prepare('SELECT id FROM chats WHERE id=?').get(data.chatId)) throw fail(404, 'Разговор не найден.');
        const result = await ai(5, async () => {
          const memory = db.prepare("SELECT value FROM settings WHERE key='memory'").get()?.value ?? '';
          const prior = db.prepare('SELECT role,content FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 20').all(data.chatId).reverse();
          let chars = 0; const context = [];
          for (const item of prior.reverse()) { if (chars + item.content.length > 10000) break; context.unshift(item); chars += item.content.length; }
          const r = await upstream('responses', { model: 'gpt-4.1-mini', store: false, max_output_tokens: 1600,
            instructions: instructions + '\nСохранённые предпочтения пользователя:\n' + memory,
            input: [...context, { role: 'user', content: message }]
          });
          const response = await r.json();
          const answer = (response.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === 'output_text' || x.type === 'refusal').map(x => x.text ?? x.refusal).join('\n');
          if (!answer) throw fail(502, 'AI вернул пустой ответ. Попробуйте переформулировать запрос.');
          db.exec('BEGIN');
          try {
            db.prepare('INSERT INTO messages(chat_id,role,content,created) VALUES (?,?,?,?)').run(data.chatId, 'user', message, Date.now());
            const row = db.prepare('INSERT INTO messages(chat_id,role,content,created) VALUES (?,?,?,?)').run(data.chatId, 'assistant', answer, Date.now());
            db.prepare("UPDATE chats SET title=? WHERE id=? AND title='Новый разговор'").run(message.slice(0, 48), data.chatId);
            db.exec('COMMIT'); return { id: Number(row.lastInsertRowid), content: answer };
          } catch(e) { db.exec('ROLLBACK'); throw e; }
        });
        return send(200, { ...result, usage: usage() });
      }
      if (path === '/api/transcribe' && req.method === 'POST') {
        const audio = await body(req, 2000000);
        // Accept only the canonical 16 kHz mono PCM WAV produced by our client.
        if (audio.length < 3244 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 16) !== 'WAVEfmt ' || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 || audio.toString('ascii',36,40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44 || audio.readUInt32LE(4) !== audio.length - 8 || (audio.length-44)%2 || audio.length > 1920044) throw fail(400, 'Запись должна быть WAV PCM, 16 кГц, моно, от 0,1 до 60 секунд.');
        const result = await ai(3, async () => {
          const form = new FormData(); form.append('model', 'gpt-4o-mini-transcribe'); form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
          return (await upstream('audio/transcriptions', form, true)).json();
        });
        return send(200, { text: result.text, usage: usage() });
      }
      if (path === '/api/speech' && req.method === 'POST') {
        const { messageId } = await jsonBody(req);
        if (!Number.isSafeInteger(messageId)) throw fail(400, 'Некорректное сообщение.');
        const message = db.prepare("SELECT content FROM messages WHERE id=? AND role='assistant'").get(messageId);
        if (!message) throw fail(404, 'Ответ не найден.');
        const audio = await ai(10, async () => (await upstream('audio/speech', { model: 'gpt-4o-mini-tts', voice: 'marin', input: message.content.slice(0,1500), instructions: 'Speak in Russian with a soft, warm, lively feminine voice. Sound like a friendly, attentive conversational companion: use gently expressive intonation, a subtle smile in the voice, natural conversational rhythm, and short pauses at meaningful phrases. Keep a comfortable, moderately paced delivery with clear pronunciation. Be engaged and lightly upbeat without sounding theatrical, overly excited, breathy, or whispery.', response_format: 'mp3' })).arrayBuffer());
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(Buffer.from(audio));
      }
      throw fail(404, 'Не найдено.');
    } catch (e) { if (!res.headersSent) send(e.status ?? 500, { error: e.status ? e.message : 'Ошибка сервера. Попробуйте позже.' }); else res.end(); }
  });
  server.headersTimeout = 15000; server.requestTimeout = 75000;
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log('Alina is ready'));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
