import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Music, SkipForward, Volume2, Play, Pause } from 'lucide-react';

const socket = io({ transports: ['websocket'] });

function fmtDur(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

export default function PlayerView() {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [queue, setQueue]           = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);
  const [isPlaying, setIsPlaying]   = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    socket.on('queue:update',  setQueue);
    socket.on('player:update', song => {
      setNowPlaying(song);
      if (song && audioRef.current) {
        audioRef.current.src = '/api/stream/' + song.id;
        audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    });
    // Load initial state
    fetch('/api/now-playing').then(r => r.json()).then(song => {
      if (song) {
        setNowPlaying(song);
        if (audioRef.current) {
          audioRef.current.src = '/api/stream/' + song.id;
        }
      }
    });
    fetch('/api/queue').then(r => r.json()).then(setQueue);
    return () => { socket.off('queue:update'); socket.off('player:update'); };
  }, []);

  const handleEnded = async () => {
    setIsPlaying(false);
    const r = await fetch('/api/player/next', { method: 'POST' });
    const { song } = await r.json();
    if (song && audioRef.current) {
      audioRef.current.src = '/api/stream/' + song.id;
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    const pos = audioRef.current.currentTime;
    const dur = audioRef.current.duration || 0;
    setCurrentTime(pos);
    setDuration(dur);
    socket.emit('player:progress', { position: pos, duration: dur });
  };

  const handleSkip = async () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ''; }
    handleEnded();
  };

  const togglePlay = () => {
    if (!audioRef.current || !nowPlaying) return;
    if (isPlaying) { audioRef.current.pause(); setIsPlaying(false); }
    else { audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {}); }
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const coverBg = nowPlaying ? 'url(/api/cover/' + nowPlaying.cover_art_id + ')' : '';

  return (
    <div className="fixed inset-0 bg-[#07070f] overflow-hidden flex flex-col">
      {/* Blurred background */}
      {nowPlaying && (
        <div className="absolute inset-0 opacity-20 scale-110 blur-3xl"
          style={{ backgroundImage: coverBg, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-[#07070f]/40 via-transparent to-[#07070f]" />

      {/* Main content */}
      <div className="relative z-10 flex flex-col h-full p-8">
        {/* Top bar */}
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

        {/* Center: album art + info */}
        <div className="flex-1 flex items-center justify-center gap-12">
          {/* Album Art */}
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

          {/* Song info + controls */}
          <div className="flex flex-col justify-center min-w-0 max-w-sm">
            {nowPlaying ? (
              <>
                <p className="text-xs text-brand font-semibold uppercase tracking-widest mb-3">Now Playing</p>
                <h1 className="text-4xl font-extrabold leading-tight mb-2 text-white">{nowPlaying.title}</h1>
                <p className="text-xl text-gray-400 font-medium mb-1">{nowPlaying.artist}</p>
                <p className="text-gray-600 mb-8">{nowPlaying.album}</p>

                {/* Progress */}
                <div className="mb-2">
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden cursor-pointer"
                    onClick={e => {
                      if (!audioRef.current || !duration) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      audioRef.current.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
                    }}>
                    <div className="h-full bg-brand rounded-full transition-all duration-500" style={{ width: pct + '%' }} />
                  </div>
                  <div className="flex justify-between text-xs text-gray-600 mt-1">
                    <span>{fmtDur(currentTime)}</span>
                    <span>{fmtDur(duration)}</span>
                  </div>
                </div>

                {/* Controls */}
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

          {/* Up Next */}
          {queue.length > 0 && (
            <div className="hidden xl:flex flex-col gap-3 w-64 flex-shrink-0">
              <p className="text-xs text-gray-500 font-semibold uppercase tracking-widest mb-1">Up Next</p>
              {queue.slice(0, 4).map((s, i) => (
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

      <audio ref={audioRef} onEnded={handleEnded} onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
    </div>
  );
}
