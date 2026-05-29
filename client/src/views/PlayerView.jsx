import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Music, SkipForward, Volume2, Play, Pause } from 'lucide-react';

const socket = io({ transports: ['websocket'] });

const CROSSFADE_MS      = 4000;
const CROSSFADE_TICK    = 50;
const SILENCE_THRESHOLD = 0.02;   // valor por defecto — puede sobreescribirse desde RemoteView
const SILENCE_SECONDS   = 2;      // valor por defecto
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
  const advancingRef   = useRef(false);
  const playingSrcRef  = useRef('');
  const targetVolRef   = useRef(1);
  const crossfadeTimer = useRef(null);
  const preloadedRef   = useRef('');        // PV-002: ID de canción precargada en elemento inactivo
  // Web Audio
  const audioCtxRef  = useRef(null);
  const analyserRef  = useRef(null);
  const silenceTimer = useRef(null);
  const silenceStart = useRef(null);
  // PV-003: umbrales configurables desde RemoteView vía player:cmd
  const silenceThresholdRef = useRef(SILENCE_THRESHOLD);
  const silenceSecondsRef   = useRef(SILENCE_SECONDS);

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
          stopSilenceMonitor();
          handleEnded(false); // fin natural → crossfade
        }
      } else {
        silenceStart.current = null;
      }
    }, 200);
  };

  // ── PV-002: precarga de la siguiente canción ─────────────────────────────
  const preloadNext = () => {
    if (preloadedRef.current || advancingRef.current || crossfadeTimer.current) return;
    const nextSong = queueRef.current[0];
    if (!nextSong) return;
    const inactive = getInactive();
    if (!inactive) return;
    inactive.src     = '/api/stream/' + nextSong.id;
    inactive.preload = 'auto';
    preloadedRef.current = nextSong.id;
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

    const newSrc = '/api/stream/' + song.id;
    playingSrcRef.current = newSrc;

    // PV-002: si la canción coincide con la precargada, el buffer ya tiene datos
    if (preloadedRef.current !== song.id) {
      next.src = newSrc;
    }
    preloadedRef.current = '';
    next.volume = 0;

    next.play().then(() => {
      updateMediaSession(song);   // PV-001
      setNowPlaying(song);
      setIsPlaying(true);
      setNeedsTap(false);
      const vol = targetVolRef.current;
      let step = 0;
      const totalSteps = CROSSFADE_MS / CROSSFADE_TICK;

      crossfadeTimer.current = setInterval(() => {
        step++;
        const t = Math.min(1, step / totalSteps);
        current.volume = (1 - t) * vol;
        next.volume    = t * vol;

        if (step >= totalSteps) {
          stopCrossfade();
          activeRef.current = activeRef.current === 'A' ? 'B' : 'A';
          current.pause();
          current.src    = '';
          current.volume = vol;
          advancingRef.current = false;
        }
      }, CROSSFADE_TICK);

    }).catch(() => {
      // next.play() bloqueado por política de autoplay del navegador.
      // Limpiar el inactive y hacer switch en el elemento activo para que
      // togglePlay() funcione cuando el usuario toque la pantalla.
      next.src = '';
      next.volume = targetVolRef.current;
      preloadedRef.current = '';
      stopCrossfade();
      // Redirigir al switch inmediato en el elemento activo
      doImmediateSwitch(song);
    });
  };

  // ── Switch inmediato (skip / song ya terminada) ──────────────────────────
  const doImmediateSwitch = (song) => {
    const active = getActive();
    if (!active) { advancingRef.current = false; return; }
    const src = '/api/stream/' + song.id;
    playingSrcRef.current = src;
    active.volume = targetVolRef.current;
    active.src = src;
    updateMediaSession(song);   // PV-001
    setNowPlaying(song);
    setIsPlaying(false);
    active.play()
      .then(() => { setIsPlaying(true); setNeedsTap(false); advancingRef.current = false; })
      .catch(() => { setNeedsTap(true); advancingRef.current = false; });
  };

  // ── handleEnded ──────────────────────────────────────────────────────────
  // fromSkip = true  → switch inmediato (el usuario pulsó "siguiente")
  // fromSkip = false → crossfade 4s  (fin natural o silencio detectado)
  const handleEnded = async (fromSkip = false) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    stopSilenceMonitor();
    setIsPlaying(false);

    // Guard: si algo falla y el mutex queda bloqueado, liberarlo en 20s
    const guard = setTimeout(() => {
      if (advancingRef.current) {
        console.warn('[PlayerView] advance timeout — liberando mutex');
        advancingRef.current = false;
      }
    }, 20000);

    try {
      const r = await jwtFetch('/api/player/next', { method: 'POST' });
      const data = await r.json();
      clearTimeout(guard);
      const song = data?.song ?? null;
      if (song) {
        if (fromSkip) {
          // Skip del DJ → switch inmediato sin crossfade
          resetPreload();
          doImmediateSwitch(song);
        } else {
          // Fin natural o silencio → crossfade 4s
          doCrossfade(song);
        }
      } else {
        // Cola vacía, AutoDJ desactivado
        clearMediaSession();
        setNowPlaying(null);
        setIsPlaying(false);
        advancingRef.current = false;
      }
    } catch (err) {
      clearTimeout(guard);
      console.error('[PlayerView] handleEnded fetch error:', err);
      advancingRef.current = false;
      if (getActive()?.paused) setNeedsTap(true);
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
      // canción desde el principio y corrompen el crossfade. Lo ignoramos:
      // la respuesta HTTP de handleEnded gestionará la transición por completo.
      if (advancingRef.current) return;

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
      setNeedsTap(false);
      if (song) {
        const active = getActive();
        if (active && playingSrcRef.current !== newSrc) {
          playingSrcRef.current = newSrc;
          active.volume = targetVolRef.current;
          active.src = newSrc;
          active.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }
    });

    socket.on('player:silence-config', ({ threshold, seconds }) => {
      if (threshold !== undefined) silenceThresholdRef.current = threshold;
      if (seconds   !== undefined) silenceSecondsRef.current   = seconds;
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
        // PV-004: recuperar AudioContext al volver al primer plano
        if (audioCtxRef.current?.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
        if (getActive()?.ended) handleEnded(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    fetch('/api/now-playing').then(r => r.json()).then(song => {
      if (song) {
        setNowPlaying(song);
        updateMediaSession(song);   // PV-001
        const active = getActive();
        if (active) {
          const src = '/api/stream/' + song.id;
          playingSrcRef.current = src;
          active.src = src;
        }
      }
    });
    jwtFetch('/api/queue').then(r => r.json()).then(updateQueue);

    return () => {
      socket.off('queue:update');
      socket.off('player:update');
      socket.off('player:cmd');
      socket.off('player:silence-config');
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
