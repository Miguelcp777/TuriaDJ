import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { Search, ThumbsUp, Plus, Music, X, Mic2, ChevronRight } from 'lucide-react';

const socket = io({ transports: ['websocket'] });

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getSession() {
  let id = localStorage.getItem('jv_session');
  if (!id) { id = uuid(); localStorage.setItem('jv_session', id); }
  return id;
}

function fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

function CoverImg({ id, className }) {
  const [err, setErr] = useState(false);
  if (!id || err) return (
    <div className={'bg-gray-800 flex items-center justify-center ' + className}>
      <Music size={20} className="text-gray-600" />
    </div>
  );
  return <img src={'/api/cover/' + id} onError={() => setErr(true)} className={'object-cover ' + className} alt="" />;
}

function SongRow({ song, onVote, voted, rank }) {
  const [pulse, setPulse] = useState(false);
  const handleVote = () => {
    if (voted) return;
    setPulse(true);
    setTimeout(() => setPulse(false), 300);
    onVote(song.id);
  };
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-900/60 hover:bg-gray-900 border border-gray-800/50 transition-all fade-in">
      <div className="flex-shrink-0 w-6 text-center">
        {rank === 1
          ? <span className="text-yellow-400 text-sm font-bold">#1</span>
          : <span className="text-gray-600 text-xs">#{rank}</span>}
      </div>
      <CoverImg id={song.cover_art_id} className="w-12 h-12 rounded-lg flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm truncate text-white">{song.title}</p>
        <p className="text-gray-400 text-xs truncate">{song.artist}{song.album ? ' · ' + song.album : ''}</p>
        {song.duration > 0 && <p className="text-gray-600 text-xs">{fmtDur(song.duration)}</p>}
      </div>
      <button
        onClick={handleVote}
        title={voted ? 'Already voted' : 'Vote for this song'}
        className={'flex-shrink-0 flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl transition-all select-none ' + (voted
          ? 'bg-purple-600/30 text-purple-400 cursor-default'
          : 'bg-gray-800 hover:bg-purple-600/20 hover:text-purple-400 text-gray-400 active:scale-95 cursor-pointer')}
      >
        <ThumbsUp size={18} className={pulse ? 'vote-pulse' : ''} fill={voted ? 'currentColor' : 'none'} />
        <span className="text-xs font-bold leading-none">{song.votes}</span>
      </button>
    </div>
  );
}

