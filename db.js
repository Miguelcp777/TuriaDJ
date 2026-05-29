const Database = require('better-sqlite3');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const db = new Database(path.join(DIR, 'jukevote.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album TEXT,
    duration INTEGER, cover_art_id TEXT, votes INTEGER DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    first_voted_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS votes (
    song_id TEXT, session_id TEXT, PRIMARY KEY (song_id, session_id)
  );
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS additions (
    user_id TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing DBs
const queueCols = db.prepare('PRAGMA table_info(queue)').all().map(c => c.name);
if (!queueCols.includes('first_voted_at')) db.exec('ALTER TABLE queue ADD COLUMN first_voted_at DATETIME');
if (!queueCols.includes('priority'))       db.exec('ALTER TABLE queue ADD COLUMN priority INTEGER DEFAULT 0');

module.exports = {
  // ── users ──────────────────────────────────────────────────────────────────
  createUser(username, passwordHash, role = 'user') {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id,username,password_hash,role) VALUES (?,?,?,?)').run(id, username, passwordHash, role);
    return { id, username, role };
  },
  getUserByUsername: (u) => db.prepare('SELECT * FROM users WHERE username=?').get(u),
  getUserById:       (id) => db.prepare('SELECT id,username,role FROM users WHERE id=?').get(id),
  getUsers:          ()  => db.prepare('SELECT id,username,role,created_at FROM users ORDER BY created_at ASC').all(),
  updateUserRole:    (id, role) => db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id),
  deleteUser:        (id) => db.prepare('DELETE FROM users WHERE id=?').run(id),

  canAddSong(userId) {
    const { n } = db.prepare(
      "SELECT COUNT(*) as n FROM additions WHERE user_id=? AND added_at > datetime('now','-4 minutes')"
    ).get(userId);
    return n < 2;
  },
  recordAddition(userId) {
    db.prepare('INSERT INTO additions (user_id) VALUES (?)').run(userId);
    db.prepare("DELETE FROM additions WHERE added_at < datetime('now','-10 minutes')").run();
  },
  nextAdditionTime(userId) {
    const row = db.prepare(
      "SELECT added_at FROM additions WHERE user_id=? AND added_at > datetime('now','-4 minutes') ORDER BY added_at ASC LIMIT 1"
    ).get(userId);
    if (!row) return null;
    return new Date(row.added_at + 'Z').getTime() + 4 * 60 * 1000;
  },

  // ── queue ──────────────────────────────────────────────────────────────────
  getQueue: () => db.prepare(
    'SELECT * FROM queue ORDER BY priority DESC, votes DESC, first_voted_at ASC, added_at ASC'
  ).all(),
  getSong:   (id) => db.prepare('SELECT * FROM queue WHERE id=?').get(id),
  addToQueue(song) {
    db.prepare('INSERT OR IGNORE INTO queue (id,title,artist,album,duration,cover_art_id,votes,priority) VALUES (?,?,?,?,?,?,0,0)')
      .run(song.id, song.title, song.artist, song.album, song.duration, song.coverArt);
  },
  pinSong(id) {
    db.prepare('UPDATE queue SET priority=0').run();
    db.prepare('UPDATE queue SET priority=1 WHERE id=?').run(id);
  },
  removeFromQueue(id) {
    db.prepare('DELETE FROM queue WHERE id=?').run(id);
    db.prepare('DELETE FROM votes WHERE song_id=?').run(id);
  },
  clearQueue() {
    db.exec('DELETE FROM queue; DELETE FROM votes;');
  },

  // ── votes ──────────────────────────────────────────────────────────────────
  hasVoted: (songId, userId) => !!db.prepare('SELECT 1 FROM votes WHERE song_id=? AND session_id=?').get(songId, userId),
  addVote(songId, userId) {
    db.prepare('INSERT OR IGNORE INTO votes (song_id,session_id) VALUES (?,?)').run(songId, userId);
    db.prepare('UPDATE queue SET votes=votes+1, first_voted_at=COALESCE(first_voted_at,CURRENT_TIMESTAMP) WHERE id=?').run(songId);
  },
  getUserVotes: (userId) => db.prepare('SELECT song_id FROM votes WHERE session_id=?').all(userId).map(r => r.song_id),

  // ── state (now playing) ────────────────────────────────────────────────────
  getNowPlaying() {
    const r = db.prepare("SELECT value FROM state WHERE key='current_song'").get();
    return r ? JSON.parse(r.value) : null;
  },
  setNowPlaying:   (s) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('current_song',?)").run(JSON.stringify(s)),
  clearNowPlaying: ()  => db.prepare("DELETE FROM state WHERE key='current_song'").run(),

  // ── DJ session ────────────────────────────────────────────────────────────
  getSessionActive() {
    const r = db.prepare("SELECT value FROM state WHERE key='session_active'").get();
    return r ? r.value === '1' : false;
  },
  setSessionActive: (v) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('session_active',?)").run(v ? '1' : '0'),
  getSessionName() { const r = db.prepare("SELECT value FROM state WHERE key='session_name'").get(); return r ? r.value : ''; },
  setSessionName: (v) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('session_name',?)").run(v || ''),
  getSessionDesc() { const r = db.prepare("SELECT value FROM state WHERE key='session_desc'").get(); return r ? r.value : ''; },
  setSessionDesc: (v) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('session_desc',?)").run(v || ''),
  getAutoDJEnabled() { const r = db.prepare("SELECT value FROM state WHERE key='autodj_enabled'").get(); return r ? r.value === '1' : false; },
  setAutoDJEnabled: (v) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('autodj_enabled',?)").run(v ? '1' : '0'),
  getAutoDJPlaylists() { const r = db.prepare("SELECT value FROM state WHERE key='autodj_playlists'").get(); return r ? JSON.parse(r.value) : []; },
  setAutoDJPlaylists: (ids) => db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('autodj_playlists',?)").run(JSON.stringify(ids)),
  getSetting(key)       { const r = db.prepare('SELECT value FROM state WHERE key=?').get(key); return r ? r.value : null; },
  setSetting(key, val)  { db.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)').run(key, String(val)); },
  clearAll() {
    db.exec('DELETE FROM queue; DELETE FROM votes; DELETE FROM additions;');
    db.prepare("DELETE FROM state WHERE key='current_song'").run();
  },
};
