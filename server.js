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
// CORS restringido: con origin '*' cualquier web podia abrir un socket contra
// este servidor. Lista de origenes separada por comas en ALLOWED_ORIGIN.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (!ALLOWED_ORIGINS.length) {
  console.error('FATAL: ALLOWED_ORIGIN no definido (lista de origenes separada por comas).');
  process.exit(1);
}
const io     = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });

app.use(express.json());

// ── Live broadcast engine ────────────────────────────────────────────────────
// Streams one Navidrome song to all voter clients at real-time bitrate.
// Rate-limiter sends BYTES_PER_TICK every TICK_MS — default 192 kbps.
const TICK_MS       = 50;   // 50 ms ticks for smooth delivery
const JOIN_BUF_SECS = 1.5;  // seconds of audio kept for late joiners

let bcastClients    = new Set();
let bcastJoinBuf    = Buffer.alloc(0);
let bcastJoinBufMax = 0;
let bcastBPS        = 16000; // bytes/sec, recalculated per song
let bcastTicker     = null;
let bcastGen        = 0;     // token de generación: invalida promesas de startBroadcast obsoletas
let bcastSongId     = null;  // canción actualmente en emisión
let bcastSource     = null;  // fuente en emisión (ver openSource)
let bcastPrefetch   = null;  // siguiente canción ya descargándose (ver prefetchBroadcast)

// ── Log de diagnóstico por sesión ────────────────────────────────────────────
// Se resetea en cada inicio/fin de sesión. Registra eventos clave del motor de
// avance (servidor) y del cliente PlayerView (vía socket 'client:log').
const SESSION_LOG_MAX = 300;
let sessionLog       = [];
let sessionStartTime = 0;

// Devuelve cuántos bytes se pueden cortar del buffer sin partir un frame, para
// llegar lo más cerca posible de `target`. Emitir media trama hace que el
// decodificador del oyente escupa "Header missing" — y al cambiar de canción
// pasaba en CADA transición, porque el corte caía en cualquier byte.
function frameAlignedCut(buf, target) {
  let off = 0;
  while (off < target) {
    const h = parseMp3Header(buf, off);
    if (!h) break;                          // desincronizado
    if (off + h.len > buf.length) break;    // frame aún incompleto: esperar datos
    off += h.len;
  }
  return off;
}

function bcastTick() {
  const src = bcastSource;
  // Sin fuente, o aún buscando el primer frame de audio (se está saltando el tag
  // ID3): no hay nada que emitir todavía.
  if (!src || !src.sink.synced || src.sink.out.length === 0) return;
  if (src.bps) { bcastBPS = src.bps; bcastJoinBufMax = Math.ceil(bcastBPS * JOIN_BUF_SECS); }
  const bytesPerTick = Math.ceil(bcastBPS * TICK_MS / 1000);
  let cut = frameAlignedCut(src.sink.out, bytesPerTick);
  if (cut === 0) {
    // O falta buffer para completar el frame (esperar), o hemos perdido el sync
    // y hay basura delante: en ese caso resincronizar descartándola.
    if (src.sink.out.length < 4096) return;
    const resync = findMp3FrameStart(src.sink.out);
    if (resync <= 0) return;
    src.sink.out = src.sink.out.slice(resync);
    cut = frameAlignedCut(src.sink.out, bytesPerTick);
    if (cut === 0) return;
  }
  const chunk  = src.sink.out.slice(0, cut);
  src.sink.out = src.sink.out.slice(cut);
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

// El join buffer es una ventana rodante de bytes MP3 que empieza en un punto
// arbitrario (a media trama). Los decodificadores del navegador necesitan una
// cabecera de frame válida para empezar a decodificar; si el stream arranca a
// mitad de frame, el voter que entra a mitad de canción no sincroniza y no oye
// nada hasta el siguiente tema.
//
// OJO con los falsos positivos: buscar solo el sync 0xFFEx no basta — el payload
// de audio contiene rachas de 0xFF que parecen cabeceras. Hay que exigir Layer III
// y encadenar dos frames consecutivos (el segundo debe caer exactamente donde
// predice la longitud del primero).
const MP3_BR_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const MP3_BR_V2L3 = [0, 8,16,24,32,40,48,56, 64, 80, 96,112,128,144,160,0];
const MP3_SRATES   = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };

function parseMp3Header(buf, i) {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xFF || (buf[i + 1] & 0xE0) !== 0xE0) return null;
  const ver   = (buf[i + 1] >> 3) & 0x03;   // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reservado
  const layer = (buf[i + 1] >> 1) & 0x03;   // 1 = Layer III (MP3); 0=reservado
  if (ver === 1 || layer !== 1) return null;
  const brIdx = (buf[i + 2] >> 4) & 0x0F;
  const srIdx = (buf[i + 2] >> 2) & 0x03;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;  // free/bad/reservado
  const bitrate = (ver === 3 ? MP3_BR_V1L3 : MP3_BR_V2L3)[brIdx] * 1000;
  const srate   = MP3_SRATES[ver][srIdx];
  if (!bitrate || !srate) return null;
  const pad = (buf[i + 2] >> 1) & 0x01;
  const spf = ver === 3 ? 1152 : 576;       // samples/frame Layer III
  const len = Math.floor(spf / 8 * bitrate / srate) + pad;
  if (len < 24) return null;
  return { len, srate };
}

