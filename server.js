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
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Session tokens (in-memory, сбрасываются при рестарте) ──────────────────
const sessions = new Set();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isAuth(req) {
  const token = req.headers['x-admin-token'] || req.query.token;
  return token && sessions.has(token);
}

function authMiddleware(req, res, next) {
  if (!isAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Streamers data (in-memory + persist to JSON) ────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return {
    streamers: [
      { id: 'streamer1', name: 'Стример 1', slug: 'streamer1' },
      { id: 'streamer2', name: 'Стример 2', slug: 'streamer2' },
      { id: 'streamer3', name: 'Стример 3', slug: 'streamer3' },
      { id: 'streamer4', name: 'Стример 4', slug: 'streamer4' },
      { id: 'streamer5', name: 'Стример 5', slug: 'streamer5' },
    ]
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let appData = loadData();

// ─── Multer for audio uploads ─────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `audio_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.m4a'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only audio files allowed'));
  }
});

// ─── WebSocket: per-streamer rooms ───────────────────────────────────────────
// Map: streamerId → Set of widget WebSocket clients
const widgetClients = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const streamerId = url.searchParams.get('streamer');

  if (!streamerId) { ws.close(1008, 'No streamer ID'); return; }

  if (!widgetClients.has(streamerId)) widgetClients.set(streamerId, new Set());
  widgetClients.get(streamerId).add(ws);

  console.log(`[WS] Widget connected for streamer: ${streamerId} (total: ${widgetClients.get(streamerId).size})`);

  ws.on('close', () => {
    widgetClients.get(streamerId)?.delete(ws);
    console.log(`[WS] Widget disconnected for streamer: ${streamerId}`);
  });

  ws.on('error', (err) => console.error('[WS Error]', err.message));

  // Send ping every 25s to keep alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on('close', () => clearInterval(pingInterval));
});

function broadcastToStreamer(streamerId, payload) {
  const clients = widgetClients.get(streamerId);
  if (!clients || clients.size === 0) {
    console.log(`[Broadcast] No widgets connected for: ${streamerId}`);
    return 0;
  }
  const message = JSON.stringify(payload);
  let sent = 0;
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      sent++;
    }
  });
  console.log(`[Broadcast] Alert sent to ${sent} widget(s) for streamer: ${streamerId}`);
  return sent;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/widget', express.static(path.join(__dirname, 'public', 'widget')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_CODE) {
    const token = generateToken();
    sessions.add(token);
    // Auto-expire after 8 hours
    setTimeout(() => sessions.delete(token), 8 * 60 * 60 * 1000);
    console.log(`[Auth] Admin logged in, token issued`);
    res.json({ token });
  } else {
    console.log(`[Auth] Failed login attempt`);
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
  const { name, slug } = req.body;
  const idx = appData.streamers.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  appData.streamers[idx] = { ...appData.streamers[idx], name, slug };
  saveData(appData);
  res.json(appData.streamers[idx]);
});

// ─── Audio upload ─────────────────────────────────────────────────────────────
app.post('/api/upload-audio', authMiddleware, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/public/uploads/${req.file.filename}`;
  console.log(`[Upload] Audio uploaded: ${req.file.filename}`);
  res.json({ url, filename: req.file.filename });
});

// List uploaded audios
app.get('/api/audios', authMiddleware, (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR)
    .filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f))
    .map(f => ({ filename: f, url: `/public/uploads/${f}`, mtime: fs.statSync(path.join(UPLOADS_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

// Delete audio
app.delete('/api/audios/:filename', authMiddleware, (req, res) => {
  const file = path.join(UPLOADS_DIR, path.basename(req.params.filename));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ─── Send alert ───────────────────────────────────────────────────────────────
app.post('/api/alert', authMiddleware, (req, res) => {
  const { streamerId, text1, text2, audioUrl, styles } = req.body;

  if (!streamerId) return res.status(400).json({ error: 'streamerId required' });

  const payload = {
    type: 'alert',
    text1: text1 || '',
    text2: text2 || '',
    audioUrl: audioUrl || null,
    styles: styles || {},
    timestamp: Date.now()
  };

  const sent = broadcastToStreamer(streamerId, payload);
  res.json({ ok: true, widgetCount: sent });
});

// ─── Widget page route ────────────────────────────────────────────────────────
app.get('/widget/:streamerId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget', 'index.html'));
});

// ─── Admin page ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🎮 Stream Alert Server running on http://localhost:${PORT}`);
  console.log(`📺 Widget URL: http://YOUR_IP:${PORT}/widget/streamer1`);
  console.log(`🔧 Admin Panel: http://YOUR_IP:${PORT}/\n`);
});

process.on('uncaughtException', err => console.error('[Uncaught]', err));
process.on('unhandledRejection', err => console.error('[Unhandled]', err));
