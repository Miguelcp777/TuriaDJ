require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const axios    = require('axios');
const db       = require('./db');
const nd       = require('./navidrome');
const auth     = require('./auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ── Live broadcast engine ────────────────────────────────────────────────────
// Streams one Navidrome song to all voter clients at real-time bitrate.
// Rate-limiter sends BYTES_PER_TICK every TICK_MS — default 192 kbps.
const TICK_MS       = 50;   // 50 ms ticks for smooth delivery
const JOIN_BUF_SECS = 0.5;  // seconds of audio kept for late joiners

let bcastClients    = new Set();
let bcastQueue      = Buffer.alloc(0);
let bcastJoinBuf    = Buffer.alloc(0);
let bcastJoinBufMax = 0;
let bcastBPS        = 16000; // bytes/sec, recalculated per song
let bcastTicker     = null;
let bcastUpstream   = null;

function bcastTick() {
  if (bcastQueue.length === 0) return;
  const bytesPerTick = Math.ceil(bcastBPS * TICK_MS / 1000);
  const chunk = bcastQueue.slice(0, bytesPerTick);
  bcastQueue  = bcastQueue.slice(bytesPerTick);
  // Rolling join buffer: keep last JOIN_BUF_SECS of audio for late joiners
  bcastJoinBuf = Buffer.concat([bcastJoinBuf, chunk]);
  if (bcastJoinBuf.length > bcastJoinBufMax && bcastJoinBufMax > 0)
    bcastJoinBuf = bcastJoinBuf.slice(bcastJoinBuf.length - bcastJoinBufMax);
  const dead = [];
  bcastClients.forEach(res => {
    try { res.write(chunk); } catch (e) { dead.push(res); }
  });
  dead.forEach(r => bcastClients.delete(r));
}

function startBroadcast(songId, duration) {
  // Keep existing voter connections alive, just swap source
  if (bcastTicker)   { clearInterval(bcastTicker); bcastTicker = null; }
  if (bcastUpstream) { try { bcastUpstream.destroy(); } catch(e) {} bcastUpstream = null; }
  bcastQueue = Buffer.alloc(0); bcastJoinBuf = Buffer.alloc(0);
  const url = nd.streamUrl(songId);
  axios.get(url, { responseType: 'stream', timeout: 0 })
    .then(upstream => {
      // Use content-length / duration for exact bytes-per-second
      const fileSize = parseInt(upstream.headers['content-length'] || '0');
      if (fileSize > 0 && duration > 0) {
        bcastBPS = fileSize / duration;
        console.log('broadcast', Math.round(bcastBPS*8/1000), 'kbps (',
          Math.round(fileSize/1024)+'KB /', duration+'s)');
      } else {
        bcastBPS = 16000;
      }
      bcastJoinBufMax = Math.ceil(bcastBPS * JOIN_BUF_SECS);
      bcastUpstream = upstream.data;
      upstream.data.on('data', chunk => { bcastQueue = Buffer.concat([bcastQueue, chunk]); });
      upstream.data.on('end',  () => { bcastUpstream = null; });
      upstream.data.on('error', () => { bcastUpstream = null; });
      bcastTicker = setInterval(bcastTick, TICK_MS);
    })
    .catch(err => console.error('broadcast start error:', err.message));
}

function stopBroadcast() {
  if (bcastTicker)   { clearInterval(bcastTicker); bcastTicker = null; }
  if (bcastUpstream) { try { bcastUpstream.destroy(); } catch (e) {} bcastUpstream = null; }
  bcastQueue = Buffer.alloc(0); bcastJoinBuf = Buffer.alloc(0);
  bcastClients.forEach(res => { try { res.end(); } catch (e) {} });
  bcastClients.clear();
}

app.use(express.static(path.join(__dirname, 'client/dist')));

// Seed admin on first run
const existing = db.getUserByUsername('admin');
if (!existing) {
  db.createUser('admin', auth.hashPassword('admin'), 'admin');
  console.log('Admin created: admin / admin');
}

const broadcast = () => {
  io.emit('queue:update',  db.getQueue());
  io.emit('player:update', db.getNowPlaying());
};

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (username.length < 3)    return res.status(400).json({ error: 'Usuario muy corto (min 3 letras)' });
  if (password.length < 4)    return res.status(400).json({ error: 'Contrasena muy corta (min 4 letras)' });
  if (username.toLowerCase() === 'admin') return res.status(409).json({ error: 'Ese nombre no esta disponible' });
  try {
    const user  = db.createUser(username, auth.hashPassword(password), 'user');
    const token = auth.signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ese nombre ya esta en uso' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.getUserByUsername(username);
  if (!user || !auth.verifyPassword(password, user.password_hash))
    return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
  const token = auth.signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/auth/me', auth.authMiddleware, (req, res) => res.json(req.user));

// ── Admin user management ─────────────────────────────────────────────────────
app.get('/api/admin/users', auth.adminMiddleware, (req, res) => {
  res.json(db.getUsers());
});

app.patch('/api/admin/users/:id', auth.adminMiddleware, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Rol invalido' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes cambiar tu propio rol' });
  db.updateUserRole(req.params.id, role);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', auth.adminMiddleware, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  db.deleteUser(req.params.id);
  res.json({ success: true });
});