function findMp3FrameStart(buf) {
  for (let i = 0; i + 4 <= buf.length; i++) {
    const h1 = parseMp3Header(buf, i);
    if (!h1) continue;
    const j = i + h1.len;
    if (j + 4 > buf.length) continue;       // no se puede confirmar: seguir buscando
    const h2 = parseMp3Header(buf, j);
    if (!h2 || h2.srate !== h1.srate) continue;
    return i;                                // dos frames encadenados → sync real
  }
  return -1;
}

// ── Salto del tag ID3v2 ──────────────────────────────────────────────────────
// El 99,6% de la biblioteca lleva un ID3v2 con caratula incrustada (45 KB de
// media, hasta 263 KB). El broadcast dosifica bytes a ritmo de reproduccion
// (bcastBPS ~17 KB/s), asi que transmitir ese tag consumia 2,8 s de media —
// hasta 16 s en el peor caso — durante los que el decodificador del oyente no
// recibia NI UN frame de audio: silencio al empezar cada cancion. El navegador
// del admin no lo sufre porque descarga el fichero entero a toda velocidad.
// Nota: no basta con buscar el primer frame, porque el JPEG de la caratula
// puede contener secuencias que lo imiten; primero se salta el tag por su
// longitud declarada (syncsafe) y solo despues se busca el sync.
function findAudioStart(buf) {
  let base = 0;
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const tagLen = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                         ((buf[8] & 0x7f) << 7)  |  (buf[9] & 0x7f));
    if (buf.length < tagLen + 8) return -1;   // aun no ha llegado el final del tag
    base = tagLen;
  }
  const rel = findMp3FrameStart(buf.slice(base));
  return rel < 0 ? -1 : base + rel;
}

// Acumulador que descarta todo lo anterior al primer frame de audio y a partir
// de ahi deja pasar los bytes tal cual.
function makeSink() { return { pre: Buffer.alloc(0), synced: false, out: Buffer.alloc(0), skipped: 0 }; }

function sinkFeed(sink, chunk) {
  if (sink.synced) { sink.out = Buffer.concat([sink.out, chunk]); return; }
  sink.pre = Buffer.concat([sink.pre, chunk]);
  const start = findAudioStart(sink.pre);
  if (start >= 0) {
    sink.skipped = start;
    sink.out = sink.pre.slice(start);
    sink.pre = Buffer.alloc(0);
    sink.synced = true;
  } else if (sink.pre.length > 4 * 1024 * 1024) {
    // Salvaguarda: fichero raro sin sync reconocible. Emitir tal cual antes que
    // quedarnos callados para siempre.
    sink.out = sink.pre; sink.pre = Buffer.alloc(0); sink.synced = true;
  }
}

// Abre el stream de una canción en Navidrome y va llenando un sink (que descarta
// el tag ID3 inicial). No toca el estado de emisión: sirve tanto para la canción
// en curso como para precargar la siguiente.
function openSource(songId, duration) {
  const src = { songId, sink: makeSink(), bps: 16000, upstream: null, ready: false, failed: false };
  axios.get(nd.streamUrl(songId), { responseType: 'stream', timeout: 15000 })
    .then(upstream => {
      if (src.cancelled) { try { upstream.data.destroy(); } catch(e) {} return; }
      const fileSize = parseInt(upstream.headers['content-length'] || '0');
      // El tag ID3 no se emite, así que no debe contar para el ritmo de envío.
      const audioBytes = fileSize > 0 ? Math.max(1, fileSize - (src.sink.skipped || 0)) : 0;
      src.bps = (audioBytes > 0 && duration > 0) ? audioBytes / duration : 16000;
      src.upstream = upstream.data;
      upstream.data.on('data', chunk => {
        sinkFeed(src.sink, chunk);
        if (src.sink.synced && !src.ready) {
          src.ready = true;
          // Recalcular con el tamaño real del tag ya conocido
          if (fileSize > 0 && duration > 0)
            src.bps = Math.max(1, fileSize - src.sink.skipped) / duration;
        }
      });
      upstream.data.on('end',   () => { src.upstream = null; src.ended = true; });
      upstream.data.on('error', () => { src.upstream = null; src.failed = true; });
    })
    .catch(err => { src.failed = true; console.error('broadcast source error:', err.message); });
  return src;
}

