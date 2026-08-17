require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const axios    = require('axios');
const { spawn } = require('child_process');
const crypto   = require('crypto');
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
// Colchon que se entrega de golpe al conectar. El motor emite a tiempo real
// exacto, asi que sin esto el oyente vive con ~0 s de margen: en cuanto el movil
// pasa a segundo plano y el sistema throttlea la pestaña, se queda sin audio y
// la reproduccion se para. Con 6 s aguanta las suspensiones cortas. Es el clasico
// "burst on connect" de las radios por internet: el precio es empezar a escuchar
// unos segundos por detras del directo.
const JOIN_BUF_SECS = 6;

let bcastClients    = new Set();
let bcastJoinBuf    = Buffer.alloc(0);
let bcastJoinBufMax = 0;
let bcastBPS        = 16000; // bytes/sec, recalculated per song
let bcastTicker     = null;
let bcastGen        = 0;     // token de generación: invalida promesas de startBroadcast obsoletas
let bcastSongId     = null;  // canción actualmente en emisión
let bcastSource     = null;  // fuente en emisión (ver openSource)
let bcastPrefetch   = null;  // siguiente canción ya descargándose (ver prefetchBroadcast)
let bcastBridge     = null;  // segmento de crossfade A→B renderizado por ffmpeg
let bcastAfterBridge= null;  // { src, skipMs } canción que retoma tras la mezcla

// ── Log de diagnóstico por sesión ────────────────────────────────────────────
// Se resetea en cada inicio/fin de sesión. Registra eventos clave del motor de
// avance (servidor) y del cliente PlayerView (vía socket 'client:log').
// 300 se quedaba corto para revisar una sesion entera: 20 canciones son ~260
// eventos solo del motor, y ademas el panel ya manda los suyos.
const SESSION_LOG_MAX = 900;
let sessionLog       = [];
// Ultima vez que un reproductor reporto posicion. Sirve para saber si hay
// alguien dirigiendo la reproduccion o el motor esta solo.
let ultimoProgresoAt = 0;
let sessionStartTime = 0;

// ── El mando ─────────────────────────────────────────────────────────────────
// QUIEN reproduce y dirige, separado de quien ha iniciado sesion. Cualquier
// admin puede estar identificado a la vez; solo UNO tiene el mando.
//
// Hace falta porque el panel es quien dirige la reproduccion: con dos paneles
// abiertos, los dos piden el avance en el mismo instante (se salta una cancion)
// y los dos escriben la posicion de la sesion.
//
// `null` = mando libre. Se limpia al iniciar/terminar fiesta.
let mando = null;   // { deviceId, nombre, username, socketId, desde, latido }

// Sin latido en este tiempo, el mando queda libre. Es la salvaguarda que evita
// quedarse bloqueado fuera si el movil se queda sin bateria o el navegador se
// cierra en seco: sin esto, un dispositivo muerto inutilizaria la app.
const MANDO_TTL_MS = 30000;

function mandoVivo() {
  if (!mando) return null;
  if (Date.now() - mando.latido > MANDO_TTL_MS) { mando = null; return null; }
  return mando;
}
const tieneMando = deviceId => { const m = mandoVivo(); return !!m && !!deviceId && m.deviceId === deviceId; };

// Corta las ordenes de quien no tiene el mando. Solo bloquea si el mando esta
// EN MANOS DE OTRO: con el mando libre todo funciona igual que siempre, para no
// dejar la app inservible si nadie lo ha reclamado.
function soloMando(req, res, next) {
  const actual = mandoVivo();
  if (actual && actual.deviceId !== req.headers['x-device-id']) {
    return res.status(409).json({ error: 'Otro dispositivo tiene el control de la reproduccion',
                                  mando: { nombre: actual.nombre, desde: actual.desde } });
  }
  next();
}

function soltarMando(motivo) {
  if (!mando) return;
  slog('mando:suelta', { de: mando.nombre, motivo });
  mando = null;
  io.emit('control:estado', { ocupado: false });
}

function darMando(socket, { deviceId, nombre, username }) {
  const previo = mandoVivo();
  if (previo && previo.deviceId !== deviceId) {
    // Al anterior se le cierra la sesion del todo (decision del DJ): recibe el
    // aviso, para el audio y vuelve al login.
    io.to(previo.socketId).emit('control:revocado', { porQuien: nombre || 'otro dispositivo' });
    slog('mando:traspaso', { de: previo.nombre, a: nombre });
  }
  mando = { deviceId, nombre: nombre || 'dispositivo', username,
            socketId: socket.id, desde: Date.now(), latido: Date.now() };
  slog('mando:toma', { quien: mando.nombre });
  io.emit('control:estado', { ocupado: true, nombre: mando.nombre, desde: mando.desde });
}

// Devuelve cuántos bytes se pueden cortar del buffer sin partir un frame, para
// llegar lo más cerca posible de `target`. Emitir media trama hace que el
// decodificador del oyente escupa "Header missing" — y al cambiar de canción
// pasaba en CADA transición, porque el corte caía en cualquier byte.
// Corta frames completos hasta cubrir `targetMs` de audio. El presupuesto va en
// MILISEGUNDOS DE AUDIO, no en bytes: `fileSize/duration` es una estimacion que
// con VBR se desvia, y emitir de mas agota la cancion antes de tiempo (medido:
// 110 s de audio despachados en 85 s, y luego ~25 s mudos hasta el avance).
function frameAlignedCut(buf, targetMs) {
  let off = 0, ms = 0;
  while (ms < targetMs) {
    const h = parseMp3Header(buf, off);
    if (!h) break;                          // desincronizado
    if (off + h.len > buf.length) break;    // frame aún incompleto: esperar datos
    off += h.len; ms += h.ms;
  }
  return { bytes: off, ms };
}

// Descarta los primeros `ms` de audio de un buffer, en frontera de frame. Se usa
// tras el bridge: la cabeza de B ya ha sonado dentro de la mezcla, así que hay
// que reanudar B por donde se quedó y no desde el principio.
function skipFrames(buf, ms) {
  let off = 0, acc = 0;
  while (acc < ms) {
    const h = parseMp3Header(buf, off);
    if (!h || off + h.len > buf.length) break;
    off += h.len; acc += h.ms;
  }
  return buf.slice(off);
}

