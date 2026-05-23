const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_CODE = '5493';
// HMAC-секрет для подписи токенов (генерируется раз при старте)
const TOKEN_SECRET = crypto.randomBytes(64).toString('hex');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Rate limiting для логина ─────────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 }); // окно 15 мин
    return true;
  }
  if (entry.count >= 10) return false; // максимум 10 попыток за 15 минут
  entry.count++;
  return true;
}

function resetRateLimit(ip) {
  loginAttempts.delete(ip);
}

// ─── Session tokens (подписанные HMAC, in-memory) ─────────────────────────────
const sessions = new Map(); // token → expiresAt

function generateToken() {
  const rand = crypto.randomBytes(32).toString('hex');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(rand).digest('hex');
  return `${rand}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [rand, sig] = parts;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(rand).digest('hex');
  // Constant-time compare
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
  } catch { return false; }
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function isAuth(req) {
  // Только из заголовка, НЕ из query string (предотвращаем утечку в логи)
  const token = req.headers['x-admin-token'];
  return verifyToken(token);
}

function authMiddleware(req, res, next) {
  if (!isAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Data (in-memory + persist) ───────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function genStreamerId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  while (id.length < 10) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

function makeDefaultStreamers() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: genStreamerId(),
    name: `Стример ${i + 1}`,
  }));
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Миграция старых streamerN ID → новые
      if (d.streamers && d.streamers.some(s => /^streamer\d+$/.test(s.id))) {
        d.streamers = d.streamers.map(s => ({
          ...s,
          id: /^streamer\d+$/.test(s.id) ? genStreamerId() : s.id,
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
      }
      // Добавить профили до 10 если меньше
      while (d.streamers.length < 10) {
        d.streamers.push({ id: genStreamerId(), name: `Стример ${d.streamers.length + 1}` });
      }
      return d;
    } catch {}
  }
  return {
    streamers: makeDefaultStreamers(),
    globalStyles: null
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = loadData();

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `audio_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.m4a'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only audio files allowed'));
  }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const widgetClients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const streamerId = url.searchParams.get('streamer');

  if (!streamerId || typeof streamerId !== 'string' || streamerId.length > 50) {
    ws.close(1008, 'Invalid streamer ID'); return;
  }

  if (!widgetClients.has(streamerId)) widgetClients.set(streamerId, new Set());
  widgetClients.get(streamerId).add(ws);

  console.log(`[WS] Widget connected: ${streamerId} (total: ${widgetClients.get(streamerId).size})`);

  ws.on('close', () => {
    widgetClients.get(streamerId)?.delete(ws);
  });

  ws.on('error', (err) => console.error('[WS Error]', err.message));

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);
  ws.on('close', () => clearInterval(pingInterval));
});

function broadcastToStreamer(streamerId, payload) {
  const clients = widgetClients.get(streamerId);
  if (!clients || clients.size === 0) return 0;
  const message = JSON.stringify(payload);
  let sent = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(message); sent++; }
  });
  console.log(`[Broadcast] Alert sent to ${sent} widget(s) for: ${streamerId}`);
  return sent;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/widget', express.static(path.join(__dirname, 'public', 'widget')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// Запрет доступа к data.json и uploads через /public если нужно скрыть