function SearchModal({ onAdd, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState(new Set());
  const timer = useRef(null);

  const search = useCallback((val) => {
    clearTimeout(timer.current);
    if (val.length < 2) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(val));
        setResults(await r.json());
      } catch { setResults([]); }
      setLoading(false);
    }, 350);
  }, []);

  const handleAdd = (song) => {
    setAdded(prev => new Set([...prev, song.id]));
    onAdd(song);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end" onClick={onClose}>
      <div className="w-full bg-gray-950 border border-gray-800 rounded-t-2xl slide-up max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h2 className="font-bold text-lg">Add a song</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 border-b border-gray-800">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              autoFocus
              value={q}
              onChange={e => { setQ(e.target.value); search(e.target.value); }}
              placeholder="Search songs, artists, albums..."
              className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-4 py-3 text-sm focus:outline-none focus:border-purple-500 placeholder-gray-600"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {!loading && results.length === 0 && q.length > 1 && (
            <p className="text-center py-8 text-gray-500 text-sm">No songs found</p>
          )}
          {!loading && q.length < 2 && (
            <div className="text-center py-8 text-gray-600 text-sm">
              <Mic2 size={32} className="mx-auto mb-2 opacity-40" />
              Type to search your music library
            </div>
          )}
          {results.map(song => (
            <button key={song.id} onClick={() => handleAdd(song)}
              disabled={added.has(song.id)}
              className={'w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left active:scale-[0.98] ' + (added.has(song.id)
                ? 'bg-purple-900/20 border-purple-800/30 opacity-60 cursor-default'
                : 'bg-gray-900/60 hover:bg-gray-800 border-gray-800/30 cursor-pointer')}>
              <CoverImg id={song.coverArt} className="w-11 h-11 rounded-lg flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{song.title}</p>
                <p className="text-gray-400 text-xs truncate">{song.artist}{song.album ? ' · ' + song.album : ''}</p>
              </div>
              {added.has(song.id)
                ? <span className="text-xs text-purple-400 flex-shrink-0">Added</span>
                : <Plus size={18} className="text-purple-400 flex-shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function VoterView() {
  const [queue, setQueue]           = useState([]);
  const [nowPlaying, setNowPlaying] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [progress, setProgress]     = useState(0);
  const sessionId = getSession();
  // votedSongs tracks which songs this session has thumbs-upped
  const [votedSongs, setVotedSongs] = useState(() => new Set(JSON.parse(localStorage.getItem('jv_voted') || '[]')));

  useEffect(() => {
    // Clear stale voted list when queue resets
    socket.on('queue:update', (q) => {
      setQueue(q);
      // Remove from voted any song no longer in queue
      const inQueue = new Set(q.map(s => s.id));
      setVotedSongs(prev => {
        const next = new Set([...prev].filter(id => inQueue.has(id)));
        localStorage.setItem('jv_voted', JSON.stringify([...next]));
        return next;
      });
    });
    socket.on('player:update',   setNowPlaying);
    socket.on('player:progress', d => setProgress(d?.position || 0));
    return () => { socket.off('queue:update'); socket.off('player:update'); socket.off('player:progress'); };
  }, []);

  const handleVote = async (songId) => {
    // Optimistic update
    setVotedSongs(prev => {
      const next = new Set(prev);
      next.add(songId);
      localStorage.setItem('jv_voted', JSON.stringify([...next]));
      return next;
    });
    setQueue(prev => prev.map(s => s.id === songId ? { ...s, votes: s.votes + 1 } : s)
      .sort((a, b) => b.votes - a.votes || new Date(a.added_at) - new Date(b.added_at)));
    await fetch('/api/queue/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId, sessionId })
    });
  };

  const handleAdd = async (song) => {
    // Add to queue — does NOT auto-vote, user thumbs-up separately
    await fetch('/api/queue/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song })
    });
  };

  const progressPct = nowPlaying?.duration ? Math.min(100, (progress / nowPlaying.duration) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#0a0a14] flex flex-col max-w-lg mx-auto">
      <header className="sticky top-0 z-30 bg-[#0a0a14]/95 backdrop-blur border-b border-gray-800/50">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <Music size={16} className="text-white" />
          </div>
          <span className="font-extrabold text-lg tracking-tight">JukeVote</span>
          <a href="/player" className="ml-auto text-xs text-gray-500 hover:text-purple-400 flex items-center gap-1 transition-colors">
            Player <ChevronRight size={14} />
          </a>
        </div>

        {nowPlaying && (
          <div className="px-4 pb-3">
            <div className="bg-gradient-to-r from-purple-900/30 to-purple-800/10 border border-purple-800/30 rounded-xl p-3">
              <div className="flex items-center gap-3">
                <CoverImg id={nowPlaying.cover_art_id} className="w-10 h-10 rounded-lg flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] text-purple-400 font-semibold uppercase tracking-wider">Now Playing</span>
                  <p className="text-sm font-semibold truncate">{nowPlaying.title}</p>
                  <p className="text-xs text-gray-400 truncate">{nowPlaying.artist}</p>
                </div>
              </div>
              {nowPlaying.duration > 0 && (
                <div className="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-500 rounded-full transition-all duration-1000" style={{ width: progressPct + '%' }} />
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 px-4 py-4 space-y-2 pb-24">
        {queue.length === 0 && (
          <div className="text-center py-16">
            <div className="w-16 h-16 bg-gray-900 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Music size={28} className="text-gray-600" />
            </div>
            <p className="font-semibold text-gray-400">Queue is empty</p>
            <p className="text-sm text-gray-600 mt-1">Be the first to add a song!</p>
          </div>
        )}
        {queue.map((song, i) => (
          <SongRow key={song.id} song={song} onVote={handleVote} voted={votedSongs.has(song.id)} rank={i + 1} />
        ))}
      </main>

      <div className="fixed bottom-6 right-4">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold px-5 py-3.5 rounded-2xl shadow-lg shadow-purple-900/40 transition-all active:scale-95"
        >
          <Plus size={20} />
          Add Song
        </button>
      </div>

      {searchOpen && <SearchModal onAdd={handleAdd} onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