function bcastTick() {
  const src = bcastSource;
  // Sin fuente, o aún buscando el primer frame de audio (se está saltando el tag
  // ID3): no hay nada que emitir todavía.
  if (!src || !src.sink.synced || src.sink.out.length === 0) return;
  if (src.bps) { bcastBPS = src.bps; bcastJoinBufMax = Math.ceil(bcastBPS * JOIN_BUF_SECS); }

  // ¿Toca ya el crossfade? Se decide con el reloj de audio REALMENTE emitido,
  // no con el del cliente: así el punto de mezcla cae donde acaba el audio útil
  // de la canción (sin su silencio de cola) y no donde el cliente decida.
  if (!src.isBridge && bcastBridge && bcastBridge.ready && !bcastBridge.failed &&
      bcastBridge.startMs && src.emittedMs >= bcastBridge.startMs) {
    // La mezcla se renderizo hace minutos. Si desde entonces alguien ha añadido
    // o votado una cancion, la "siguiente" ya no es la misma y ese puente lleva
    // dentro la cabeza de OTRO tema: sonarian unos segundos de una cancion que
    // nadie ha pedido. Se comprueba justo antes de usarlo.
    const esperado = nextUpId();
    if (esperado && bcastBridge.songB !== esperado) {
      slog('broadcast:bridgeStale', { tenia: String(bcastBridge.songB).slice(0, 8),
                                      toca: String(esperado).slice(0, 8) });
      bcastBridge = null;
      prefetchBroadcast(esperado, nextUpDuration());   // precargar la correcta
      return;
    }
    enterBridge(esperado, true);
    return;
  }

  // Reloj de audio: se emite lo que falte para que el audio despachado alcance al
  // tiempo transcurrido. Asi la cancion dura exactamente lo que dura, sin adelantos.
  if (!src.clockStart) src.clockStart = Date.now() - (src.emittedMs || 0);
  let owedMs = (Date.now() - src.clockStart) - (src.emittedMs || 0);
  if (owedMs <= 0) return;
  if (owedMs > 2000) owedMs = 2000;         // techo: no soltar una rafaga tras un parón
  let cut = frameAlignedCut(src.sink.out, owedMs);
  if (cut.bytes === 0) {
    // O falta buffer para completar el frame (esperar), o hemos perdido el sync
    // y hay basura delante: en ese caso resincronizar descartándola.
    if (src.sink.out.length < 4096) { if (src.isBridge) finishBridge(); return; }
    const resync = findMp3FrameStart(src.sink.out);
    if (resync <= 0) { if (src.isBridge) finishBridge(); return; }
    src.sink.out = src.sink.out.slice(resync);
    cut = frameAlignedCut(src.sink.out, owedMs);
    if (cut.bytes === 0) return;
  }
  const chunk  = src.sink.out.slice(0, cut.bytes);
  src.sink.out = src.sink.out.slice(cut.bytes);
  src.emittedMs = (src.emittedMs || 0) + cut.ms;
  // El bridge es un buffer finito: al agotarlo hay que dar paso a la canción
  // siguiente, ya precargada y adelantada los segundos que duró la mezcla.
  if (src.isBridge && src.sink.out.length === 0) setImmediate(finishBridge);
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
  const ch = ((buf[i + 3] >> 6) & 0x03) === 3 ? 1 : 2;   // 11 = mono
  return { len, srate, spf, ch, ms: spf * 1000 / srate };
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
    // Formato real del stream: el bridge del crossfade debe generarse con estos
    // mismos parámetros, o el decodificador del oyente ve un cambio de config
    // de códec a mitad de stream y se rompe.
    const h = parseMp3Header(sink.out, 0);
    if (h) { sink.srate = h.srate; sink.ch = h.ch; }
  } else if (sink.pre.length > 4 * 1024 * 1024) {
    // Salvaguarda: fichero raro sin sync reconocible. Emitir tal cual antes que
    // quedarnos callados para siempre.
    sink.out = sink.pre; sink.pre = Buffer.alloc(0); sink.synced = true;
  }
}

// ── Crossfade en el servidor (para los oyentes de /api/live) ─────────────────
// El crossfade de cliente (dual <audio>) solo lo tienen el admin y PlayerView.
// Los voters recibian un corte seco, y si la cancion traia silencio de cola se
// oia ese silencio entero. Aqui se resuelve en dos pasos:
//   1. analizarFinal: localiza el punto donde debe entrar la siguiente, mirando
//      como acaba esta (final seco, silencio de cola o fundido).
//   2. renderBridge: ffmpeg mezcla la cola de A con la cabeza de B y devuelve un
//      MP3 que se emite en medio. Se genera con antelacion (peek-next avisa ~90 s
//      antes), asi que el arranque de ffmpeg no se nota.
// Todo degrada con seguridad: si algo falla se hace el corte limpio de siempre.
const BRIDGE_MAX_BYTES = 6 * 1024 * 1024;

// La regla que decide donde entra la siguiente cancion vive en mezcla.js, aparte,
// para poder medirla contra la biblioteca real sin arrancar el servidor.
const { puntosDeMezcla, OVERLAP_SEC, TAIL_SCAN_SEC, FILTRO_RMS } = require('./mezcla');
const tailCache = new Map();   // songId -> {audioEndMs, mixStartMs, fadeMs}

function analizarFinal(src, songId, durationSec) {
  if (!durationSec || durationSec < 20) return;
  const cached = tailCache.get(songId);
  if (cached) { Object.assign(src, cached); maybeRenderBridge(); return; }

  // Analizar la cancion ENTERA costaba 6,6 s de descarga y decodificacion por cada
  // tema, compitiendo con el hilo que emite el audio. Solo interesa el final, asi
  // que se salta directamente ahi.
  const from = Math.max(0, durationSec - TAIL_SCAN_SEC);
  const ff = spawn('ffmpeg', ['-hide_banner','-nostats','-ss', String(from), '-i', nd.streamUrl(songId),
    '-af', FILTRO_RMS,
    '-f','null','-']);
  let out = '';
  ff.stdout.on('data', d => { out += d.toString(); if (out.length > 4e6) { try { ff.kill('SIGKILL'); } catch(e) {} } });
  ff.stderr.on('data', () => {});
  ff.on('error', () => {});
  ff.on('close', () => {
    if (src.cancelled) return;
    const v = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)]
      .map(m => m[1] === '-inf' ? -99 : parseFloat(m[1]))
      .filter(x => !isNaN(x));
    const p = puntosDeMezcla(v, from, durationSec);
    Object.assign(src, p);
    tailCache.set(songId, p);
    if (tailCache.size > 400) tailCache.delete(tailCache.keys().next().value);
    slog('broadcast:mezcla', { id: songId.slice(0, 8),
      entra:   +(p.mixStartMs / 1000).toFixed(1),
      dura:    +durationSec.toFixed(1),
      fundido: +(p.fadeMs / 1000).toFixed(1) });
    // El analisis tarda unos segundos: cuando acaba hay que reenviar la cancion
    // para que el reproductor de la sala sepa ya donde entra la siguiente. Sin
    // esto solo se enteraria a partir del tema siguiente.
    const actual = db.getNowPlaying();
    if (actual && actual.id === songId) io.emit('player:update', nowPlayingConMezcla());
    maybeRenderBridge();
  });
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch(e) {} }, 60000);
}


// ── Silencio con el que ARRANCA la cancion entrante ──────────────────────────
// Medido sobre la biblioteca: 7 de cada 20 canciones empiezan con silencio y la
// peor traia 7,9 s. Si no se recorta, el solape de 3 s cae sobre la nada: la
// saliente se apaga y la entrante todavia no ha empezado. Es el mismo silencio
// que se quiere evitar, solo que por el otro lado.
const INTRO_MAX_SEC = 8;              // tope: no comerse una intro de verdad
const introCache    = new Map();      // songId -> ms de silencio inicial

