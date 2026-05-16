import UnifiedView from './views/UnifiedView.jsx';
import PlayerView  from './views/PlayerView.jsx';
import RemoteView  from './views/RemoteView.jsx';

export default function App() {
  const path = window.location.pathname;
  if (path === '/player')         return <PlayerView />;
  if (path === '/remote-control') return <RemoteView />;
  return <UnifiedView />;
}
