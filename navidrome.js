const axios = require('axios');

const BASE = () => process.env.NAVIDROME_URL  || 'http://localhost:4533';
const USER = () => process.env.NAVIDROME_USER || 'admin';
const PASS = () => process.env.NAVIDROME_PASS || 'admin';
const auth = () => 'u=' + USER() + '&p=' + PASS() + '&v=1.16.1&c=jukevote&f=json';

function mapSong(s) {
  return { id: s.id, title: s.title, artist: s.artist || '', album: s.album || '',
           duration: s.duration || 0, coverArt: s.coverArt || '' };
}

async function search(query) {
  const url = BASE() + '/rest/search3.view?query=' + encodeURIComponent(query) + '&songCount=25&' + auth();
  const { data } = await axios.get(url, { timeout: 8000 });
  return (data?.["subsonic-response"]?.searchResult3?.song || []).map(mapSong);
}

async function getPlaylists() {
  const url = BASE() + '/rest/getPlaylists.view?' + auth();
  const { data } = await axios.get(url, { timeout: 8000 });
  const list = data?.["subsonic-response"]?.playlists?.playlist || [];
  return (Array.isArray(list) ? list : [list])
    .map(p => ({ id: p.id, name: p.name, count: p.songCount, coverArt: p.coverArt || '' }));
}

async function getPlaylistSongs(id) {
  const url = BASE() + '/rest/getPlaylist.view?id=' + id + '&' + auth();
  const { data } = await axios.get(url, { timeout: 10000 });
  const entries = data?.["subsonic-response"]?.playlist?.entry || [];
  return (Array.isArray(entries) ? entries : [entries]).map(mapSong);
}

async function getRandomSongs(size = 100) {
  const url = BASE() + '/rest/getRandomSongs.view?size=' + size + '&' + auth();
  const { data } = await axios.get(url, { timeout: 10000 });
  return (data?.["subsonic-response"]?.randomSongs?.song || []).map(mapSong);
}

module.exports = {
  search, getPlaylists, getPlaylistSongs, getRandomSongs,
  streamUrl: (id) => BASE() + '/rest/stream.view?id=' + id + '&format=mp3&' + auth(),
  coverUrl:  (id) => BASE() + '/rest/getCoverArt.view?id=' + id + '&size=400&' + auth(),
};