function analizarIntro(songId) {
  if (!songId || introCache.has(songId)) return;
  introCache.set(songId, 0);          // provisional: no lanzar dos analisis a la vez
  const ff = spawn('ffmpeg', ['-hide_banner', '-nostats', '-t', String(INTRO_MAX_SEC + 2),
    '-i', nd.streamUrl(songId), '-af', 'silencedetect=n=-50dB:d=0.2', '-f', 'null', '-']);
  let err = '';
  ff.stderr.on('data', d => { if (err.length < 65536) err += d.toString(); });
  ff.on('error', () => {});
  ff.on('close', () => {
    const m = err.match(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/);
    let ms = (m && parseFloat(m[1]) < 0.3) ? Math.min(INTRO_MAX_SEC, parseFloat(m[2])) * 1000 : 0;
    if (ms < 300) ms = 0;             // por debajo de 0,3 s no se nota
    introCache.set(songId, ms);
    if (introCache.size > 400) introCache.delete(introCache.keys().next().value);
    if (ms) {
      slog('broadcast:intro', { id: songId.slice(0, 8), corta: +(ms / 1000).toFixed(1) });
      // Una mezcla ya renderizada arrancaria B en su segundo 0, con el silencio
      // dentro. Se tira y se rehace con el arranque bueno.
      if (bcastBridge && bcastBridge.songB === songId) { bcastBridge = null; maybeRenderBridge(); }
      broadcast();                    // que el cliente se entere del recorte
    }
  });
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 30000);
}
const introMs  = id => introCache.get(id) || 0;
const conIntro = s => (s && introMs(s.id)) ? { ...s, introMs: introMs(s.id) } : s;

// Descarta los primeros `ms` de una fuente. Si el sink ya está sincronizado se
// recorta el buffer en el acto; si todavía no, se deja apuntado para cuando lo
// esté (una precarga recién abierta aún no tiene ni el primer frame).
function saltarSilencioInicial(src, ms) {
  if (!src || !ms) return;
  if (src.sink.synced && src.sink.out.length) src.sink.out = skipFrames(src.sink.out, ms);
  else src.skipPendingMs = ms;
}

// Genera el segmento de mezcla A→B. `startSec` es el punto de A donde arranca.
// Si A ya viene desvaneciendose sola (`yaBaja`), aplicarle encima un fundido de
// salida completo la haria desaparecer al doble de velocidad: en ese caso solo se
// le pone el ultimo segundo, lo justo para que el corte final no suene a click.
function renderBridge(songA, startSec, songB, secs, srate, ch, yaBaja) {
  const gen = bcastGen;
  const introB = introMs(songB) / 1000;    // arrancar B donde empieza su sonido
  const bridge = { ready: false, buf: Buffer.alloc(0), gen, songB, secs, introMs: introB * 1000 };
  const fadeA = yaBaja ? `afade=t=out:st=${Math.max(0, secs - 1)}:d=1`
                       : `afade=t=out:st=0:d=${secs}`;
  const f = `[0:a]${fadeA}[a];[1:a]afade=t=in:st=0:d=${secs}[b];` +
            `[a][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[out]`;
  const ff = spawn('ffmpeg', ['-v','error',
    '-ss', String(startSec), '-t', String(secs), '-i', nd.streamUrl(songA),
    '-ss', String(introB), '-t', String(secs), '-i', nd.streamUrl(songB),
    '-filter_complex', f,
    // -map explicito + -vn: las canciones llevan la caratula incrustada y ffmpeg
    // la mapea sola como stream de video. Con el ID3v2 desactivado en la salida
    // no puede escribirla, falla la cabecera y no produce NI UN byte.
    '-map', '[out]', '-vn',
    '-ar', String(srate), '-ac', String(ch), '-c:a', 'libmp3lame', '-b:a', '192k',
    // Sin ID3 ni frame Xing: insertados a mitad de stream, el decodificador ve un
    // tag donde esperaba audio y da "Header missing" (asi fallo el intento viejo).
    '-f','mp3','-write_xing','0','-id3v2_version','0','-map_metadata','-1','-flags','+bitexact','-']);
  const chunks = []; let n = 0, errTxt = '';
  ff.stdout.on('data', d => { n += d.length; if (n <= BRIDGE_MAX_BYTES) chunks.push(d); });
  ff.stderr.on('data', d => { if (errTxt.length < 2048) errTxt += d.toString(); });
  ff.on('error', e => { bridge.failed = true; slog('broadcast:bridgeFail', { why: 'spawn ' + e.message }); });
  ff.on('close', code => {
    if (code !== 0 || !chunks.length) {
      bridge.failed = true;
      slog('broadcast:bridgeFail', { code, bytes: n, err: errTxt.trim().split('\n')[0] || '' });
      return;
    }
    const raw = Buffer.concat(chunks);
    const start = findAudioStart(raw);
    if (start < 0) { bridge.failed = true; slog('broadcast:bridgeFail', { why: 'sin frame valido' }); return; }
    bridge.buf = raw.slice(start);
    bridge.ready = true;
    slog('broadcast:bridgeReady', { kb: Math.round(bridge.buf.length/1024), secs });
  });
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch(e) {} }, 60000);
  return bridge;
}