// Precarga la siguiente canción mientras suena la actual. Se dispara desde
// player:peek-next (~90 s de antelación), así que al cambiar de tema los bytes
// ya están en RAM y el relevo es inmediato: sin esperar a Navidrome y sin tag.
function prefetchBroadcast(songId, duration) {
  if (!songId) return;
  if (bcastSongId === songId) return;                       // ya suena
  if (bcastPrefetch && bcastPrefetch.songId === songId) return;  // ya precargada
  if (bcastPrefetch) { bcastPrefetch.cancelled = true;
                       try { bcastPrefetch.upstream?.destroy(); } catch(e) {} }
  slog('broadcast:prefetch', { id: songId.slice(0, 8) });
  bcastPrefetch = openSource(songId, duration);
}

function startBroadcast(songId, duration) {
  slog('broadcast:start', { id: songId.slice(0, 8), dur: duration });
  const myGen = ++bcastGen;
  // Relevo: si la precarga es justo esta canción, promocionarla. El audio ya está
  // en RAM y sin tag ID3, así que el cambio no deja hueco.
  let src;
  if (bcastPrefetch && bcastPrefetch.songId === songId && !bcastPrefetch.failed) {
    src = bcastPrefetch;
    slog('broadcast:usePrefetch', { id: songId.slice(0, 8), buffered: src.sink.out.length });
  } else {
    if (bcastPrefetch) { bcastPrefetch.cancelled = true;
                         try { bcastPrefetch.upstream?.destroy(); } catch(e) {} }
    src = openSource(songId, duration);
  }
  bcastPrefetch = null;

  // Cerrar la fuente anterior (no la nueva) y adoptar la nueva como emisión.
  // Cerrar la fuente anterior. Ojo: hay que cerrar la vieja, nunca `src` — y no
  // vale guardarse el upstream aparte, porque cuando se promociona una precarga
  // la petición axios puede no haber resuelto todavía.
  const prev = bcastSource;
  if (prev && prev !== src) { prev.cancelled = true;
                              try { prev.upstream?.destroy(); } catch(e) {} }
  bcastSource     = src;
  bcastSongId     = songId;
  bcastJoinBuf    = Buffer.alloc(0);
  bcastBPS        = src.bps;
  bcastJoinBufMax = Math.ceil(bcastBPS * JOIN_BUF_SECS);
  // El ticker NO se para en los cambios de canción: si se parase, los oyentes
  // dejarían de recibir bytes hasta que Navidrome respondiese.
  if (!bcastTicker) bcastTicker = setInterval(bcastTick, TICK_MS);
  void myGen;
}

function stopBroadcast() {
  if (bcastTicker) { clearInterval(bcastTicker); bcastTicker = null; }
  for (const s of [bcastSource, bcastPrefetch]) {
    if (s) { s.cancelled = true; try { s.upstream?.destroy(); } catch (e) {} }
  }
  bcastSource = null; bcastPrefetch = null; bcastSongId = null;
  bcastJoinBuf = Buffer.alloc(0);
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
  // Nunca sembrar una contrasena por defecto: en un despliegue accesible desde
  // Internet equivale a no tener contrasena.
  if (!process.env.ADMIN_PASSWORD) {
    console.error('FATAL: no hay usuario admin y ADMIN_PASSWORD no esta definido.');
    process.exit(1);
  }
  db.createUser('admin', auth.hashPassword(process.env.ADMIN_PASSWORD), 'admin');
  console.log('Admin creado desde ADMIN_PASSWORD');
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
    // Si ya se sabe cuál viene después, empezar a bajarla ya: así el relevo no
    // depende de que un cliente llegue a pedir peek-next.
    const after = db.getQueue()[0];
    if (after) prefetchBroadcast(after.id, after.duration || 0);
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
  // Send rolling join buffer so late joiners start playing immediately.
  // Alineado a frame MP3: sin esto el buffer empieza a media trama y el
  // decodificador del navegador no sincroniza (silencio hasta el siguiente tema).
  if (bcastJoinBuf.length > 0) {
    const start = findMp3FrameStart(bcastJoinBuf);
    if (start >= 0) res.write(Buffer.from(bcastJoinBuf.slice(start)));
    // start < 0: no hay frame válido en el buffer → no enviamos nada; el cliente
    // sincroniza con los siguientes ticks del broadcast en cuanto llegue una cabecera.
  }
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
      if (queue.length) {
        // Aprovechar el aviso para precargar también el broadcast de los voters
        prefetchBroadcast(queue[0].id, queue[0].duration || 0);
        return cb({ song: queue[0] });
      }
      if (!db.getAutoDJEnabled()) return cb({ song: null });
      if (!pendingAutoDJ) pendingAutoDJ = await pickAutoDJSong();
      if (pendingAutoDJ) prefetchBroadcast(pendingAutoDJ.id, pendingAutoDJ.duration || 0);
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
