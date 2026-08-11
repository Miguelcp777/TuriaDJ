import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Music, SkipForward, Volume2, Play, Pause } from 'lucide-react';

const socket = io({ transports: ['websocket'] });

const CROSSFADE_MS      = 4000;   // duración por defecto — configurable desde RemoteView
const CROSSFADE_TICK    = 50;
const SILENCE_THRESHOLD = 0.02;   // valor por defecto — puede sobreescribirse desde RemoteView
const SILENCE_SECONDS   = 1;      // segundos de silencio antes de avance inmediato
const SILENCE_WINDOW    = 60;
const PRELOAD_WINDOW    = 90;     // segundos antes del final donde se precarga la siguiente

// Fetch autenticado — lee el JWT del mismo localStorage que el admin panel
const jwtFetch = (url, opts = {}) => {
  const token = localStorage.getItem('jv_auth') || '';
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token },
  });
};

// Envía un evento de diagnóstico al servidor (registrado en sessionLog)
const clog = (event, data = {}) => {
  try { socket.emit('client:log', { event, data }); } catch {}
};

function fmtDur(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

export default function PlayerView() {
  const [nowPlaying, setNowPlaying]   = useState(null);
  const [queue, setQueue]             = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]       = useState(0);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [needsTap, setNeedsTap]       = useState(false);

  const audioA = useRef(null);
  const audioB = useRef(null);
  const activeRef      = useRef('A');
  const queueRef       = useRef([]);
  const advancingRef      = useRef(false);
  const advancingStartRef = useRef(0);    // timestamp del inicio del avance actual
  const playingSrcRef  = useRef('');
  const targetVolRef   = useRef(1);
  const crossfadeTimer  = useRef(null);
  const crossfadeMsRef  = useRef(CROSSFADE_MS); // duración del crossfade — configurable
  const preloadedRef    = useRef('');            // PV-002: ID de canción precargada en elemento inactivo
  const peekInFlight    = useRef(false);          // evita múltiples peek-next simultáneos
  // Web Audio
  const audioCtxRef  = useRef(null);
  const analyserRef  = useRef(null);
  const silenceTimer = useRef(null);
  const silenceStart = useRef(null);
  // PV-003: umbrales configurables desde RemoteView vía player:cmd
  const silenceThresholdRef = useRef(SILENCE_THRESHOLD);
  const silenceSecondsRef   = useRef(SILENCE_SECONDS);
  // Segundo de la canción en el que debe entrar la siguiente. Lo calcula el
  // servidor mirando cómo acaba (final seco, silencio de cola o fundido) y llega
  // con la canción. Mientras no llegue vale null y se usa el margen de siempre.
  const mixStartRef = useRef(null);

  useEffect(() => {
    mixStartRef.current = nowPlaying?.mixStartMs ? nowPlaying.mixStartMs / 1000 : null;
    if (nowPlaying?.overlapSec > 0) crossfadeMsRef.current = nowPlaying.overlapSec * 1000;
  }, [nowPlaying]);

  const getActive   = () => activeRef.current === 'A' ? audioA.current : audioB.current;
  const getInactive = () => activeRef.current === 'A' ? audioB.current : audioA.current;
  const updateQueue = q => { setQueue(q); queueRef.current = q; };

  // ── PV-001: Media Session API ────────────────────────────────────────────
  const updateMediaSession = (song) => {
    if (!('mediaSession' in navigator) || !song) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  song.title  || 'Desconocido',
      artist: song.artist || '',
      album:  song.album  || '',
      artwork: song.cover_art_id
        ? [{ src: window.location.origin + '/api/cover/' + song.cover_art_id, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
    navigator.mediaSession.playbackState = 'playing';
  };

  const clearMediaSession = () => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  };

  // ── Web Audio API ────────────────────────────────────────────────────────
  const ensureAnalyser = () => {
    if (analyserRef.current || !audioA.current || !audioB.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      ctx.createMediaElementSource(audioA.current).connect(analyser);
      ctx.createMediaElementSource(audioB.current).connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    } catch { /* Web Audio no disponible */ }
  };

  // ── Detección de silencio ────────────────────────────────────────────────
  const stopSilenceMonitor = () => {
    if (silenceTimer.current) { clearInterval(silenceTimer.current); silenceTimer.current = null; }
    silenceStart.current = null;
  };

  const startSilenceMonitor = () => {
    if (silenceTimer.current) return;
    silenceTimer.current = setInterval(() => {
      const active = getActive();
      if (!analyserRef.current || !active || active.paused) return;

      // PV-004: recuperar AudioContext suspendido (iOS lo suspende agresivamente en background)
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
        return; // skip tick, reintentar en el siguiente
      }
      if (audioCtxRef.current?.state !== 'running') return;

      const buf = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);

      if (rms < silenceThresholdRef.current) {
        if (!silenceStart.current) silenceStart.current = Date.now();
        else if (Date.now() - silenceStart.current >= silenceSecondsRef.current * 1000) {
          clog('silence:detected', { rms: rms.toFixed(3) });
          stopSilenceMonitor();
          handleEnded(false, true); // silencio detectado → switch inmediato
        }
      } else {
        silenceStart.current = null;
      }
    }, 200);
  };

  // Muchas canciones empiezan con silencio (medido sobre la biblioteca: 7 de cada
  // 20, y la peor con 7,9 s). Si la entrante arranca en su segundo 0, el solape
  // cae sobre la nada. El servidor mide ese silencio y lo manda en `introMs`.
  const saltarIntro = (el, song) => {
    const intro = ((song && song.introMs) || 0) / 1000;
    if (!el || intro <= 0.3) return;
    const poner = () => { try { el.currentTime = intro; } catch (e) {} };
    if (el.readyState >= 1) poner();
    else el.addEventListener('loadedmetadata', poner, { once: true });
  };

  // ── PV-002: precarga de la siguiente canción ─────────────────────────────
  // Carga el audio de `song` en el elemento INACTIVO y lo marca como precargado.
  const doPreload = (song) => {
    if (!song) return;
    const inactive = getInactive();
    if (!inactive) return;
    inactive.src     = '/api/stream/' + song.id;
    inactive.preload = 'auto';
    inactive.load();
    saltarIntro(inactive, song);
    preloadedRef.current = song.id;
  };

  const preloadNext = () => {
    if (preloadedRef.current || advancingRef.current || crossfadeTimer.current) return;
    // Caso cola: la siguiente es conocida en el cliente → precargar ya.
    const q = queueRef.current;
    if (q && q.length > 0) { doPreload(q[0]); return; }
    // Caso AutoDJ (cola vacía): la siguiente la decide el servidor. Le pedimos
    // qué sonará (peek-next, NO avanza) y la precargamos. Esto es CLAVE para que
    // el crossfade solape de verdad en AutoDJ: sin esto, la canción se cargaría
    // recién en el pre-trigger (5s antes del final) y no daría tiempo a bufear.
    if (peekInFlight.current) return;
    peekInFlight.current = true;
    socket.emit('player:peek-next', {}, (data) => {
      peekInFlight.current = false;
      const s = data && data.song;
      if (s && !preloadedRef.current && !advancingRef.current && !crossfadeTimer.current) {
        doPreload(s);
      }
    });
  };

  const resetPreload = () => {
    const inactive = getInactive();
    if (inactive && preloadedRef.current) { inactive.src = ''; }
    preloadedRef.current = '';
  };

  // ── Crossfade (A→B o B→A) ───────────────────────────────────────────────
  const stopCrossfade = () => {
    if (crossfadeTimer.current) { clearInterval(crossfadeTimer.current); crossfadeTimer.current = null; }
  };

  const doCrossfade = (song) => {
    const current = getActive();
    const next    = getInactive();
    if (!current || !next) { advancingRef.current = false; return; }

    clog('crossfade:start', { song: (song.title || '').slice(0, 30), ms: crossfadeMsRef.current, preloaded: preloadedRef.current === song.id });
    const newSrc = '/api/stream/' + song.id;
    playingSrcRef.current = newSrc;

    // PV-002: si la canción coincide con la precargada, el buffer ya tiene datos
    if (preloadedRef.current !== song.id) {
      next.src = newSrc;
      next.load();
      saltarIntro(next, song);
    }
    preloadedRef.current = '';
    next.volume = 0;

    const beginFade = () => {
      updateMediaSession(song);
      setNowPlaying(song);
      setIsPlaying(true);
      setNeedsTap(false);
      const vol = targetVolRef.current;
      let step = 0;
      const totalSteps = crossfadeMsRef.current / CROSSFADE_TICK;
      console.log(`[crossfade] START ${crossfadeMsRef.current}ms (${totalSteps} steps) → "${song.title}"`);

      crossfadeTimer.current = setInterval(() => {
        step++;
        const t = Math.min(1, step / totalSteps);
        current.volume = (1 - t) * vol;
        next.volume    = t * vol;
        // Log every ~500ms (10 ticks)
        if (step % 10 === 0 || step === totalSteps) {
          console.log(`[crossfade] step ${step}/${totalSteps}  out=${current.volume.toFixed(2)}  in=${next.volume.toFixed(2)}`);
        }
        if (step >= totalSteps) {
          stopCrossfade();
          activeRef.current = activeRef.current === 'A' ? 'B' : 'A';
          current.pause();
          current.src    = '';
          current.volume = vol;
          advancingRef.current = false;
          clog('crossfade:done', { song: (song.title || '').slice(0, 30) });
          console.log(`[crossfade] DONE → active is now ${activeRef.current}`);
        }
      }, CROSSFADE_TICK);
    };

    // `started` garantiza que next.play() se invoque UNA sola vez. Sin esto, si
    // canplay dispara startPlay y next.play() tarda en resolver, el fallback de
    // 1.5s podría llamar startPlay de nuevo → dos setInterval de crossfade
    // compitiendo (uno se filtra y nunca se limpia), dejando el audio roto.
    let started = false;
    const startPlay = () => {
      if (started) return;
      started = true;
      next.play().then(beginFade).catch(() => {
        next.src = '';
        next.volume = targetVolRef.current;
        preloadedRef.current = '';
        stopCrossfade();
        doImmediateSwitch(song);
      });
    };

    // Esperar a que esté listo para reproducir (HAVE_FUTURE_DATA = 3).
    // Si no esperamos, los primeros segundos del crossfade pueden ser silencio
    // mientras el navegador buferea la nueva canción.
    if (next.readyState >= 3) {
      startPlay();
    } else {
      const onCanPlay = () => { next.removeEventListener('canplay', onCanPlay); startPlay(); };
      next.addEventListener('canplay', onCanPlay, { once: true });
      // Fallback a 1.5s — empezar igual aunque el buffer no esté completo
      setTimeout(() => {
        if (!started && advancingRef.current) {
          next.removeEventListener('canplay', onCanPlay);
          startPlay();
        }
      }, 1500);
    }
  };

  // ── Switch inmediato (skip / silencio / song ya terminada) ────────────────
  const doImmediateSwitch = (song) => {
    const src = '/api/stream/' + song.id;
    clog('immediateSwitch', { song: (song.title || '').slice(0, 30), preloaded: preloadedRef.current === song.id });

    // Si la canción ya está PRECARGADA en el elemento inactivo, cambiamos a él
    // (flip de activeRef) sin recargar → switch instantáneo SIN hueco. Esto hace
    // que el cambio por silencio y el skip sean gapless cuando hay preload.
    const inactive = getInactive();
    if (inactive && preloadedRef.current === song.id && inactive.readyState >= 2) {
      const current = getActive();
      playingSrcRef.current = src;
      preloadedRef.current = '';
      inactive.volume = targetVolRef.current;
      updateMediaSession(song);
      setNowPlaying(song);
      inactive.play()
        .then(() => {
          activeRef.current = activeRef.current === 'A' ? 'B' : 'A';
          if (current) { current.pause(); current.src = ''; current.volume = targetVolRef.current; }
          setIsPlaying(true); setNeedsTap(false); advancingRef.current = false;
        })
        .catch(() => { setNeedsTap(true); advancingRef.current = false; });
      return;
    }

    // Sin preload: recargar en el elemento activo.
    const active = getActive();
    if (!active) { advancingRef.current = false; return; }
    playingSrcRef.current = src;
    active.volume = targetVolRef.current;
    active.src = src;
    saltarIntro(active, song);
    updateMediaSession(song);   // PV-001
    setNowPlaying(song);
    setIsPlaying(false);
    active.play()
      .then(() => { setIsPlaying(true); setNeedsTap(false); advancingRef.current = false; })
      .catch(() => { setNeedsTap(true); advancingRef.current = false; });
  };

  // ── Sincronización servidor → cliente ──────────────────────────────────────
  // Consulta /api/now-playing y, si el src del audio activo no coincide con la
  // canción que el servidor cree que está sonando, hace un switch inmediato.
  // Se usa para recuperar el estado en tres casos:
  //   1. Al volver del background (visibilitychange)
  //   2. Al reconectar el socket
  //   3. Cuando un avance automático no recibe respuesta del servidor (ack de
  //      socket perdido): el servidor YA avanzó pero el cliente no se enteró.
  const syncWithServer = (reason = '') => {
    clog('sync:call', { reason });
    fetch('/api/now-playing').then(r => r.json()).then(song => {
      if (!song) { setNowPlaying(null); return; }
      const desiredSrc = '/api/stream/' + song.id;
      if (playingSrcRef.current !== desiredSrc) {
        clog('sync:switch', { reason, song: (song.title || '').slice(0, 30) });
        console.log('[PlayerView] sync: ' + playingSrcRef.current + ' → ' + desiredSrc);
        stopCrossfade();
        advancingRef.current = false;
        doImmediateSwitch(song);
      } else {
        // Mismo src: solo asegurar que está sonando
        const active = getActive();
        if (active?.paused && active?.src) {
          clog('sync:resume', { reason });
          active.play()
            .then(() => { setIsPlaying(true); setNeedsTap(false); })
            .catch(() => { setNeedsTap(true); });
        }
      }
    }).catch(() => {});
  };

  // ── handleEnded ──────────────────────────────────────────────────────────
  // fromSkip    = true  → switch inmediato (el DJ pulsó "siguiente")
  // fromSilence = true  → switch inmediato (silencio detectado > 1s en la pista)
  // ambos false         → crossfade completo (fin natural por tiempo)
  //
  // El avance automático usa socket.emit con acknowledgment para evitar
  // depender de auth HTTP — PlayerView puede estar abierto sin sesión de admin.
  const handleEnded = (fromSkip = false, fromSilence = false) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    advancingStartRef.current = Date.now();
    clog('handleEnded', { skip: fromSkip, silence: fromSilence });
    stopSilenceMonitor();
    setIsPlaying(false);

    // `settled` evita que un ACK tardío y el guard se procesen ambos.
    let settled = false;

    const onSong = (song) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (song) {
        if (fromSkip || fromSilence) { resetPreload(); doImmediateSwitch(song); }
        else                           doCrossfade(song);
      } else {
        clearMediaSession();
        setNowPlaying(null);
        setIsPlaying(false);
        advancingRef.current = false;
      }
    };

    // Guard de recuperación: si la respuesta (ACK de socket o HTTP) no llega en
    // 6s, el servidor probablemente YA avanzó la cola — su broadcast
    // `player:update` fue ignorado por el mutex, o el ACK del socket se perdió
    // (típico con wifi saturado). En lugar de solo liberar el mutex y quedarnos
    // esperando un evento que quizá no llegue, recuperamos ACTIVAMENTE el estado
    // consultando /api/now-playing. Sin esto, si el ACK se pierde justo cuando
    // la canción termina, el reproductor se queda parado hasta que el usuario
    // interactúa con la app.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn('[PlayerView] avance sin respuesta en 6s — recuperando vía servidor');
      clog('guard:timeout', { fromSkip, fromSilence });
      advancingRef.current = false;
      syncWithServer('guard');
    }, 6000);

    if (fromSkip) {
      // Skip: usa HTTP con auth (acción admin)
      jwtFetch('/api/player/next', { method: 'POST' })
        .then(r => r.json())
        .then(data => onSong(data?.song ?? null))
        .catch(() => {
          if (settled) return;
          settled = true; clearTimeout(guard);
          clog('skip:error');
          advancingRef.current = false; syncWithServer('skip-fail');
        });
    } else {
      // Fin natural: socket acknowledgment sin necesidad de auth
      socket.emit('player:auto-next', {}, (data) => {
        onSong(data?.song ?? null);
      });
    }
  };

  // ── Sockets + carga inicial + PV-001 MediaSession setup ─────────────────
  useEffect(() => {
    // PV-001: registrar action handlers de Media Session
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play',      () => { getActive()?.play(); });
      navigator.mediaSession.setActionHandler('pause',     () => { getActive()?.pause(); });
      navigator.mediaSession.setActionHandler('stop',      () => { getActive()?.pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', () => handleSkip());
    }

    socket.on('queue:update', updateQueue);

    socket.on('player:update', song => {
      // ── Race-condition guard ──────────────────────────────────────────────
      // Cuando PlayerView mismo inicia la transición (handleEnded), el servidor
      // emite player:update vía broadcast ANTES de que llegue la respuesta HTTP.
      // Si procesamos ese evento, stopCrossfade() + active.src = X reinician la
      // canción desde el principio y corrompen el crossfade.
      //
      // PERO si advancingRef lleva > 3 segundos sin liberarse (porque el socket
      // se desconectó en background y el callback de auto-next nunca llegó),
      // dejamos pasar el update para que el cliente se sincronice cuando vuelve
      // del background. Sin esto, el src nunca se actualiza hasta que el usuario
      // toca la pantalla.
      const advancingMs = advancingRef.current ? Date.now() - advancingStartRef.current : 0;
      if (advancingRef.current && advancingMs < 3000) return;
      if (advancingRef.current && advancingMs >= 3000) {
        console.warn('[PlayerView] advancingRef stuck for', advancingMs, 'ms — releasing for player:update');
        clog('advancing:stuck', { ms: advancingMs });
        advancingRef.current = false;
      }

      const newSrc = song ? '/api/stream/' + song.id : '';
      // Si ya estamos en crossfade hacia esta misma canción, solo actualizar UI
      if (crossfadeTimer.current && playingSrcRef.current === newSrc) {
        setNowPlaying(song);
        updateMediaSession(song);   // PV-001
        return;
      }
      stopSilenceMonitor();
      stopCrossfade();
      resetPreload();
      advancingRef.current = false;
      const inactive = getInactive();
      if (inactive) { inactive.pause(); inactive.src = ''; inactive.volume = targetVolRef.current; }
      if (song) {
        updateMediaSession(song);   // PV-001
      } else {
        clearMediaSession();        // PV-001
      }
      setNowPlaying(song);
      if (song) {
        const active = getActive();
        if (active && playingSrcRef.current !== newSrc) {
          playingSrcRef.current = newSrc;
          active.volume = targetVolRef.current;
          active.src = newSrc;
          saltarIntro(active, song);
          // Resumir AudioContext antes de intentar play (puede estar suspendido en background)
          const doPlay = () => active.play()
            .then(() => { setIsPlaying(true); setNeedsTap(false); })
            .catch(() => { setNeedsTap(true); }); // overlay para que el usuario toque
          if (audioCtxRef.current?.state === 'suspended') {
            audioCtxRef.current.resume().then(doPlay).catch(doPlay);
          } else {
            doPlay();
          }
        }
      }
    });

    socket.on('player:silence-config', ({ threshold, seconds, overlapSec }) => {
      if (threshold !== undefined) silenceThresholdRef.current = threshold;
      if (seconds   !== undefined) silenceSecondsRef.current   = seconds;
      if (overlapSec > 0)          crossfadeMsRef.current      = overlapSec * 1000;
    });

    socket.on('player:crossfade-config', ({ ms }) => {
      if (ms && ms > 0) crossfadeMsRef.current = ms;
    });

    socket.on('player:cmd', ({ action, value }) => {
      const active = getActive();
      if (action === 'play' && active) {
        active.play().then(() => { setIsPlaying(true); setNeedsTap(false); }).catch(() => {});
      } else if (action === 'pause' && active) {
        active.pause(); setIsPlaying(false);
      } else if (action === 'volume' && value !== undefined) {
        targetVolRef.current = value;
        if (!crossfadeTimer.current) {
          if (audioA.current) audioA.current.volume = value;
          if (audioB.current) audioB.current.volume = value;
        }
      } else if (action === 'next') {
        handleSkip();
      } else if (action === 'silence-threshold' && value !== undefined) {
        // PV-003: umbral de silencio configurable desde RemoteView
        silenceThresholdRef.current = value;
      } else if (action === 'silence-seconds' && value !== undefined) {
        // PV-003: duración de silencio configurable desde RemoteView
        silenceSecondsRef.current = value;
      }
    });

    const onVisibility = () => {
      if (!document.hidden) {
        clog('visibility:foreground');
        // PV-004: recuperar AudioContext suspendido
        const resumeCtx = audioCtxRef.current?.state === 'suspended'
          ? audioCtxRef.current.resume().catch(() => {})
          : Promise.resolve();

        resumeCtx.then(() => {
          const active = getActive();

          if (active?.ended) {
            // Canción terminó en background: el servidor ya ha avanzado,
            // sincronizar con /api/now-playing para no reintentar handleEnded
            // (que reproduciría la misma canción otra vez).
            advancingRef.current = false;
            syncWithServer('visibility-ended');

          } else if (active?.paused && active?.src && !advancingRef.current) {
            // Audio pausado: puede ser que el servidor cambió la canción O
            // que play() falló por autoplay policy. Sincronizar primero.
            syncWithServer('visibility-paused');
          } else {
            // Audio sonando: igual sincronizar por si el src ha cambiado
            // (el cliente podría llevar reproduciendo la canción anterior
            // varios segundos extra mientras el servidor ya avanzó).
            syncWithServer('visibility-playing');
          }
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Sincronizar también cuando el socket se reconecta (los browsers
    // móviles desconectan websockets en background y los reconectan al
    // volver). Sin esto, el cliente puede quedar con un estado obsoleto.
    socket.on('connect', () => {
      // Pequeño delay para que el servidor termine de procesar la reconexión
      setTimeout(() => syncWithServer('reconnect'), 200);
    });

    fetch('/api/now-playing').then(r => r.json()).then(song => {
      if (song) {
        setNowPlaying(song);
        updateMediaSession(song);   // PV-001
        const active = getActive();
        if (active) {
          const src = '/api/stream/' + song.id;
          playingSrcRef.current = src;
          active.src = src;
          saltarIntro(active, song);
        }
      }
    });
    jwtFetch('/api/queue').then(r => r.json()).then(updateQueue);

    return () => {
      socket.off('queue:update');
      socket.off('player:update');
      socket.off('player:cmd');
      socket.off('player:silence-config');
      socket.off('player:crossfade-config');
      socket.off('connect');
      document.removeEventListener('visibilitychange', onVisibility);
      stopSilenceMonitor();
      stopCrossfade();
      // PV-001: limpiar action handlers
      if ('mediaSession' in navigator) {
        ['play', 'pause', 'stop', 'nexttrack'].forEach(a => {
          try { navigator.mediaSession.setActionHandler(a, null); } catch {}
        });
      }
    };
  }, []);

  // ── Handlers de audio ────────────────────────────────────────────────────
  const handleTimeUpdate = (e) => {
    if (e.target !== getActive()) return;
    const pos = e.target.currentTime;
    const dur = e.target.duration || 0;
    setCurrentTime(pos);
    setDuration(dur);
    socket.emit('player:progress', { position: pos, duration: dur });

    // PV-001: mantener posición de Media Session actualizada
    if ('mediaSession' in navigator && dur > 0) {
      try {
        navigator.mediaSession.setPositionState({ duration: dur, position: pos, playbackRate: 1 });
      } catch {}
    }

    if (dur > 0 && pos > dur * 0.5) {
      const remaining = dur - pos;
      // PV-002: precargar siguiente canción 90s antes del final
      if (remaining < PRELOAD_WINDOW && !preloadedRef.current) preloadNext();
      // Activar detección de silencio en los últimos 60s
      if (remaining < SILENCE_WINDOW) {
        if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
        startSilenceMonitor();
      }
      // Entrada de la siguiente canción. El servidor da el segundo exacto según
      // cómo acabe ésta; si aún no ha llegado ese dato, se usa el margen de
      // siempre (la duración del solape más un segundo antes del final).
      const entrada    = mixStartRef.current;
      const preTrigger = Math.ceil(crossfadeMsRef.current / 1000) + 1;
      const dispara    = entrada != null ? pos >= entrada : remaining <= preTrigger;
      if (dispara && remaining > 0 && !advancingRef.current && !crossfadeTimer.current) {
        clog('pretrigger', { rem: parseFloat(remaining.toFixed(1)), entra: entrada ? parseFloat(entrada.toFixed(1)) : null });
        console.log(`[crossfade] entra la siguiente en ${pos.toFixed(1)}s (previsto ${entrada != null ? entrada.toFixed(1) : 'sin dato'})`);
        handleEnded(false);
      }
    }
  };

  const handlePlay = (e) => {
    ensureAnalyser();
    audioCtxRef.current?.resume().catch(() => {});
    if (e.target !== getActive()) return;
    setIsPlaying(true);
    setNeedsTap(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';   // PV-001
    socket.emit('player:state', { playing: true });
  };

  const handlePause = (e) => {
    if (e.target !== getActive()) return;
    setIsPlaying(false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';    // PV-001
    socket.emit('player:state', { playing: false });
  };

  const handleAudioEnded = (e) => {
    if (e.target !== getActive()) return;
    // Si ya hay un avance en curso pero el crossfade NO ha empezado (el ACK del
    // servidor no llegó), la canción local acaba de terminar y no habrá más
    // eventos que disparen el avance → recuperamos vía servidor de inmediato.
    if (advancingRef.current) {
      if (!crossfadeTimer.current) {
        console.warn('[PlayerView] canción terminó sin avance confirmado — recuperando');
        clog('audioEnded:stuck');
        advancingRef.current = false;
        syncWithServer('audioEnded');
      }
      return;
    }
    clog('audioEnded');
    handleEnded(false);
  };

  const handleSkip = () => {
    stopSilenceMonitor();
    stopCrossfade();
    resetPreload();
    const inactive = getInactive();
    if (inactive) { inactive.pause(); inactive.src = ''; inactive.volume = targetVolRef.current; }
    const active = getActive();
    if (active) active.volume = targetVolRef.current;
    advancingRef.current = false; // liberar mutex antes de la llamada
    handleEnded(true); // fromSkip=true → switch inmediato
  };

  const togglePlay = () => {
    const active = getActive();
    if (!active || !nowPlaying) return;
    if (isPlaying) { active.pause(); setIsPlaying(false); }
    else {
      active.play()
        .then(() => { setIsPlaying(true); setNeedsTap(false); })
        .catch(() => {});
    }
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const coverBg = nowPlaying ? 'url(/api/cover/' + nowPlaying.cover_art_id + ')' : '';
  const sharedAudioProps = {
    onTimeUpdate: handleTimeUpdate,
    onPlay:       handlePlay,
    onPause:      handlePause,
    onEnded:      handleAudioEnded,
  };

  return (
    <div className="fixed inset-0 bg-[#07070f] overflow-hidden flex flex-col">
      {nowPlaying && (
        <div className="absolute inset-0 opacity-20 scale-110 blur-3xl"
          style={{ backgroundImage: coverBg, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-[#07070f]/40 via-transparent to-[#07070f]" />

      {needsTap && nowPlaying && !isPlaying && (
        <div
          onClick={togglePlay}
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 cursor-pointer"
        >
          <div className="flex flex-col items-center gap-4">
            <div className="w-28 h-28 bg-brand rounded-full flex items-center justify-center animate-pulse shadow-2xl shadow-brand/60">
              <Play size={52} className="text-white ml-1.5" />
            </div>
            <p className="text-white text-xl font-bold tracking-wide">Toca para continuar</p>
          </div>
        </div>
      )}

      <div className="relative z-10 flex flex-col h-full p-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-brand rounded-xl flex items-center justify-center">
              <Music size={18} className="text-white" />
            </div>
            <span className="font-extrabold text-xl tracking-tight">JukeVote</span>
          </div>
          <div className="flex items-center gap-2 text-gray-400">
            <Volume2 size={18} />
            <span className="text-sm">Player Mode</span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center gap-12">
          <div className="flex flex-col items-center">
            <div className="w-64 h-64 lg:w-80 lg:h-80 rounded-2xl overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/10 flex-shrink-0">
              {nowPlaying && nowPlaying.cover_art_id ? (
                <img src={'/api/cover/' + nowPlaying.cover_art_id} className="w-full h-full object-cover" alt="" />
              ) : (
                <div className="w-full h-full bg-gray-900 flex items-center justify-center">
                  <Music size={64} className="text-gray-700" />
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col justify-center min-w-0 max-w-sm">
            {nowPlaying ? (
              <>
                <p className="text-xs text-brand font-semibold uppercase tracking-widest mb-3">Now Playing</p>
                <h1 className="text-4xl font-extrabold leading-tight mb-2 text-white">{nowPlaying.title}</h1>
                <p className="text-xl text-gray-400 font-medium mb-1">{nowPlaying.artist}</p>
                <p className="text-gray-600 mb-8">{nowPlaying.album}</p>
                <div className="mb-2">
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden cursor-pointer"
                    onClick={e => {
                      if (!getActive() || !duration) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      getActive().currentTime = ((e.clientX - rect.left) / rect.width) * duration;
                    }}>
                    <div className="h-full bg-brand rounded-full transition-all duration-500" style={{ width: pct + '%' }} />
                  </div>
                  <div className="flex justify-between text-xs text-gray-600 mt-1">
                    <span>{fmtDur(currentTime)}</span>
                    <span>{fmtDur(duration)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-4">
                  <button onClick={togglePlay}
                    className="w-14 h-14 bg-brand hover:bg-brand-dark rounded-2xl flex items-center justify-center transition-all active:scale-95 shadow-lg shadow-brand/30">
                    {isPlaying ? <Pause size={24} className="text-white" /> : <Play size={24} className="text-white ml-0.5" />}
                  </button>
                  <button onClick={handleSkip}
                    className="w-12 h-12 bg-gray-800 hover:bg-gray-700 rounded-xl flex items-center justify-center transition-all active:scale-95 text-gray-400 hover:text-white">
                    <SkipForward size={20} />
                  </button>
                </div>
              </>
            ) : (
              <div className="text-center">
                <Music size={48} className="text-gray-700 mx-auto mb-4" />
                <p className="text-gray-500 text-lg font-medium">Waiting for songs</p>
                <p className="text-gray-700 text-sm mt-1">Open JukeVote on your phone and add a song</p>
              </div>
            )}
          </div>

          {queue.length > 0 && (
            <div className="hidden xl:flex flex-col gap-3 w-64 flex-shrink-0">
              <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mb-1">Up Next</p>
              {queue.slice(0, 4).map((s) => (
                <div key={s.id} className="flex items-center gap-3 bg-gray-900/50 rounded-xl p-2 border border-gray-800/30">
                  {s.cover_art_id
                    ? <img src={'/api/cover/' + s.cover_art_id} className="w-10 h-10 rounded-lg object-cover flex-shrink-0" alt="" />
                    : <div className="w-10 h-10 bg-gray-800 rounded-lg flex-shrink-0 flex items-center justify-center"><Music size={14} className="text-gray-600"/></div>
                  }
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.title}</p>
                    <p className="text-xs text-gray-500 truncate">{s.artist}</p>
                  </div>
                  <div className="flex items-center gap-1 text-brand flex-shrink-0">
                    <span className="text-xs font-bold">{s.votes}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <audio ref={audioA} {...sharedAudioProps} />
      <audio ref={audioB} {...sharedAudioProps} />
    </div>
  );
}