// Conmuta la emisión al segmento de mezcla ya renderizado. La canción A se
// abandona aquí (su cola era silencio o estaba a punto de acabarse) y B queda
// esperando en bcastAfterBridge.
// Devuelve `true` solo si la emisión ha pasado de verdad a la mezcla. Quien la
// llama TIENE que mirar el resultado: si se descarta la mezcla y el llamante da
// por hecho que el relevo se ha hecho, el motor se queda emitiendo la canción
// anterior mientras `bcastSongId` dice otra cosa (ver startBroadcast).
// `esperado` es la canción hacia la que se quiere ir; si no coincide con la que
// lleva dentro la mezcla, esa mezcla es de otro par de canciones.
//
// `avanzarDb`: cuando la mezcla arranca sola (por el reloj de audio, sin que
// nadie la haya pedido), hay que mover TAMBIEN `nowPlaying`. Si no, el audio se
// va a la cancion siguiente y la base de datos se queda en la anterior hasta que
// salta la red de seguridad en `duracion + 2`. Medido en una sesion real sin
// ningun panel conectado, ese desfase se ACUMULA: 0 s → 35 s → 40 s → 64 s. Y
// como "cual va despues", la precarga y la verja anti-obsoletos se calculan
// desde la base de datos, al crecer el desfase el motor acaba preparando la
// mezcla hacia una cancion que en la emision ya ha sonado: corte antes de
// tiempo y temas repetidos.
// ⚠️ NO se pasa `true` desde `startBroadcast`: ahi el avance ya esta en curso y
// se entraria en recursion (advanceQueue → startBroadcast → enterBridge → ...).
function enterBridge(esperado, avanzarDb = false) {
  const b = bcastBridge;
  if (!b || !b.ready || !bcastPrefetch || bcastPrefetch.songId !== b.songB) { bcastBridge = null; return false; }
  if (esperado && b.songB !== esperado) {
    slog('broadcast:bridgeStale', { tenia: String(b.songB).slice(0, 8), toca: String(esperado).slice(0, 8) });
    bcastBridge = null; return false;
  }
  slog('broadcast:crossfade', { secs: b.secs, kb: Math.round(b.buf.length/1024) });
  const prev = bcastSource;
  // Lo que ya ha sonado de B dentro de la mezcla, mas el silencio inicial que la
  // mezcla se ha saltado: al soltar B hay que empezar justo donde lo dejo.
  bcastAfterBridge = { src: bcastPrefetch, skipMs: b.secs * 1000 + (b.introMs || 0) };
  // Desde ya la emisión "es" la canción siguiente: si el cliente pide el avance
  // mientras suena la mezcla, el guard de startBroadcast lo ignora en vez de
  // reiniciar la canción y cortar el crossfade a la mitad.
  bcastSongId   = b.songB;
  bcastPrefetch = null;
  bcastBridge   = null;
  if (prev) { prev.cancelled = true; try { prev.upstream?.destroy(); } catch(e) {} }
  bcastSource = {
    songId: prev ? prev.songId : null,
    isBridge: true,
    bps: prev ? prev.bps : bcastBPS,
    emittedMs: 0,
    sink: { pre: Buffer.alloc(0), synced: true, out: b.buf, skipped: 0,
            srate: prev?.sink.srate, ch: prev?.sink.ch }
  };
  // Que la app diga lo mismo que esta sonando. Fuera del tick para no meter
  // trabajo asincrono dentro del bucle que emite audio.
  if (avanzarDb) setImmediate(() => {
    // Solo si NO hay nadie dirigiendo. Con un panel vivo, el avance lo pide el,
    // y si lo pidiesemos los dos a la vez se saltaria una cancion.
    if (Date.now() - ultimoProgresoAt < 15000) return;
    // Y si la app ya se movio por su cuenta mientras tanto, no hay nada que hacer.
    const actual = db.getNowPlaying();
    if (actual && actual.id === b.songB) return;
    slog('broadcast:dbAtrasada', { pone: String(b.songB).slice(0, 8) });
    advanceQueue({ auto: true })
      .catch(e => console.error('avance desde la mezcla:', e.message));
  });
  return true;
}

// El bridge se ha agotado: dar paso a B, saltando la parte que ya sonó mezclada.
function finishBridge() {
  const after = bcastAfterBridge;
  bcastAfterBridge = null;
  if (!after || !after.src) return;
  const src = after.src;
  if (src.sink.synced && src.sink.out.length) src.sink.out = skipFrames(src.sink.out, after.skipMs);
  if (!src.sink.synced) src.skipPendingMs = after.skipMs;  // saltar al sincronizar
  bcastSource    = src;
  bcastSongId    = src.songId;
  // La cancion ya lleva sonando `skipMs` dentro de la mezcla: si `emittedMs`
  // volviese a cero, el puente hacia la SIGUIENTE se dispararia ese tanto mas
  // tarde. El reloj se atrasa lo mismo para que el ritmo de emision no cambie.
  src.emittedMs  = after.skipMs;
  src.clockStart = Date.now() - after.skipMs;
  bcastBPS       = src.bps;
  slog('broadcast:bridgeDone', { id: String(src.songId).slice(0,8) });
  if (src.songId) analizarFinal(src, src.songId, src.durationSec || 0);
}

// Interruptor del crossfade de servidor. Por DEFECTO DESACTIVADO: la ruta que
// dispara la mezcla por el reloj de audio (final natural de la cancion) no esta
// suficientemente probada y dejo la reproduccion muda en produccion. Con esto en
// '0' el motor cae al relevo gapless, que si esta verificado A/B. Se reactiva con
// POST /api/player/server-crossfade {enabled:true} sin tocar codigo.
function serverCrossfadeEnabled() {
  return db.getSetting('crossfade_server') === '1';
}

// Lanza el render en cuanto se conocen las dos canciones y el punto de mezcla de A.
function maybeRenderBridge() {
  if (!serverCrossfadeEnabled()) return;
  const cur = bcastSource, nxt = bcastPrefetch;
  if (!cur || !nxt || bcastBridge || !cur.songId || !nxt.songId) return;
  if (!cur.mixStartMs || !cur.sink.srate) return;
  const startSec = cur.mixStartMs / 1000;
  if (startSec <= 1) return;
  bcastBridge = renderBridge(cur.songId, startSec, nxt.songId, OVERLAP_SEC,
                             cur.sink.srate, cur.sink.ch || 2, cur.fadeMs > 0);
  bcastBridge.startMs = cur.mixStartMs;
}