// ── DJ Session ───────────────────────────────────────────────────────────────
app.get('/api/session/status', (req, res) => {
  res.json({ active: db.getSessionActive(), name: db.getSessionName(), desc: db.getSessionDesc() });
});

app.post('/api/session/info', auth.adminMiddleware, (req, res) => {
  const { name, desc } = req.body;
  db.setSessionName(name || '');
  db.setSessionDesc(desc || '');
  io.emit('session:update', { active: db.getSessionActive(), name: db.getSessionName(), desc: db.getSessionDesc() });
  res.json({ success: true });
});

app.post('/api/session/start', auth.adminMiddleware, (req, res) => {
  db.setSessionActive(true);
  io.emit('session:update', { active: true, name: db.getSessionName(), desc: db.getSessionDesc() });
  res.json({ success: true });
});

app.post('/api/session/end', auth.adminMiddleware, (req, res) => {
  stopBroadcast();
  autoDJActive = false;
  db.setSessionActive(false);
  db.clearAll();
  io.emit('session:update', { active: false, name: db.getSessionName(), desc: db.getSessionDesc() });
  io.emit('queue:update', []);
  io.emit('player:update', null);
  io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
  res.json({ success: true });
});

app.get('/api/autodj/status', (req, res) => {
  res.json({ enabled: db.getAutoDJEnabled(), active: autoDJActive });
});

app.post('/api/autodj/toggle', auth.adminMiddleware, (req, res) => {
  const enabled = !db.getAutoDJEnabled();
  db.setAutoDJEnabled(enabled);
  if (!enabled && autoDJActive) { autoDJActive = false; }
  io.emit('autodj:update', { enabled, active: autoDJActive });
  res.json({ enabled });
});