// (оставляем uploads открытыми — нужны для виджета)

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    console.log(`[Auth] Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  }

  const { code } = req.body;

  // Валидация: код должен быть строкой 4 цифры
  if (!code || typeof code !== 'string' || !/^\d{4}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }

  // Constant-time compare
  const codeBuf = Buffer.from(code.padEnd(64));
  const adminBuf = Buffer.from(ADMIN_CODE.padEnd(64));
  const match = crypto.timingSafeEqual(codeBuf, adminBuf);

  if (match) {
    resetRateLimit(ip);
    const token = generateToken();
    sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    console.log(`[Auth] Admin logged in from ${ip}`);
    res.json({ token });
  } else {
    console.log(`[Auth] Failed login from ${ip}`);
    res.status(403).json({ error: 'Wrong code' });
  }
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers['x-admin-token'];
  sessions.delete(token);
  res.json({ ok: true });
});

// ─── Streamers API ────────────────────────────────────────────────────────────
app.get('/api/streamers', authMiddleware, (req, res) => {
  res.json(appData.streamers);
});

app.put('/api/streamers/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  // Валидация
  if (!name || typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({ error: 'Invalid name' });
  }

  const idx = appData.streamers.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  appData.streamers[idx] = { ...appData.streamers[idx], name: name.trim() };
  saveData(appData);
  res.json(appData.streamers[idx]);
});

// ─── Global styles ────────────────────────────────────────────────────────────
app.get('/api/styles', authMiddleware, (req, res) => {
  res.json(appData.globalStyles || null);
});

app.post('/api/styles', authMiddleware, (req, res) => {
  const { styles } = req.body;
  if (!styles || typeof styles !== 'object') {
    return res.status(400).json({ error: 'Invalid styles' });
  }
  appData.globalStyles = styles;
  saveData(appData);
  res.json({ ok: true });
});

// ─── Audio ────────────────────────────────────────────────────────────────────
app.post('/api/upload-audio', authMiddleware, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/public/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

app.get('/api/audios', authMiddleware, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR)
    .filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f) && f.toLowerCase() !== 'don.m4a')
    .map(f => ({ filename: f, url: `/public/uploads/${f}`, mtime: fs.statSync(path.join(UPLOADS_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.delete('/api/audios/:filename', authMiddleware, (req, res) => {
  // path traversal protection
  const filename = path.basename(req.params.filename);
  if (filename.toLowerCase() === 'don.m4a') {
    return res.status(403).json({ error: 'This file is protected' });
  }
  const file = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ─── Send alert ───────────────────────────────────────────────────────────────
app.post('/api/alert', authMiddleware, (req, res) => {
  const { streamerId, text1, text2, audioUrl, styles } = req.body;

  if (!streamerId || typeof streamerId !== 'string') {
    return res.status(400).json({ error: 'streamerId required' });
  }

  // Проверяем что такой стример существует
  const streamer = appData.streamers.find(s => s.id === streamerId);
  if (!streamer) return res.status(404).json({ error: 'Streamer not found' });

  // Валидация текстов
  if (typeof text1 !== 'string' || typeof text2 !== 'string') {
    return res.status(400).json({ error: 'Invalid text' });
  }
  if (text1.length > 500 || text2.length > 500) {
    return res.status(400).json({ error: 'Text too long' });
  }

  // Валидация audioUrl — только наш uploads путь
  let safeAudioUrl = null;
  if (audioUrl && typeof audioUrl === 'string') {
    if (/^\/public\/uploads\/audio_\d+\.(mp3|wav|ogg|m4a)$/i.test(audioUrl)) {
      safeAudioUrl = audioUrl;
    }
  }

  const payload = {
    type: 'alert',
    text1: text1.trim(),
    text2: text2.trim(),
    audioUrl: safeAudioUrl,
    styles: styles || {},
    timestamp: Date.now()
  };

  const sent = broadcastToStreamer(streamerId, payload);
  res.json({ ok: true, widgetCount: sent });
});

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/widget/:streamerId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget', 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 Stream Alert Server running on http://localhost:${PORT}`);
  console.log(`📺 Widget URL example: http://YOUR_IP:${PORT}/widget/${appData.streamers[0].id}`);
  console.log(`🔧 Admin Panel: http://YOUR_IP:${PORT}/\n`);
  console.log('Streamer IDs:');
  appData.streamers.forEach(s => console.log(`  ${s.name}: /widget/${s.id}`));
});

process.on('uncaughtException', err => console.error('[Uncaught]', err));
process.on('unhandledRejection', err => console.error('[Unhandled]', err));