// Abre el stream de una canción en Navidrome y va llenando un sink (que descarta
// el tag ID3 inicial). No toca el estado de emisión: sirve tanto para la canción
// en curso como para precargar la siguiente.
function openSource(songId, duration, offsetSec = 0) {
  const src = { songId, durationSec: duration, emittedMs: 0, offsetSec,
                sink: makeSink(), bps: 16000, upstream: null, ready: false, failed: false };
  axios.get(nd.streamUrl(songId, offsetSec), { responseType: 'stream', timeout: 15000 })
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
          // Si esta fuente entra tras un bridge, saltar lo que ya sonó mezclado
          if (src.skipPendingMs) { src.sink.out = skipFrames(src.sink.out, src.skipPendingMs); src.skipPendingMs = 0; }
          maybeRenderBridge();   // ya se conoce el formato: se puede renderizar
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
// Que cancion sonara de verdad a continuacion: manda la cola de usuarios y, si
// esta vacia, la pre-eleccion de AutoDJ. Es la referencia para saber si una
// mezcla ya renderizada se ha quedado obsoleta.
function nextUpId() {
  const q = db.getQueue();
  if (q.length) return q[0].id;
  return (db.getAutoDJEnabled() && pendingAutoDJ) ? pendingAutoDJ.id : null;
}
function nextUpDuration() {
  const q = db.getQueue();
  if (q.length) return q[0].duration || 0;
  return pendingAutoDJ ? (pendingAutoDJ.duration || 0) : 0;
}

// Deja elegida y DESCARGANDOSE la siguiente cancion de AutoDJ nada mas empezar la
// actual. Antes esto solo ocurria si un cliente llamaba a `player:peek-next`, asi
// que en una sesion sin PlayerView activo no habia precarga: al cambiar de tema
// habia que bajar la cancion entera desde cero (de ahi la tardanza) y encima no
// daba tiempo a preparar el crossfade.
function primeNextAutoDJ() {
  setTimeout(async () => {
    try {
      if (!db.getSessionActive() || !db.getAutoDJEnabled()) return;
      if (db.getQueue().length) return;          // la cola de usuarios manda
      if (bcastPrefetch) return;                 // ya hay una en camino
      if (!pendingAutoDJ) pendingAutoDJ = await pickAutoDJSong();
      if (pendingAutoDJ) prefetchBroadcast(pendingAutoDJ.id, pendingAutoDJ.duration || 0);
    } catch (e) { console.error('primeNextAutoDJ error:', e.message); }
  }, 1500);   // pequeño respiro: que la cancion actual arranque primero
}

function prefetchBroadcast(songId, duration) {
  if (!songId) return;
  if (bcastSongId === songId) return;                       // ya suena
  if (bcastPrefetch && bcastPrefetch.songId === songId) return;  // ya precargada
  if (bcastPrefetch) { bcastPrefetch.cancelled = true;
                       try { bcastPrefetch.upstream?.destroy(); } catch(e) {} }
  slog('broadcast:prefetch', { id: songId.slice(0, 8) });
  analizarIntro(songId);         // saber si arranca con silencio, para recortarlo
  bcastPrefetch = openSource(songId, duration);
  bcastBridge   = null;          // la mezcla vieja apuntaba a otra canción
  maybeRenderBridge();
}

function startBroadcast(songId, duration, offsetSec = 0) {
  slog('broadcast:start', { id: songId.slice(0, 8), dur: duration, ...(offsetSec ? { desde: Math.round(offsetSec) } : {}) });
  // Idempotencia: se ignora el arranque solo si esa misma canción sigue VIVA en
  // emisión (o estamos mezclando hacia ella). Si la fuente ya se agotó hay que
  // reiniciar de verdad — un guard que mirase únicamente el id dejaba el audio
  // mudo cuando se pedía relanzar la canción en curso, y AutoDJ elige al azar,
  // así que puede repetir canción.
  if (bcastSongId === songId && bcastSource && !bcastSource.failed &&
      (bcastSource.isBridge || bcastSource.sink.out.length > 0 || bcastSource.upstream)) return;
  // El avance del cliente llega ~5 s antes del final. Si la mezcla para
  // justamente esta canción ya está lista, ese avance debe DISPARAR el crossfade
  // en vez de cancelarlo con un corte seco.
  if (bcastBridge && bcastBridge.ready && !bcastBridge.failed &&
      bcastBridge.songB === songId && bcastPrefetch && bcastPrefetch.songId === songId) {
    bcastPrefetch.durationSec = duration;
    // `songId` (no nextUpId) es hacia donde se va: en este punto la canción nueva
    // YA es la que suena, y la "siguiente" es la de detrás. Con nextUpId aquí la
    // mezcla se descartaba SIEMPRE por obsoleta.
    if (enterBridge(songId)) { bcastSongId = songId; return; }
    // Si la mezcla se descartó no se puede volver con `return`: el motor seguiría
    // emitiendo la canción ANTERIOR mientras bcastSongId dice otra cosa, y minutos
    // después una mezcla vieja dispararía sola. Se sigue con el relevo normal.
  }
  const myGen = ++bcastGen;
  // Relevo: si la precarga es justo esta canción, promocionarla. El audio ya está
  // en RAM y sin tag ID3, así que el cambio no deja hueco.
  let src;
  // La precarga solo sirve si se arranca desde el principio; al reanudar a mitad
  // de cancion (offsetSec) hay que abrir la fuente en el punto correcto.
  if (!offsetSec && bcastPrefetch && bcastPrefetch.songId === songId && !bcastPrefetch.failed) {
    src = bcastPrefetch;
    slog('broadcast:usePrefetch', { id: songId.slice(0, 8), buffered: src.sink.out.length });
  } else {
    if (bcastPrefetch) { bcastPrefetch.cancelled = true;
                         try { bcastPrefetch.upstream?.destroy(); } catch(e) {} }
    src = openSource(songId, duration, offsetSec);
  }
  bcastPrefetch = null;
  // Arrancar donde empieza el sonido. Dentro de una mezcla ya se hacía; aquí se
  // cubre el resto de arranques (primera canción de la sesión, skip del DJ), que
  // si no emitían el silencio entero. Al reanudar a mitad (offsetSec) no aplica.
  if (!offsetSec) saltarSilencioInicial(src, introMs(songId));

  // Cerrar la fuente anterior (no la nueva) y adoptar la nueva como emisión.
  // Cerrar la fuente anterior. Ojo: hay que cerrar la vieja, nunca `src` — y no
  // vale guardarse el upstream aparte, porque cuando se promociona una precarga
  // la petición axios puede no haber resuelto todavía.
  const prev = bcastSource;
  if (prev && prev !== src) { prev.cancelled = true;
                              try { prev.upstream?.destroy(); } catch(e) {} }
  bcastSource     = src;
  bcastSongId     = songId;
  src.emittedMs   = 0;
  src.clockStart  = Date.now();   // el reloj de audio arranca al adoptar la fuente
  bcastJoinBuf    = Buffer.alloc(0);
  bcastBPS        = src.bps;
  bcastJoinBufMax = Math.ceil(bcastBPS * JOIN_BUF_SECS);
  // Un avance explícito invalida cualquier mezcla pendiente: apuntaba a otro par
  // de canciones. Sin esto, un skip del DJ dispararía un crossfade equivocado.
  bcastBridge = null; bcastAfterBridge = null;
  // Localizar dónde acaba el audio útil (sin el silencio de cola) con tiempo de
  // sobra: el resultado se usa varios minutos después, al preparar el crossfade.
  analizarFinal(src, songId, duration);
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
  if (bcastAfterBridge?.src) { bcastAfterBridge.src.cancelled = true;
                               try { bcastAfterBridge.src.upstream?.destroy(); } catch(e) {} }
  bcastSource = null; bcastPrefetch = null; bcastSongId = null;
  bcastBridge = null; bcastAfterBridge = null;
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
  db.createUser('admin', auth.hashPasswordSync(process.env.ADMIN_PASSWORD), 'admin');
  console.log('Admin creado desde ADMIN_PASSWORD');
}

// Toda mutacion de la cola (añadir, votar, quitar, fijar, vaciar) pasa por aqui.
// Si con ello cambia cual es la SIGUIENTE cancion, la mezcla y la precarga que ya
// estaban preparadas apuntan a otro tema: hay que tirarlas y preparar la buena.
// Sin esto sonaban unos segundos de una cancion que nadie habia pedido.
function syncNextUp() {
  const esperado = nextUpId();
  if (!esperado) return;
  if (bcastPrefetch && bcastPrefetch.songId !== esperado) {
    bcastPrefetch.cancelled = true;
    try { bcastPrefetch.upstream?.destroy(); } catch (e) {}
    bcastPrefetch = null;
  }
  if (bcastBridge && bcastBridge.songB !== esperado) bcastBridge = null;
  if (!bcastPrefetch && bcastSongId !== esperado) prefetchBroadcast(esperado, nextUpDuration());
}

// La canción que se manda al cliente lleva `mixStartMs`: el instante EXACTO en el
// que debe entrar la siguiente, ya calculado segun como acabe esta (seco, con
// silencio de cola o con fundido). El reproductor de la sala solo tiene que
// arrancar ahi su crossfade de 3 s. Es el mismo punto que usa la mezcla del
// servidor para los oyentes de /api/live, asi que sala y moviles cortan igual.
function nowPlayingConMezcla() {
  const song = db.getNowPlaying();
  if (!song) return null;
  const p = (bcastSource && bcastSource.songId === song.id && bcastSource.mixStartMs)
    ? bcastSource
    : tailCache.get(song.id);
  const intro = introMs(song.id);
  if (!p || !p.mixStartMs) return intro ? { ...song, introMs: intro } : song;
  return { ...song, mixStartMs: p.mixStartMs, audioEndMs: p.audioEndMs,
           fadeMs: p.fadeMs, overlapSec: OVERLAP_SEC, introMs: intro };
}

const broadcast = () => {
  io.emit('queue:update',  db.getQueue().map(conIntro));
  io.emit('player:update', nowPlayingConMezcla());
  try { syncNextUp(); } catch (e) { console.error('syncNextUp error:', e.message); }
};

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (username.length < 3)    return res.status(400).json({ error: 'Usuario muy corto (min 3 letras)' });
  if (password.length < 4)    return res.status(400).json({ error: 'Contrasena muy corta (min 4 letras)' });
  if (username.toLowerCase() === 'admin') return res.status(409).json({ error: 'Ese nombre no esta disponible' });
  try {
    const hash  = await auth.hashPassword(password);   // no bloquea el audio
    const user  = db.createUser(username, hash, 'user');
    const token = auth.signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ese nombre ya esta en uso' });
    console.error('register error:', e.message);     // el detalle al log, nunca al cliente
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = db.getUserByUsername(username);
    // Las cuentas creadas con Google llevan un centinela en password_hash, no un
    // hash bcrypt. Se rechazan aqui explicitamente en vez de dejarselo a bcrypt.
    const esCuentaConPassword = !!user && typeof user.password_hash === 'string'
                                && user.password_hash.startsWith('$2');
    const ok = esCuentaConPassword && typeof password === 'string'
      ? await auth.verifyPassword(password, user.password_hash)
      : false;
    if (!ok) {
      if (user && !esCuentaConPassword)
        return res.status(401).json({ error: 'Esta cuenta entra con Google' });
      return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    }
    const token = auth.signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/auth/me', auth.authMiddleware, (req, res) => res.json(req.user));

// ── Google Sign-In ───────────────────────────────────────────────────────────
// Flujo de ID token: el movil obtiene de Google un JWT firmado y nos lo manda.
// El servidor lo verifica contra las claves publicas de Google (firma, emisor y
// audiencia). NO se confia en nada que venga del cliente sin verificar, y no
// hace falta custodiar ningun "client secret".
// Queda inactivo mientras GOOGLE_CLIENT_ID no este definido en .env.
let googleClient = null;
if (process.env.GOOGLE_CLIENT_ID) {
  try {
    const { OAuth2Client } = require('google-auth-library');
    googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    console.log('Google Sign-In activado');
  } catch (e) {
    console.error('Google Sign-In NO disponible (falta google-auth-library):', e.message);
  }
}

// El cliente pregunta si debe pintar el boton, y con que ID.
app.get('/api/auth/google/config', (req, res) =>
  res.json({ enabled: !!googleClient, clientId: process.env.GOOGLE_CLIENT_ID || null }));

// Deriva un nombre visible libre a partir del perfil de Google.
function usernameLibre(base) {
  let limpio = String(base || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (limpio.length < 3) limpio = 'invitado';
  if (limpio.toLowerCase() === 'admin') limpio = 'invitado';
  if (!db.usernameTaken(limpio)) return limpio;
  for (let i = 2; i < 200; i++) {
    const cand = limpio.slice(0, 17) + ' ' + i;
    if (!db.usernameTaken(cand)) return cand;
  }
  return 'invitado ' + crypto.randomUUID().slice(0, 6);
}

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Acceso con Google no configurado' });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Falta el token de Google' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,   // el token debe ser PARA esta app
    });
    const p = ticket.getPayload();
    // Un email sin verificar podria ser de otra persona: no vale para vincular.
    if (!p || !p.sub || !p.email || p.email_verified !== true)
      return res.status(401).json({ error: 'Cuenta de Google no verificada' });

    let user = db.getUserByGoogleSub(p.sub);
    if (!user) {
      const previo = db.getUserByEmail(p.email);
      if (previo) {                     // ya existia con ese email: se vincula
        db.linkGoogle(previo.id, p.sub, p.email);
        user = db.getUserByUsername(previo.username);
        slog('auth:googleLink', { user: previo.username.slice(0, 16) });
      } else {
        const nombre = usernameLibre(p.given_name || p.name || String(p.email).split('@')[0]);
        user = db.createGoogleUser(nombre, p.sub, p.email);
        slog('auth:googleNuevo', { user: nombre.slice(0, 16) });
      }
    }
    const token = auth.signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    console.error('google login error:', e.message);
    res.status(401).json({ error: 'No se pudo validar la cuenta de Google' });
  }
});

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