// ── Music ─────────────────────────────────────────────────────────────────────
app.get('/api/search', auth.authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try { res.json(await nd.search(q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/playlists', auth.authMiddleware, async (req, res) => {
  try { res.json(await nd.getPlaylists()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browse', auth.authMiddleware, async (req, res) => {
  const playlist = (req.query.playlist || '').trim();
  try {
    const songs = playlist ? await nd.getPlaylistSongs(playlist) : await nd.getRandomSongs(100);
    res.json(songs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/queue', auth.authMiddleware, (req, res) => res.json(db.getQueue()));

app.get('/api/queue/my-votes', auth.authMiddleware, (req, res) => {
  res.json(db.getUserVotes(req.user.id));
});

app.post('/api/queue/add', auth.authMiddleware, (req, res) => {
  const { song } = req.body;
  if (!song) return res.status(400).json({ error: 'missing song' });
  if (req.user.role !== 'admin' && !db.getSessionActive())
    return res.status(403).json({ error: 'La sesion no esta activa' });
  if (req.user.role !== 'admin' && !db.canAddSong(req.user.id)) {
    const next = db.nextAdditionTime(req.user.id);
    const secsLeft = next ? Math.max(1, Math.ceil((next - Date.now()) / 1000)) : 240;
    const m = Math.floor(secsLeft / 60), s = secsLeft % 60;
    const when = m > 0 ? m + ' min ' + s + ' seg' : s + ' seg';
    return res.status(429).json({ error: 'Maximo 2 canciones cada 4 minutos. Podras anadir en ' + when });
  }
  if (!db.getSong(song.id)) db.addToQueue(song);
  if (req.user.role !== 'admin') db.recordAddition(req.user.id);
  broadcast();
  res.json({ success: true });
});

app.post('/api/queue/vote', auth.authMiddleware, (req, res) => {
  if (req.user.role !== 'admin' && !db.getSessionActive())
    return res.status(403).json({ error: 'La sesion no esta activa' });
  const { songId } = req.body;
  const userId = req.user.id;
  if (!songId) return res.status(400).json({ error: 'missing songId' });
  if (!db.getSong(songId)) return res.status(404).json({ error: 'not in queue' });
  if (db.hasVoted(songId, userId)) return res.json({ success: false, reason: 'already_voted' });
  db.addVote(songId, userId);
  broadcast();
  res.json({ success: true });
});

app.delete('/api/queue/:id', auth.adminMiddleware, (req, res) => {
  db.removeFromQueue(req.params.id);
  broadcast();
  res.json({ success: true });
});

app.get('/api/now-playing', (req, res) => { const song = db.getNowPlaying(); res.json(song ? { ...song, position: lastProgress.position } : null); });

app.post('/api/player/next', auth.adminMiddleware, async (req, res) => {
  const queue = db.getQueue();
  if (!queue.length) {
    if (db.getAutoDJEnabled()) {
      // AutoDJ: pick a random song from Navidrome
      try {
        const songs = await nd.getRandomSongs(20);
        if (!songs.length) { db.clearNowPlaying(); autoDJActive = false; broadcast(); io.emit('autodj:update', { enabled: true, active: false }); return res.json({ song: null }); }
        const pick = songs[Math.floor(Math.random() * songs.length)];
        db.setNowPlaying(pick);
        lastProgress = { position: 0 };
        startBroadcast(pick.id, pick.duration || 0);
        autoDJActive = true;
        broadcast();
        io.emit('autodj:update', { enabled: true, active: true });
        return res.json({ song: pick });
      } catch(e) {
        console.error('AutoDJ error:', e.message);
        db.clearNowPlaying(); autoDJActive = false; broadcast();
        io.emit('autodj:update', { enabled: true, active: false });
        return res.json({ song: null });
      }
    }
    db.clearNowPlaying(); autoDJActive = false; broadcast();
    return res.json({ song: null });
  }
  const next = queue[0];
  db.removeFromQueue(next.id);
  db.setNowPlaying(next);
  lastProgress = { position: 0 };
  startBroadcast(next.id, next.duration || 0);
  autoDJActive = false;
  broadcast();
  io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
  res.json({ song: next });
});

app.get('/api/live', (req, res) => {
  req.socket.setTimeout(0);        // no idle timeout for live stream
  req.socket.setNoDelay(true);     // flush each chunk immediately
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Send rolling join buffer so late joiners start playing immediately
  if (bcastJoinBuf.length > 0) res.write(Buffer.from(bcastJoinBuf));
  bcastClients.add(res);
  req.on('close', () => { bcastClients.delete(res); });
  req.socket.on('error', () => { bcastClients.delete(res); });
});

app.get('/api/stream/:id', async (req, res) => {
  try {
    const offset = parseInt(req.query.timeOffset || '0', 10) || 0;
    const url = nd.streamUrl(req.params.id, offset);
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;
    const upstream = await axios.get(url, { responseType: 'stream', headers, timeout: 10000 });
    res.status(upstream.status);
    const forward = ['content-type','content-length','content-range','accept-ranges','transfer-encoding'];
    forward.forEach(h => { if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]); });
    if (!upstream.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());
  } catch (e) {
    if (!res.headersSent) res.status(500).send('Stream error: ' + e.message);
  }
});

app.get('/api/cover/:id', async (req, res) => {
  try {
    const url = nd.coverUrl(req.params.id);
    const upstream = await axios.get(url, { responseType: 'stream', timeout: 8000 });
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch (e) { res.status(404).send(''); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'client/dist/index.html')));

let lastProgress  = { position: 0 };
let autoDJActive  = false;

// Online users: socketId -> { username, role }
const onlineUsers = new Map();

function broadcastOnline() {
  const list = [...onlineUsers.values()];
  io.emit('users:online', { count: list.length, users: list });
}

io.on('connection', socket => {
  socket.emit('queue:update',   db.getQueue());
  socket.emit('player:update',  db.getNowPlaying());
  socket.emit('session:update', { active: db.getSessionActive(), name: db.getSessionName(), desc: db.getSessionDesc() });
  socket.emit('autodj:update',  { enabled: db.getAutoDJEnabled(), active: autoDJActive });
  // Send current online list to this socket
  const list = [...onlineUsers.values()];
  socket.emit('users:online', { count: list.length, users: list });

  socket.on('user:join', ({ username, role }) => {
    onlineUsers.set(socket.id, { username, role });
    broadcastOnline();
  });

  socket.on('user:leave', () => {
    onlineUsers.delete(socket.id);
    broadcastOnline();
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnline();
  });

  // Remote control: relay commands to player and state back to remote
  socket.on('player:cmd',   cmd  => socket.broadcast.emit('player:cmd', cmd));
  socket.on('player:state', data => socket.broadcast.emit('player:state', data));

  socket.on('player:progress', data => { lastProgress = data || { position: 0 }; socket.broadcast.emit('player:progress', data); });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('TuriaDJ on port', PORT));
