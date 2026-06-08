require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const axios    = require('axios');
const { spawn } = require('child_process');
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
let bcastGen        = 0;     // token de generación: invalida promesas de startBroadcast obsoletas

// ── Log de diagnóstico por sesión ────────────────────────────────────────────
// Se resetea en cada inicio/fin de sesión. Registra eventos clave del motor de
// avance (servidor) y del cliente PlayerView (vía socket 'client:log').
const SESSION_LOG_MAX = 300;
let sessionLog       = [];
let sessionStartTime = 0;

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
  slog('broadcast:start', { id: songId.slice(0, 8), dur: duration });
  // Keep existing voter connections alive, just swap source
  if (bcastTicker)   { clearInterval(bcastTicker); bcastTicker = null; }
  if (bcastUpstream) { try { bcastUpstream.destroy(); } catch(e) {} bcastUpstream = null; }
  bcastQueue = Buffer.alloc(0); bcastJoinBuf = Buffer.alloc(0);
  const myGen = ++bcastGen;   // si llega otra llamada antes de resolver, esta queda obsoleta
  const url = nd.streamUrl(songId);
  axios.get(url, { responseType: 'stream', timeout: 15000 })
    .then(upstream => {
      // Una llamada posterior a startBroadcast invalidó esta promesa: descartar
      // este stream para no crear un segundo bcastTicker compitiendo.
      if (myGen !== bcastGen) { try { upstream.data.destroy(); } catch(e) {} return; }
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

// index.html nunca debe quedar cacheado (los assets JS/CSS tienen hash en el nombre)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
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
  const { duration } = req.body || {};
  resetRuntimeState();   // baseline limpio: que la sesión nueva no herede estado viejo
  slog('session:start', { duration: duration || 0 });
  db.setSessionActive(true);
  io.emit('session:update', { active: true, name: db.getSessionName(), desc: db.getSessionDesc() });
  io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
  broadcastOnline();
  if (duration && Number(duration) > 0) {
    startSessionTimer(Date.now() + Number(duration) * 60 * 1000);
  } else {
    db.setSetting('session_end_time', '');
    io.emit('session:timer', { endsAt: null });
  }
  res.json({ success: true });
});

app.post('/api/session/end', auth.adminMiddleware, (req, res) => {
  slog('session:end');
  clearSessionTimer();
  clearSongEndTimer();
  stopBroadcast();
  resetRuntimeState();   // limpia todo el estado efímero (incluye pendingAutoDJ/autoDJActive)
  db.setSessionActive(false);
  db.clearAll();
  io.emit('session:update', { active: false, name: db.getSessionName(), desc: db.getSessionDesc() });
  io.emit('queue:update', []);
  io.emit('player:update', null);
  io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
  broadcastOnline();
  res.json({ success: true });
});