app.post('/api/session/start', auth.adminMiddleware, soloMando, (req, res) => {
  const { duration } = req.body || {};
  resetRuntimeState();   // baseline limpio: que la sesión nueva no herede estado viejo
  db.setSetting('session_started_at', String(sessionStartTime));   // sobrevive a un reinicio
  slog('session:start', { duration: duration || 0 });
  db.setSessionActive(true);
  io.emit('session:update', { active: true, name: db.getSessionName(), desc: db.getSessionDesc() });
  io.emit('autodj:update', { enabled: db.getAutoDJEnabled(), active: false });
  broadcastOnline();
  if (duration && Number(duration) > 0) {
    startSessionTimer(Date.now() + Number(duration) * 60 * 1000);
  } else {
    db.setSetting('session_end_time', '');
    emitirTiempos(null);
  }
  res.json({ success: true });
});

app.post('/api/session/end', auth.adminMiddleware, soloMando, (req, res) => {
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

// Margen de inactividad, en minutos. 0 = no cerrar nunca por inactividad.
app.post('/api/session/inactividad', auth.adminMiddleware, soloMando, (req, res) => {
  const { minutos } = req.body || {};
  const v = Math.max(0, Math.min(720, parseInt(minutos, 10) || 0));
  db.setSetting('session_inactividad_min', String(v));
  marcarActividad('cambia el margen');
  emitirTiempos();
  res.json({ success: true, minutos: v });
});

// "Seguimos aqui": el admin retira el aviso sin tener que tocar nada mas.
app.post('/api/session/sigo', auth.adminMiddleware, (req, res) => {
  marcarActividad('sigo aqui');
  emitirTiempos();
  res.json({ success: true, hasta: finPorInactividad() });
});

app.post('/api/session/extend', auth.adminMiddleware, soloMando, (req, res) => {
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

app.get('/api/queue', auth.authMiddleware, (req, res) => res.json(db.getQueue().map(conIntro)));

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
  marcarActividad('añade cancion');
  // Medir ya si arranca con silencio: cuando le toque sonar el dato estara listo,
  // venga por una transicion o por un arranque en seco.
  analizarIntro(song.id);
  if (req.user.role !== 'admin') db.recordAddition(req.user.id);
  broadcast();
  res.json({ success: true });
});

app.post('/api/queue/vote', auth.authMiddleware, (req, res) => {
  marcarActividad('vota');
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
  marcarActividad('vacia la cola');
  db.clearQueue();
  broadcast();
  res.json({ success: true });
});

// El recorte de cola ya no se configura: hubo dos mandos (umbral en dB y recorte
// maximo) y no habia forma de acertar con un solo par de valores para toda la
// biblioteca. Ahora la regla es fija —solapar 3 s— y lo unico que se calcula por
// cancion es DONDE empieza ese solapamiento (ver puntosDeMezcla). El endpoint se
// mantiene para que un cliente con JS viejo en cache no reciba un 404, y para
// poder forzar un recalculo de la cancion en curso.
app.post('/api/player/silence-config', auth.adminMiddleware, (req, res) => {
  tailCache.clear();
  bcastBridge = null;
  if (bcastSource && bcastSource.songId && !bcastSource.isBridge) {
    bcastSource.mixStartMs = null;
    analizarFinal(bcastSource, bcastSource.songId, bcastSource.durationSec || 0);
  }
  res.json({ success: true, overlapSec: OVERLAP_SEC });
});

app.post('/api/player/crossfade-config', auth.adminMiddleware, (req, res) => {
  const { ms } = req.body;
  if (ms !== undefined && ms > 0) db.setSetting('crossfade_ms', ms);
  const crossfadeMs = parseInt(db.getSetting('crossfade_ms') || 4000, 10);
  io.emit('player:crossfade-config', { ms: crossfadeMs });
  res.json({ success: true, ms: crossfadeMs });
});

app.get('/api/now-playing', (req, res) => { const song = nowPlayingConMezcla(); res.json(song ? { ...song, position: lastProgress.position } : null); });

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
          primeNextAutoDJ();   // dejar lista la siguiente sin depender del cliente
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
    else if (db.getAutoDJEnabled()) primeNextAutoDJ();   // la cola se agota: releva AutoDJ
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
    // Un skip a mano lo puede pedir cualquier admin — tambien RemoteView, que
    // es un mando a distancia legitimo y no reproduce. Lo que NO se acepta de
    // otro dispositivo es el avance AUTOMATICO de una mezcla: ahi es donde una
    // pestaña zombi hace daño (dos avances a la vez = cancion saltada).
    if (!(req.body && req.body.porMezcla)) marcarActividad('skip del DJ');
    if (req.body && req.body.porMezcla) {
      const actual = mandoVivo();
      if (actual && actual.deviceId !== req.headers['x-device-id']) {
        slog('mando:rechazado', { ruta: 'player/next' });
        return res.status(409).json({ error: 'Otro dispositivo tiene el control' });
      }
    }
    const song = await advanceQueue();
    res.json({ song: conIntro(song) });
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

// Log de diagnóstico de la sesión activa (solo admin). OJO: tiene que quedar por
// ENCIMA del catch-all de abajo — Express casa por orden de registro, y estando
// declarado después este endpoint devolvía siempre index.html en vez del log.
app.get('/api/admin/log', auth.adminMiddleware, (req, res) => {
  res.json(sessionLog);
});

// Interruptor del crossfade de servidor (ver serverCrossfadeEnabled)
app.post('/api/player/server-crossfade', auth.adminMiddleware, (req, res) => {
  const { enabled } = req.body || {};
  db.setSetting('crossfade_server', enabled ? '1' : '0');
  if (!enabled) { bcastBridge = null; bcastAfterBridge = null; }
  slog('broadcast:serverCrossfade', { enabled: !!enabled });
  res.json({ success: true, enabled: !!enabled });
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
  emitirTiempos(endsAtMs);
}

// Los dos vencimientos juntos: la hora fija de fin (si la hay) y el momento en
// que caducaria por inactividad. El cliente pinta el mas cercano.
function emitirTiempos(endsAtMs) {
  const guardado = db.getSetting('session_end_time');
  io.emit('session:timer', {
    endsAt: endsAtMs !== undefined ? endsAtMs : (guardado ? parseInt(guardado) : null),
    inactivoHasta: finPorInactividad(),
    inactividadMin: inactividadMin(),
    iniciadaEn: db.getSessionActive() ? sessionStartTime : null,
  });
}

// ── Cierre por inactividad ───────────────────────────────────────────────────
// Distinto de la duracion fija: aquella corta a una hora concreta ("la fiesta
// acaba a las 2:00"), esta cierra lo que se ha quedado olvidado. El caso real
// que la motiva: una sesion abierta 6,5 h y 97 canciones sin que nadie la
// escuchara, con 96 de los 97 avances pedidos por el temporizador de seguridad.
const AVISO_MIN = 15;              // aviso al admin cuando quedan estos minutos
let ultimaActividad = 0;
let avisoInactividadDado = false;

const inactividadMin = () => parseInt(db.getSetting('session_inactividad_min') || '120', 10);

// ⚠️ Llamar SOLO desde acciones humanas (votar, añadir, chat, entrar, tocar el
// panel) y desde un mando vivo reproduciendo. NUNCA desde `advanceQueue`, el
// puente ni AutoDJ: si el motor avanzando canciones contase como actividad, la
// sesion olvidada no caducaria jamas y esto no serviria para nada.
function marcarActividad(que) {
  ultimaActividad = Date.now();
  if (avisoInactividadDado) {
    avisoInactividadDado = false;
    io.emit('session:aviso', { minutos: null });   // retirar el aviso
    slog('inactividad:revive', { por: que });
  }
}

function revisarInactividad() {
  if (!db.getSessionActive()) return;
  const min = inactividadMin();
  if (!min || min <= 0) return;                     // desactivado
  if (!ultimaActividad) ultimaActividad = Date.now();
  const restanMs = min * 60000 - (Date.now() - ultimaActividad);
  if (restanMs <= 0) {
    slog('inactividad:cierra', { min });
    autoEndSession();
    return;
  }
  emitirTiempos();   // refrescar el contador de la pantalla una vez por minuto
  if (restanMs <= AVISO_MIN * 60000 && !avisoInactividadDado) {
    avisoInactividadDado = true;
    slog('inactividad:aviso', { min: Math.ceil(restanMs / 60000) });
    io.emit('session:aviso', { minutos: Math.ceil(restanMs / 60000) });
  }
}
// Cada 20 s, no cada minuto: con 60 s el cierre se iba hasta un minuto tarde y
// el aviso de los 15 min caia con la misma imprecision.
setInterval(revisarInactividad, 20000);

// Cuanto queda por inactividad, para que el cliente pinte el contador.
const finPorInactividad = () => {
  const min = inactividadMin();
  if (!min || min <= 0 || !ultimaActividad) return null;
  return ultimaActividad + min * 60000;
};

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
  ultimoProgresoAt    = 0;                // nadie dirige hasta que alguien reporte
  ultimaActividad     = Date.now();       // el reloj de inactividad empieza ahora
  avisoInactividadDado = false;
  // ⚠️ El mando NO se toca aqui. `resetRuntimeState` corre al iniciar la fiesta,
  // y el DJ acaba de coger el mando al abrir el panel: borrarlo le dejaria sin
  // control justo despues de pulsar "Iniciar", y otro dispositivo podria cogerlo
  // sin que saliera ningun aviso. El mando va con el dispositivo, no con la
  // fiesta, y solo caduca por falta de latido.
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


io.on('connection', socket => {
  socket.emit('queue:update',   db.getQueue().map(conIntro));
  socket.emit('player:update',  nowPlayingConMezcla());
  socket.emit('session:update', { active: db.getSessionActive(), name: db.getSessionName(), desc: db.getSessionDesc() });
  socket.emit('autodj:update',  { enabled: db.getAutoDJEnabled(), active: autoDJActive });
  const storedEnd = db.getSetting('session_end_time');
  socket.emit('session:timer',  { endsAt: storedEnd ? parseInt(storedEnd) : null,
                                  inactivoHasta: finPorInactividad(),
                                  inactividadMin: inactividadMin(),
                                  iniciadaEn: db.getSessionActive() ? sessionStartTime : null });
  // Send current online list to this socket
  const list = [...onlineUsers.values()];
  socket.emit('users:online', { count: list.length, users: list });

  const m0 = mandoVivo();
  socket.emit('control:estado', m0 ? { ocupado: true, nombre: m0.nombre, desde: m0.desde }
                                   : { ocupado: false });

  socket.on('user:join', ({ username, role }) => {
    onlineUsers.set(socket.id, { username, role });
    marcarActividad('entra ' + (username || '?'));
    broadcastOnline();
  });

  // ── El mando ───────────────────────────────────────────────────────────────
  // `pedir` no arrebata nunca: si esta ocupado devuelve por quien, y es el panel
  // el que pregunta al DJ si quiere tomarlo. `tomar` si arrebata.
  socket.on('control:pedir', ({ deviceId, nombre, username } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (!deviceId) return cb({ ok: false });
    const actual = mandoVivo();
    if (actual && actual.deviceId !== deviceId)
      return cb({ ok: false, ocupado: { nombre: actual.nombre, desde: actual.desde } });
    darMando(socket, { deviceId, nombre, username });
    cb({ ok: true });
  });

  socket.on('control:tomar', ({ deviceId, nombre, username } = {}, cb) => {
    if (!deviceId) return typeof cb === 'function' && cb({ ok: false });
    darMando(socket, { deviceId, nombre, username });
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('control:latido', ({ deviceId } = {}) => {
    if (tieneMando(deviceId)) { mando.latido = Date.now(); mando.socketId = socket.id; }
  });

  socket.on('control:soltar', ({ deviceId } = {}) => {
    if (tieneMando(deviceId)) soltarMando('lo ha soltado el dispositivo');
  });

  socket.on('user:leave', () => {
    onlineUsers.delete(socket.id);
    broadcastOnline();
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    chatRateLimit.delete(socket.id);
    // Si se cae quien tenia el mando, NO se libera al instante: en el movil el
    // socket se cae al bloquear la pantalla y volveria a pedirlo al reconectar.
    // Se deja caducar por falta de latido (MANDO_TTL_MS).
    broadcastOnline();
  });

  // Remote control: relay commands to player and state back to remote
  socket.on('player:cmd',   cmd  => socket.broadcast.emit('player:cmd', cmd));
  socket.on('player:state', data => socket.broadcast.emit('player:state', data));

  socket.on('player:progress', data => {
    // Solo la posicion del dispositivo al mando. Antes la escribia cualquiera:
    // un movil con el JS viejo en cache corrompia la posicion de toda la sesion.
    const alMando = mandoVivo();
    if (alMando && alMando.deviceId !== (data && data.deviceId)) return;
    lastProgress = data || { position: 0 };
    ultimoProgresoAt = Date.now();   // hay un reproductor vivo dirigiendo
    // Un mando vivo REPRODUCIENDO cuenta como actividad: el caso mas comun es
    // el admin que engancha el altavoz y la gente baila sin tocar el movil, con
    // cero interacciones durante horas. Sin esto la fiesta se cerraria sola en
    // mitad del baile. Ojo: que AutoDJ avance canciones NO cuenta (ver
    // marcarActividad) — esa es justo la sesion olvidada que se quiere cerrar.
    if (alMando) marcarActividad('reproduciendo');
    // Reanudacion tras reiniciar el servicio a mitad de cancion. startBroadcast
    // solo se llamaba al AVANZAR de tema, asi que los oyentes de /api/live se
    // quedaban mudos hasta el siguiente cambio — con una cancion larga, minutos.
    // El reproductor reporta su posicion cada poco, asi que la usamos para
    // retomar la emision justo donde va la sala.
    if (!bcastSource && db.getSessionActive() && data && data.position > 1) {
      const np = db.getNowPlaying();
      if (np && np.id) {
        slog('broadcast:resume', { id: np.id.slice(0, 8), pos: Math.round(data.position) });
        startBroadcast(np.id, np.duration || 0, data.position);
      }
    }
    socket.broadcast.emit('player:progress', data);
  });

  // Avance automático desde PlayerView — sin auth, el servidor valida que haya sesión activa
  socket.on('player:auto-next', async (datos, cb) => {
    if (typeof cb !== 'function') return;
    // El avance automatico SOLO lo pide quien tiene el mando. Con dos paneles
    // abiertos, los dos lo piden en el mismo instante y se salta una cancion.
    const actual = mandoVivo();
    if (actual && actual.deviceId !== (datos && datos.deviceId)) {
      slog('mando:rechazado', { ruta: 'player:auto-next' });
      return cb({ song: null });
    }
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
        return cb({ song: conIntro(queue[0]) });
      }
      if (!db.getAutoDJEnabled()) return cb({ song: null });
      if (!pendingAutoDJ) pendingAutoDJ = await pickAutoDJSong();
      if (pendingAutoDJ) prefetchBroadcast(pendingAutoDJ.id, pendingAutoDJ.duration || 0);
      cb({ song: conIntro(pendingAutoDJ) });
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

  // El solapamiento es fijo: se manda solo para que el cliente lo muestre.
  socket.emit('player:silence-config', { overlapSec: OVERLAP_SEC });

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
  // Recuperar cuando empezo la fiesta. `sessionStartTime` solo se fija al ABRIR
  // una, asi que tras reiniciar el servicio con una fiesta ya en marcha se
  // quedaba en 0 y el reloj de la cabecera no pintaba nada.
  sessionStartTime = parseInt(db.getSetting('session_started_at') || '0', 10) || Date.now();
  ultimaActividad  = Date.now();
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('TuriaDJ on port', PORT, '| bcrypt:', auth.bcryptImpl));
