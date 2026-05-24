import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Play, Pause, SkipForward, Volume2, Music, LogOut, Radio, SlidersHorizontal, ChevronDown, ChevronUp } from 'lucide-react';

const socket = io({ transports: ['websocket'] });

function fmtDur(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function LoginForm({ onAuth }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [err, setErr]   = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    const data = await r.json();
    setBusy(false);
    if (!r.ok) { setErr(data.error || 'Error'); return; }
    if (data.user.role !== 'admin') { setErr('Solo administradores'); return; }
    localStorage.setItem('jv_auth', data.token);
    onAuth(data.token, data.user);
  };

  return (
    <div className="min-h-[100dvh] bg-[#07070f] flex items-center justify-center p-4">
      <div className="w-full max-w-xs">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
            <Radio size={20} className="text-white" />
          </div>
          <span className="font-extrabold text-xl tracking-tight text-white">Mando DJ</span>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            placeholder="Usuario" autoComplete="username"
            className="w-full bg-gray-900 border border-gray-700 focus:border-red-600 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none" />
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder="Contraseña" autoComplete="current-password"
            className="w-full bg-gray-900 border border-gray-700 focus:border-red-600 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none" />
          {err && <p className="text-red-400 text-xs text-center">{err}</p>}
          <button type="submit" disabled={busy}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all active:scale-95 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
            {busy ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function RemoteView() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('jv_auth') || null);
  const [user, setUser]           = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [nowPlaying, setNowPlaying]   = useState(null);
  const [queue, setQueue]             = useState([]);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [progress, setProgress]       = useState({ position: 0, duration: 0 });
  const [volume, setVolume]           = useState(100);
  const [silenceThreshold, setSilenceThreshold] = useState(0.02);
  const [silenceSeconds, setSilenceSeconds]     = useState(2);
  const [showSilence, setShowSilence]           = useState(false);
  const skipBusy = useRef(false);

  // Auth check
  useEffect(() => {
    if (!authToken) { setAuthLoading(false); return; }
    fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + authToken } })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        if (u && u.role === 'admin') setUser(u);
        else { setAuthToken(null); localStorage.removeItem('jv_auth'); }
        setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, []);

  // Socket listeners
  useEffect(() => {
    if (!user) return;
    socket.on('player:update',  song => { setNowPlaying(song); if (!song) setIsPlaying(false); });
    socket.on('queue:update',   setQueue);
    socket.on('player:progress', p => setProgress(p || { position: 0, duration: 0 }));
    socket.on('player:state',   ({ playing }) => setIsPlaying(playing));
    fetch('/api/now-playing').then(r => r.json()).then(s => { if (s) setNowPlaying(s); });
    fetch('/api/queue').then(r => r.json()).then(setQueue);
    return () => {
      socket.off('player:update'); socket.off('queue:update');
      socket.off('player:progress'); socket.off('player:state');
    };
  }, [user]);

  const authFetch = (url, opts = {}) => fetch(url, {
    ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers, Authorization: 'Bearer ' + authToken }
  });

  const cmd = (action, value) => {
    const payload = { action };
    if (value !== undefined) payload.value = value;
    socket.emit('player:cmd', payload);
  };

  const togglePlay = () => {
    const next = !isPlaying;
    setIsPlaying(next);
    cmd(next ? 'play' : 'pause');
  };

  const handleSkip = async () => {
    if (skipBusy.current) return;
    skipBusy.current = true;
    try {
      const r = await authFetch('/api/player/next', { method: 'POST' });
      const { song } = await r.json();
      if (!song) setNowPlaying(null);
    } finally { skipBusy.current = false; }
  };

  const handleVolume = v => {
    setVolume(v);
    cmd('volume', v / 100);
  };

  const handleSilenceThreshold = v => {
    setSilenceThreshold(v);
    cmd('silence-threshold', v);
  };

  const handleSilenceSeconds = v => {
    setSilenceSeconds(v);
    cmd('silence-seconds', v);
  };

  const handleAuth = (token, u) => { setAuthToken(token); setUser(u); };
  const logout = () => { localStorage.removeItem('jv_auth'); setAuthToken(null); setUser(null); };

  const pct = progress.duration > 0 ? Math.min(100, (progress.position / progress.duration) * 100) : 0;

  if (authLoading) return (
    <div className="min-h-[100dvh] bg-[#07070f] flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!user) return <LoginForm onAuth={handleAuth} />;

  return (
    <div className="min-h-[100dvh] bg-[#07070f] text-white flex flex-col max-w-sm mx-auto px-4 pt-6 select-none"
      style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom))' }}>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
            <Radio size={15} className="text-white" />
          </div>
          <span className="font-extrabold tracking-tight">Mando DJ</span>
        </div>
        <button onClick={logout} className="text-gray-500 hover:text-gray-300 transition-colors">
          <LogOut size={18} />
        </button>
      </div>

      {/* Now Playing */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-52 h-52 rounded-2xl overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/10 mb-5 flex-shrink-0">
          {nowPlaying?.cover_art_id ? (
            <img src={'/api/cover/' + nowPlaying.cover_art_id} className="w-full h-full object-cover" alt="" />
          ) : (
            <div className="w-full h-full bg-gray-900 flex items-center justify-center">
              <Music size={48} className="text-gray-700" />
            </div>
          )}
        </div>
        {nowPlaying ? (
          <div className="text-center w-full px-2">
            <p className="font-bold text-lg leading-tight truncate">{nowPlaying.title}</p>
            <p className="text-gray-400 text-sm mt-0.5 truncate">{nowPlaying.artist}</p>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-gray-500 font-medium">Sin reproducir</p>
          </div>
        )}
      </div>

      {/* Progress */}
      <div className="mb-6">
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-1">
          <div className="h-full bg-red-600 rounded-full transition-all duration-500" style={{ width: pct + '%' }} />
        </div>
        <div className="flex justify-between text-xs text-gray-600">
          <span>{fmtDur(progress.position)}</span>
          <span>{fmtDur(progress.duration || nowPlaying?.duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6 mb-8">
        <button onClick={togglePlay} disabled={!nowPlaying}
          className="w-16 h-16 rounded-2xl flex items-center justify-center transition-all active:scale-90 disabled:opacity-30 shadow-lg"
          style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)', boxShadow: '0 4px 24px rgba(220,38,38,0.4)' }}>
          {isPlaying ? <Pause size={28} className="text-white" /> : <Play size={28} className="text-white ml-1" />}
        </button>
        <button onClick={handleSkip}
          className="w-13 h-13 w-14 h-14 bg-gray-800 hover:bg-gray-700 rounded-xl flex items-center justify-center transition-all active:scale-90 text-gray-300 hover:text-white">
          <SkipForward size={22} />
        </button>
      </div>

      {/* Volume */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <Volume2 size={16} className="text-gray-500 flex-shrink-0" />
          <input type="range" min={0} max={100} value={volume}
            onChange={e => handleVolume(Number(e.target.value))}
            className="flex-1 accent-red-600 h-1.5 rounded-full cursor-pointer" />
          <span className="text-xs text-gray-500 w-7 text-right">{volume}</span>
        </div>
      </div>

      {/* Silence config — PV-003 */}
      <div className="mb-6">
        <button
          onClick={() => setShowSilence(v => !v)}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-300 transition-colors w-full"
        >
          <SlidersHorizontal size={14} />
          <span className="text-xs font-semibold uppercase tracking-widest">Detección de silencio</span>
          {showSilence ? <ChevronUp size={14} className="ml-auto" /> : <ChevronDown size={14} className="ml-auto" />}
        </button>

        {showSilence && (
          <div className="mt-3 space-y-4 bg-gray-900/50 rounded-xl p-4 border border-gray-800/40">
            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-2">
                <span>Umbral de silencio</span>
                <span className="text-gray-300 font-mono">{silenceThreshold.toFixed(3)}</span>
              </div>
              <input
                type="range" min={0.005} max={0.08} step={0.005}
                value={silenceThreshold}
                onChange={e => handleSilenceThreshold(Number(e.target.value))}
                className="w-full accent-red-600 h-1.5 rounded-full cursor-pointer"
              />
              <div className="flex justify-between text-xs text-gray-700 mt-1">
                <span>sensible</span><span>tolerante</span>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs text-gray-500 mb-2">
                <span>Segundos de silencio</span>
                <span className="text-gray-300 font-mono">{silenceSeconds.toFixed(1)} s</span>
              </div>
              <input
                type="range" min={0.5} max={5} step={0.5}
                value={silenceSeconds}
                onChange={e => handleSilenceSeconds(Number(e.target.value))}
                className="w-full accent-red-600 h-1.5 rounded-full cursor-pointer"
              />
              <div className="flex justify-between text-xs text-gray-700 mt-1">
                <span>rápido</span><span>conservador</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Queue preview */}
      {queue.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 font-semibold uppercase tracking-widest mb-3">A continuación</p>
          <div className="space-y-2">
            {queue.slice(0, 5).map(s => (
              <div key={s.id} className="flex items-center gap-3 bg-gray-900/60 rounded-xl p-2.5 border border-gray-800/40">
                {s.cover_art_id
                  ? <img src={'/api/cover/' + s.cover_art_id} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" alt="" />
                  : <div className="w-9 h-9 bg-gray-800 rounded-lg flex-shrink-0 flex items-center justify-center"><Music size={12} className="text-gray-600"/></div>}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.title}</p>
                  <p className="text-xs text-gray-500 truncate">{s.artist}</p>
                </div>
                <span className="text-xs font-bold text-red-500 flex-shrink-0">{s.votes} ♥</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