app.post('/api/session/extend', auth.adminMiddleware, (req, res) => {
  const { minutes } = req.body || {};
  if (!minutes || Number(minutes) <= 0) return res.status(400).json({ error: 'Minutos inválidos' });
  const stored = db.getSetting('session_end_time');
  if (!stored) return res.status(400).json({ error: 'La sesión no tiene duración programada' });
  startSessionTimer(parseInt(stored) + Number(minutes) * 60 * 1000);
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

app.get('/api/autodj/playlists', auth.adminMiddleware, async (req, res) => {
  try {
    const playlists = await nd.getPlaylists();
    const selected  = db.getAutoDJPlaylists();
    res.json({ playlists, selected });
  } catch (e) { console.error('autodj playlists error:', e.message); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/autodj/playlists', auth.adminMiddleware, (req, res) => {
  const { selected } = req.body;
  if (!Array.isArray(selected)) return res.status(400).json({ error: 'invalid' });
  db.setAutoDJPlaylists(selected);
  io.emit('autodj:playlists', { selected });
  res.json({ success: true, selected });
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

app.post('/api/queue/:id/pin', auth.adminMiddleware, (req, res) => {
  db.pinSong(req.params.id);
  broadcast();
  res.json({ success: true });
});

app.delete('/api/queue', auth.adminMiddleware, (req, res) => {
  db.clearQueue();
  broadcast();
  res.json({ success: true });
});

app.post('/api/player/silence-config', auth.adminMiddleware, (req, res) => {
  const { threshold, seconds } = req.body;
  if (threshold !== undefined) db.setSetting('silence_threshold', threshold);
  if (seconds   !== undefined) db.setSetting('silence_seconds',   seconds);
  const data = {
    threshold: parseFloat(db.getSetting('silence_threshold') || 0.02),
    seconds:   parseFloat(db.getSetting('silence_seconds')   || 1),
  };
  io.emit('player:silence-config', data);
  res.json({ success: true, ...data });
});

app.post('/api/player/crossfade-config', auth.adminMiddleware, (req, res) => {
  const { ms } = req.body;
  if (ms !== undefined && ms > 0) db.setSetting('crossfade_ms', ms);
  const crossfadeMs = parseInt(db.getSetting('crossfade_ms') || 4000, 10);
  io.emit('player:crossfade-config', { ms: crossfadeMs });
  res.json({ success: true, ms: crossfadeMs });
});

app.get('/api/now-playing', (req, res) => { const song = db.getNowPlaying(); res.json(song ? { ...song, position: lastProgress.position } : null); });

// ── advanceQueue: lógica de avance compartida entre HTTP y socket ─────────────
// Protección contra doble avance:
//   - `auto:true` (avances AUTOMÁTICOS: auto-next del cliente + safety timer del
//     servidor + otros clientes) se DEBOUNCEan: si ya hubo un avance automático
//     hace < 2s, devolvemos la canción actual sin avanzar otra vez. Esto evita
//     que el fin de una canción dispare dos avances (saltándose una canción)
//     cuando coinciden el pre-trigger del cliente y el safety timer, o cuando
//     hay varios clientes (PlayerView + panel admin) abiertos.
//   - El skip EXPLÍCITO del DJ (`POST /api/player/next`, sin `auto`) NO se
//     debouncea: pulsar "siguiente" varias veces seguidas debe saltar varias.
//   - `advanceInFlight` cubre la carrera en la rama AutoDJ (que tiene un await
//     a Navidrome): dos llamadas concurrentes no deben elegir dos canciones.
let advanceInFlight = false;
let lastAutoAdvanceAt = 0;

// ── Pre-selección de la siguiente canción de AutoDJ ──────────────────────────
// En AutoDJ la cola está vacía, así que la siguiente canción no se conoce hasta
// que el servidor la elige. Para que el cliente pueda PRECARGARLA con tiempo y
// hacer un crossfade real (en vez de cargarla en el último momento → corte
// seco), pre-elegimos la canción y la guardamos en `pendingAutoDJ`. El cliente
// la consulta vía `player:peek-next` ~90s antes del final y la precarga; cuando
// llega el avance, `advanceQueue` reproduce EXACTAMENTE esa misma canción.
let pendingAutoDJ = null;

async function pickAutoDJSong() {
  const selectedPlaylists = db.getAutoDJPlaylists();
  let songs = [];
  if (selectedPlaylists.length > 0) {
    const playlistId = selectedPlaylists[Math.floor(Math.random() * selectedPlaylists.length)];
    songs = await nd.getPlaylistSongs(playlistId);
  } else {
    songs = await nd.getRandomSongs(20);
  }
  if (!songs.length) return null;
  return songs[Math.floor(Math.random() * songs.length)];
}

async function advanceQueue({ auto = false } = {}) {
  slog('advance:call', { auto });
  if (auto) {
    const now = Date.now();
    const msSinceLast = now - lastAutoAdvanceAt;
    if (msSinceLast < 2000) {
      slog('advance:debounced', { ms: Math.round(msSinceLast) });
      return db.getNowPlaying();
    }
    lastAutoAdvanceAt = now;
  }
  if (advanceInFlight) {
    slog('advance:locked');
    return db.getNowPlaying();
  }
  advanceInFlight = true;
  try {
    clearSongEndTimer(); // cancelar el timer de la canción anterior
    const queue = db.getQueue();
    if (!queue.length) {
      if (db.getAutoDJEnabled()) {
        try {
          // Usar la canción pre-elegida (que el cliente ya precargó) si existe;
          // si no, elegir una ahora. Limpiar la pre-selección al consumirla.
          const wasPending = !!pendingAutoDJ;
          const pick = pendingAutoDJ || await pickAutoDJSong();
          pendingAutoDJ = null;
          if (!pick) {
            slog('advance:empty', { source: 'autodj', reason: 'no-songs' });
            db.clearNowPlaying(); autoDJActive = false; broadcast();
            io.emit('autodj:update', { enabled: true, active: false });
            return null;
          }
          slog('advance:autodj', { id: pick.id.slice(0, 8), title: (pick.title || '').slice(0, 30), pending: wasPending });
          db.setNowPlaying(pick);
          lastProgress = { position: 0 };
          startBroadcast(pick.id, pick.duration || 0);
          autoDJActive = true;
          broadcast();
          io.emit('autodj:update', { enabled: true, active: true });
          scheduleSongEnd(pick.id, pick.duration || 0); // safety net
          return pick;
        } catch (e) {
          slog('advance:error', { err: e.message });
          console.error('AutoDJ error:', e.message);
          db.clearNowPlaying(); autoDJActive = false; broadcast();
          io.emit('autodj:update', { enabled: true, active: false });
          return null;
        }
      }
      slog('advance:empty', { source: 'queue', autodj: false });
      db.clearNowPlaying(); autoDJActive = false; broadcast();
      return null;
    }
    // Hay cola: la siguiente sale de la cola; invalidar cualquier pre-selección
    // de AutoDJ para que no quede obsoleta.
    pendingAutoDJ = null;
    const next = queue[0];
    slog('advance:queue', { id: next.id.slice(0, 8), title: (next.title || '').slice(0, 30) });
    db.removeFromQueue(next.id);
    db.setNowPlaying(next);
    lastProgress = { position: 0 };
    startBroadcast(next.id, next.duration || 0);
    autoDJActive = false;
    broadcast();
    io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
    scheduleSongEnd(next.id, next.duration || 0); // safety net
    return next;
  } finally {
    advanceInFlight = false;
  }
}

app.post('/api/player/next', auth.adminMiddleware, async (req, res) => {
  try {
    const song = await advanceQueue();
    res.json({ song });
  } catch (e) {
    console.error('player/next error:', e.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Spooty: proxy Spotify download requests to internal Spooty service ────────
function ndAuthStr() {
  const u = process.env.NAVIDROME_USER || 'admin';
  const p = process.env.NAVIDROME_PASS || 'admin';
  return 'u=' + u + '&p=' + p + '&v=1.16.1&c=jukevote&f=json';
}
function ndBase() { return process.env.NAVIDROME_URL || 'http://localhost:4533'; }

async function ndSongCount() {
  const { data } = await axios.get(ndBase() + '/rest/getScanStatus.view?' + ndAuthStr(), { timeout: 10000 });
  return data?.['subsonic-response']?.scanStatus?.count ?? -1;
}

async function ndRunScan() {
  await axios.get(ndBase() + '/rest/startScan.view?' + ndAuthStr(), { timeout: 10000 });
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const { data } = await axios.get(ndBase() + '/rest/getScanStatus.view?' + ndAuthStr(), { timeout: 10000 });
    if (!data?.['subsonic-response']?.scanStatus?.scanning) break;
  }
}

app.get('/api/spooty/track-info', auth.authMiddleware, async (req, res) => {
  const { url } = req.query;
  if (!url || !/open\.spotify\.com\/track\//.test(url))
    return res.status(400).json({ error: 'URL inválida' });
  try {
    let title = '', artist = '', thumbnail = '';
    const oembed = await axios.get(
      'https://open.spotify.com/oembed?url=' + encodeURIComponent(url),
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    title     = oembed.data.title || '';
    thumbnail = oembed.data.thumbnail_url || '';
    try {
      const page = await axios.get(url.split('?')[0], {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
      });
      const m = page.data.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (m) {
        const ld = JSON.parse(m[1]);
        if (ld.byArtist?.name) artist = ld.byArtist.name;
        else if (Array.isArray(ld.byArtist) && ld.byArtist[0]?.name) artist = ld.byArtist[0].name;
      }
    } catch {}
    res.json({ title, artist, thumbnail });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo obtener información de la canción.' });
  }
});

app.post('/api/spooty/download', auth.authMiddleware, async (req, res) => {
  const { spotifyUrl } = req.body || {};
  if (!spotifyUrl || !/open\.spotify\.com\/track\//.test(spotifyUrl))
    return res.status(400).json({ error: 'Solo se permiten canciones individuales. Pega el enlace de una canción de Spotify (no playlists ni álbumes).' });
  res.json({ success: true });
  (async () => {
    try {
      const baseline = await ndSongCount().catch(() => -1);
      await axios.post('http://localhost:3000/api/playlist', { spotifyUrl }, { timeout: 30000 });
      // Poll until Navidrome song count grows (max ~10 min, scan every 30 s)
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 30000));
        await ndRunScan().catch(() => {});
        const count = await ndSongCount().catch(() => -1);
        if (baseline >= 0 && count > baseline) {
          io.emit('spooty:ready', { message: 'Tu canción ya está disponible. Búscala en el buscador.' });
          return;
        }
      }
      io.emit('spooty:error', { message: 'La descarga tardó demasiado. Inténtalo de nuevo.' });
    } catch (e) {
      console.error('Spooty background error:', e.message);
      io.emit('spooty:error', { message: 'Error al descargar la canción. Inténtalo de nuevo.' });
    }
  })();
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
let sessionTimer  = null;
let songEndTimer  = null;   // safety net: server-side auto-advance when song duration expires

// ── Server-side song-end safety net ─────────────────────────────────────────
// Fires (duration + 8s) after a song starts. If the client hasn't already
// advanced (nowPlaying still points to the same song), the server advances.
// This ensures AutoDJ kicks in even when the player tab is throttled/backgrounded.
function clearSongEndTimer() {
  if (songEndTimer) { clearTimeout(songEndTimer); songEndTimer = null; }
}

function scheduleSongEnd(songId, durationSecs) {
  clearSongEndTimer();
  // Si la canción no tiene duración en metadatos, fallback de 10 minutos
  const safeDuration = (durationSecs && durationSecs > 0) ? durationSecs : 600;
  // +2s de buffer: si el cliente está en foreground, su pre-trigger ya habrá
  // pedido next; si está en background y no ha pedido, avanzamos rápido para
  // que el nuevo player:update llegue antes de que pasen demasiados segundos
  // de silencio aparente en el broadcast.
  const delay = (safeDuration + 2) * 1000;
  slog('songEnd:sched', { id: songId.slice(0, 8), sec: Math.round(delay / 1000) });
  songEndTimer = setTimeout(async () => {
    songEndTimer = null;
    const current = db.getNowPlaying();
    if (!current || current.id !== songId) {
      slog('songEnd:skip', { id: songId.slice(0, 8), reason: 'already-advanced' });
      return; // client already advanced
    }
    if (!db.getSessionActive()) return;
    slog('songEnd:fire', { id: songId.slice(0, 8) });
    console.log('[songEnd] auto-advance for song', songId);
    try { await advanceQueue({ auto: true }); } catch (e) { console.error('[songEnd] error:', e.message); }
  }, delay);
}

function autoEndSession() {
  sessionTimer = null;
  db.setSetting('session_end_time', '');
  clearSongEndTimer();
  stopBroadcast();
  resetRuntimeState();   // limpia todo el estado efímero (incluye pendingAutoDJ/autoDJActive)
  db.setSessionActive(false);
  db.clearAll();
  io.emit('session:update', { active: false, name: db.getSessionName(), desc: db.getSessionDesc() });
  io.emit('queue:update',   []);
  io.emit('player:update',  null);
  io.emit('autodj:update',  { enabled: db.getAutoDJEnabled(), active: false });
  io.emit('session:timer',  { endsAt: null });
  broadcastOnline();
}

function startSessionTimer(endsAtMs) {
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  db.setSetting('session_end_time', String(endsAtMs));
  const delay = endsAtMs - Date.now();
  if (delay <= 0) { autoEndSession(); return; }
  sessionTimer = setTimeout(autoEndSession, delay);
  io.emit('session:timer', { endsAt: endsAtMs });
}

function clearSessionTimer() {
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  db.setSetting('session_end_time', '');
  io.emit('session:timer', { endsAt: null });
}

// Online users: socketId -> { username, role }
const onlineUsers = new Map();

// Chat
const chatMessages  = [];          // in-memory, last 50
let   chatEnabled   = true;
const chatRateLimit = new Map();   // socketId -> last message timestamp ms

function broadcastOnline() {
  const list = [...onlineUsers.values()];
  io.emit('users:online', { count: list.length, users: list });
}

// Resetea TODO el estado efímero de runtime a un baseline limpio. Se llama al
// INICIAR y al TERMINAR sesión para que cada sesión empiece/termine pristina y
// no se filtre estado entre sesiones (causa de degradación tras horas).
function resetRuntimeState() {
  advanceInFlight     = false;            // limpia mutex de avance colgado
  lastAutoAdvanceAt   = 0;                // limpia ventana de debounce de auto-avance
  lastProgress        = { position: 0 };  // posición reportada a 0
  pendingAutoDJ       = null;             // descarta peek-next memoizado de la sesión anterior
  autoDJActive        = false;
  chatMessages.length = 0;                // vacía buffer de chat (mutar array const)
  onlineUsers.clear();
  chatRateLimit.clear();
  sessionLog.length   = 0;               // vacía log de diagnóstico de la sesión anterior
  sessionStartTime    = Date.now();
}

// slog: registra un evento en el log de sesión y lo emite en tiempo real.
// Usa declaración `function` (hoisted) para que los módulos superiores
// puedan llamarla antes de que aparezca textualmente.
function slog(event, data = {}) {
  const elapsed = sessionStartTime > 0 ? Math.round((Date.now() - sessionStartTime) / 1000) : 0;
  const entry   = { ts: Date.now(), elapsed, event, ...data };
  sessionLog.push(entry);
  if (sessionLog.length > SESSION_LOG_MAX) sessionLog.shift();
  io.emit('session:log', entry);
}

// Devuelve el log completo de la sesión activa (solo admin)
app.get('/api/admin/log', auth.adminMiddleware, (req, res) => {
  res.json(sessionLog);
});

io.on('connection', socket => {
  socket.emit('queue:update',   db.getQueue());
  socket.emit('player:update',  db.getNowPlaying());
  socket.emit('session:update', { active: db.getSessionActive(), name: db.getSessionName(), desc: db.getSessionDesc() });
  socket.emit('autodj:update',  { enabled: db.getAutoDJEnabled(), active: autoDJActive });
  const storedEnd = db.getSetting('session_end_time');
  socket.emit('session:timer',  { endsAt: storedEnd ? parseInt(storedEnd) : null });
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
    chatRateLimit.delete(socket.id);
    broadcastOnline();
  });

  // Remote control: relay commands to player and state back to remote
  socket.on('player:cmd',   cmd  => socket.broadcast.emit('player:cmd', cmd));
  socket.on('player:state', data => socket.broadcast.emit('player:state', data));

  socket.on('player:progress', data => { lastProgress = data || { position: 0 }; socket.broadcast.emit('player:progress', data); });

  // Avance automático desde PlayerView — sin auth, el servidor valida que haya sesión activa
  socket.on('player:auto-next', async (_, cb) => {
    if (typeof cb !== 'function') return;
    slog('autoNext:recv');
    if (!db.getSessionActive() && !db.getAutoDJEnabled()) return cb({ song: null });
    try {
      const song = await advanceQueue({ auto: true });
      cb({ song });
    } catch (e) {
      console.error('player:auto-next error:', e.message);
      cb({ song: null });
    }
  });

  // Peek: qué canción sonará a continuación SIN avanzar la cola. Lo usa el
  // cliente para precargar la siguiente con tiempo (≈90s antes del final) y
  // poder hacer un crossfade real. En AutoDJ pre-elige y memoiza la canción en
  // `pendingAutoDJ` para que el avance posterior reproduzca exactamente esa.
  socket.on('player:peek-next', async (_, cb) => {
    if (typeof cb !== 'function') return;
    slog('peekNext:recv', { hasPending: !!pendingAutoDJ });
    try {
      const queue = db.getQueue();
      if (queue.length) return cb({ song: queue[0] });
      if (!db.getAutoDJEnabled()) return cb({ song: null });
      if (!pendingAutoDJ) pendingAutoDJ = await pickAutoDJSong();
      cb({ song: pendingAutoDJ });
    } catch (e) {
      console.error('player:peek-next error:', e.message);
      cb({ song: null });
    }
  });

  // Log de diagnóstico del cliente (PlayerView emite eventos via socket)
  socket.on('client:log', ({ event, data } = {}) => {
    if (typeof event === 'string') slog('client:' + event, data || {});
  });

  // Enviar log histórico de la sesión a la nueva conexión
  socket.emit('session:log:init', sessionLog);

  // Silence config: send persisted values to new connection
  socket.emit('player:silence-config', {
    threshold: parseFloat(db.getSetting('silence_threshold') || 0.02),
    seconds:   parseFloat(db.getSetting('silence_seconds')   || 1),
  });

  // Crossfade config: send persisted value to new connection
  socket.emit('player:crossfade-config', {
    ms: parseInt(db.getSetting('crossfade_ms') || 4000, 10),
  });

  // Chat: send history to new connection
  socket.emit('chat:history', { messages: chatMessages, enabled: chatEnabled });

  socket.on('chat:send', ({ text }) => {
    if (!chatEnabled) return;
    if (!text || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (now - (chatRateLimit.get(socket.id) || 0) < 1000) return;
    chatRateLimit.set(socket.id, now);
    const user = onlineUsers.get(socket.id);
    const msg = { username: user?.username || 'Anónimo', text: clean, at: now };
    chatMessages.push(msg);
    if (chatMessages.length > 50) chatMessages.shift();
    io.emit('chat:message', msg);
  });

  socket.on('chat:clear', () => {
    if (onlineUsers.get(socket.id)?.role !== 'admin') return;
    chatMessages.length = 0;
    io.emit('chat:clear');
  });

  socket.on('chat:toggle', () => {
    if (onlineUsers.get(socket.id)?.role !== 'admin') return;
    chatEnabled = !chatEnabled;
    io.emit('chat:toggle', { enabled: chatEnabled });
  });
});

// Heartbeat: latido periódico a todos los clientes. Permite al watchdog del
// panel admin detectar de forma fiable y rápida (~20s) que el socket está
// muerto, sin depender del ping-timeout de socket.io (que tarda ~45s).
setInterval(() => { io.emit('heartbeat', Date.now()); }, 10000);

// Recover session timer after server restart
if (db.getSessionActive()) {
  const stored = db.getSetting('session_end_time');
  if (stored) startSessionTimer(parseInt(stored));
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('TuriaDJ on port', PORT));
