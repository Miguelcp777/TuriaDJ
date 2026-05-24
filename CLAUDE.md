# CLAUDE.md — TuriaDJ

> Jukebox democrático para eventos de Falla Turia.  
> Stack: Node.js 22 · Express 4 · Socket.IO 4 · better-sqlite3 · React 18 · Vite 5 · Tailwind CSS 3

---

## Arquitectura del proyecto

```
TuriaDJ/
├── server.js          # Monolito Express: API REST + Socket.IO + broadcast engine
├── auth.js            # JWT middleware (authMiddleware, adminMiddleware)
├── db.js              # DAL SQLite con better-sqlite3 — prepared statements en todo
├── navidrome.js       # Cliente Subsonic API (Navidrome)
├── .env               # NO commitear — ver .env.example
├── data/              # SQLite DB en runtime (gitignoreado)
└── client/            # Frontend Vite/React (ESM)
    └── src/
        ├── App.jsx                   # Router manual vía window.location (ver F-0002)
        └── views/
            ├── UnifiedView.jsx       # ⚠️ God component 1611 líneas — ver deuda técnica
            ├── PlayerView.jsx        # Vista dedicada al reproductor físico
            ├── RemoteView.jsx        # Control remoto del DJ
            └── VoterView.jsx         # Vista de votación (legacy, no usado en rutas principales)
```

### Roles de usuario

| Rol | Puede |
|-----|-------|
| `admin` | Todo: controlar sesión, reproducir, saltar canciones, gestionar usuarios, spooty |
| `user` | Buscar canciones, añadir a cola (límite 2/4min), votar |

### Flujo de datos

1. Frontend carga → conecta Socket.IO → recibe estado inicial (queue, nowPlaying, session, autoDJ)
2. Usuarios votan/añaden → `POST /api/queue/add` o `POST /api/queue/vote` → `broadcast()` emite `queue:update` a todos
3. Admin hace `POST /api/player/next` → DB actualiza nowPlaying → `startBroadcast(songId)` → todos los clientes en `/api/live` reciben audio en tiempo real
4. Navidrome es la fuente de verdad para el catálogo musical

---

## Variables de entorno requeridas

Todas son obligatorias en producción. El servidor falla al arrancar si falta alguna crítica.

```env
JWT_SECRET=<string aleatorio largo>        # CRÍTICO — sin fallback
ADMIN_PASSWORD=<contraseña segura>         # CRÍTICO — contraseña del admin inicial
NAVIDROME_URL=http://host:4533             # URL base de Navidrome
NAVIDROME_USER=usuario_servicio            # Usuario Subsonic
NAVIDROME_PASS=contraseña_servicio         # Contraseña Subsonic
ALLOWED_ORIGIN=https://tu-dominio.com      # CORS de Socket.IO
SPOOTY_URL=http://localhost:3000           # URL del servicio Spooty (descarga Spotify)
PORT=3001                                  # Puerto del servidor
DATA_DIR=./data                            # Directorio de la base de datos SQLite
```

---

## Comandos de desarrollo

```bash
# Backend
npm install
node server.js

# Frontend (dev con HMR)
cd client && npm install && npm run dev

# Build frontend para producción
cd client && npm run build

# Auditoría de dependencias
npm audit
npm audit fix
```

---

## Convenciones de código

### Backend (CommonJS)
- `require()` — no usar `import` en archivos del servidor
- Prepared statements siempre: `db.prepare('SELECT ... WHERE id=?').get(id)` — nunca concatenar SQL
- Errores internos: loggear con `console.error()` y responder `{ error: 'Error interno del servidor' }` — NO exponer `e.message` al cliente
- Variables de entorno: acceder siempre vía `process.env.VAR`. Nunca hardcodear URLs ni credenciales.

### Frontend (ESM / React 18 Hooks)
- Hooks funcionales únicamente — no hay class components
- Tailwind CSS para estilos — no hay CSS modules ni styled-components
- lucide-react para iconos
- El token JWT se almacena en `localStorage` bajo la clave `jv_auth`
- `authFetch(url, opts)` — usar siempre para requests autenticados (añade Authorization header)

### Seguridad — reglas hard
- **NUNCA** añadir `|| 'valor_por_defecto'` a variables de entorno de seguridad (JWT_SECRET, ADMIN_PASSWORD)
- **NUNCA** exponer `e.message` en respuestas HTTP
- **NUNCA** usar `auth.authMiddleware` en rutas que deberían ser solo admin — usar `auth.adminMiddleware`
- **NUNCA** hacer `cors({ origin: '*' })` en Socket.IO — usar `ALLOWED_ORIGIN`

---

## Deuda técnica conocida (no romper sin discutir)

| ID | Descripción | Severidad |
|----|-------------|-----------|
| F-0001 | `UnifiedView.jsx` 1611 líneas / 62 useState — God Component. No tocar sin plan de refactor. | P2 |
| F-0002 | `App.jsx` usa `window.location.pathname` en lugar de `react-router-dom` (instalado pero sin usar) | P2 |
| F-0003 | `socket = io()` a nivel de módulo (no dentro de componente/contexto) — sin auth token en la conexión | P2 |
| F-0004 | `server.js` mezcla broadcast engine, auth, API REST y Socket.IO handlers | P3 |
| F-0005 | Migraciones de DB ad-hoc (PRAGMA + ALTER TABLE manual) — sin versionado | P3 |

---

## Hallazgos de seguridad pendientes de fix

Ver `remediation-plan.md` para el código exacto de cada fix.

| ID | Hallazgo | Prioridad | Fix en min |
|----|----------|-----------|-----------|
| F-0008 | JWT_SECRET sin fallback hardcodeado ✅ (aplicar si no está) | P0 | 5 |
| F-0009 | Admin seed desde ADMIN_PASSWORD env var | P0 | 20 |
| F-0010 | CORS Socket.IO → ALLOWED_ORIGIN | P1 | 5 |
| F-0011 | Instalar helmet (headers seguridad) | P1 | 15 |
| F-0012 | Rate limiting en /api/auth/ | P1 | 20 |
| F-0013 | /api/spooty/download → adminMiddleware | P1 | 2 |
| F-0014 | Navidrome: token-auth en lugar de p=password en URL | P1 | 30 |
| F-0016 | npm audit fix (4 vulns moderadas) | P1 | 5 |

---

## Puntos de extensión frecuentes

### Añadir una ruta nueva al backend

1. Definir en `server.js` con el middleware correcto (`authMiddleware` o `adminMiddleware`)
2. Si modifica cola o nowPlaying, llamar `broadcast()` al final
3. Errores: usar `try/catch` y responder genérico — no exponer `e.message`

### Añadir estado global al frontend

El estado actualmente vive en `UnifiedView.jsx`. Hasta que se refactorice, añadir `useState` en ese componente y pasarlo por props a los subcomponentes inline.

### Añadir una columna a la DB

1. Añadir en el `CREATE TABLE IF NOT EXISTS` del schema inicial
2. Añadir bloque de migración al final de `db.js`:
   ```js
   const cols = db.prepare('PRAGMA table_info(tabla)').all().map(c => c.name);
   if (!cols.includes('nueva_columna')) db.exec('ALTER TABLE tabla ADD COLUMN nueva_columna TEXT');
   ```
3. Documentar aquí con fecha

### Modificar el motor de broadcast

El motor (`bcastTick`, `startBroadcast`, `stopBroadcast`) usa variables globales en `server.js`. Cualquier cambio en timing o buffer afecta a todos los clientes de audio simultáneamente. Probar siempre con 3+ clientes conectados.

---

## Arquitectura de PlayerView (motor de audio)

`PlayerView.jsx` usa **dos elementos `<audio>` alternos (A y B)** para el crossfader. La lógica central:

```
audioA ──┐
          ├── AnalyserNode (Web Audio) ── destination
audioB ──┘
```

| Ref | Propósito |
|-----|-----------|
| `activeRef` | `'A'` o `'B'` — cuál elemento es el reproductor en curso |
| `advancingRef` | Mutex booleano — evita doble avance si `onEnded` y `visibilitychange` coinciden |
| `playingSrcRef` | Src en reproducción — impide que `player:update` reinicie la canción mid-crossfade |
| `targetVolRef` | Volumen objetivo global — el crossfade escala ambos canales por este valor |
| `analyserRef` | `AnalyserNode` único al que se conectan los dos elementos (fan-in) |

### Flujo de avance de canción

```
Silencio detectado (RMS < 0.02 durante 2s, en último 60s)
  └─→ handleEnded(isSilence=true)  → doCrossfade(song)     ← fade out A, fade in B, 3s
onEnded / visibilitychange / skip
  └─→ handleEnded(isSilence=false) → doImmediateSwitch(song) ← switch directo
```

### Constantes de silencio (al principio de PlayerView.jsx)

| Constante | Valor | Descripción |
|-----------|-------|-------------|
| `CROSSFADE_MS` | 3000 | Duración del crossfade en ms |
| `CROSSFADE_TICK` | 50 | ms entre pasos de volumen |
| `SILENCE_THRESHOLD` | 0.02 | Amplitud RMS (~−34 dB) por debajo de la cual se considera silencio |
| `SILENCE_SECONDS` | 2 | Segundos consecutivos de silencio antes de lanzar crossfade |
| `SILENCE_WINDOW` | 60 | Ventana al final de la canción donde se activa la detección |

### Gotchas de PlayerView

- **`createMediaElementSource`** solo puede llamarse una vez por elemento `<audio>`. Si se destruye y recrea el componente (HMR en dev), el AudioContext puede quedar en mal estado. Recargar la página.
- **`handleEnded()` llama a `/api/player/next` sin `authToken`** — el endpoint requiere admin, así que PlayerView debe ejecutarse con sesión admin activa en el mismo browser.
- **iOS Safari autoplay**: `play()` llamado desde `setInterval` (silence detection) o `visibilitychange` puede ser bloqueado por la política de autoplay del sistema. El overlay `needsTap` ("Toca para continuar") es el fallback. Si el AudioContext se crea ANTES de un gesto del usuario, puede quedarse en estado `suspended` y silenciar todo — por eso `ensureAnalyser()` se llama desde `onPlay`.
- **Durante crossfade**, el comando `player:cmd volume` no afecta los volúmenes individuales mientras el timer está corriendo — solo actualiza `targetVolRef` para el siguiente paso.

---

## Mejoras pendientes de PlayerView

### PV-001 — MediaSession API (P2, ~2h) ✅ Implementado 2026-05-24

Integrar la [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) para:
- Mostrar metadatos de la canción en la pantalla de bloqueo del móvil y en el centro de control de iOS
- Permitir avanzar/pausar desde los controles del sistema operativo
- Mejorar el comportamiento de background en iOS Safari (con Media Session activo, iOS es más permisivo con el autoplay)

```javascript
// Esqueleto del setup (llamar cuando cambia nowPlaying)
navigator.mediaSession.metadata = new MediaMetadata({
  title: song.title, artist: song.artist, album: song.album,
  artwork: [{ src: '/api/cover/' + song.cover_art_id, sizes: '512x512' }]
});
navigator.mediaSession.setActionHandler('nexttrack', () => handleSkip());
navigator.mediaSession.setActionHandler('pause', () => getActive()?.pause());
navigator.mediaSession.setActionHandler('play', () => getActive()?.play());
```

Con Media Session activo, cuando el usuario vuelve del background el sistema ya conoce el estado del reproductor y hay menos casos donde iOS bloquea el autoplay.

---

### PV-002 — Precarga de la siguiente canción (P2, ~1h) ✅ Implementado 2026-05-24

Actualmente el crossfade empieza cuando se detecta el silencio, y en ese momento se hace el `fetch` + se inicia la carga del audio. En conexiones lentas puede haber un segundo de espera antes de que el nuevo audio empiece a sonar.

**Solución**: cuando queden ~90s para el final de la canción (justo antes de la ventana de silencio), precargar el audio de la siguiente en el elemento inactivo:

```javascript
// En handleTimeUpdate, cuando dur - pos < 90 && pos > dur * 0.5:
const preloadNextSong = () => {
  if (preloadedRef.current || advancingRef.current) return;
  const nextSong = queueRef.current[0];
  if (!nextSong) return;
  const inactive = getInactive();
  inactive.src = '/api/stream/' + nextSong.id;
  inactive.preload = 'auto';
  preloadedRef.current = nextSong.id;
};
```

En `doCrossfade`, si `preloadedRef.current === song.id`, el buffer ya está parcialmente lleno → crossfade más suave.
Resetear `preloadedRef` al inicio de `doCrossfade` y cuando llega `player:update`.

---

### PV-003 — Ajuste de silencio desde RemoteView (P3, ~3h) ✅ Implementado 2026-05-24

Exponer `SILENCE_THRESHOLD` y `SILENCE_SECONDS` como configuración editable desde `RemoteView` (panel del DJ), persitida en LocalStorage o en la DB.

Requiere:
1. Convertir las constantes de módulo en estado de React (`useState` + `useRef`)
2. Añadir endpoint `POST /api/player/silence-config` (admin) que haga broadcast `player:silence-config`
3. Panel de ajuste en RemoteView con dos sliders

Útil para adaptar el comportamiento según el tipo de música (electrónica tiene silencios breves; baladas pueden tener fade-outs largos).

---

### PV-004 — Recuperación del AudioContext suspendido (P3, ~30min) ✅ Implementado 2026-05-24

Si el AudioContext queda en estado `suspended` (iOS lo hace agresivamente cuando la pestaña lleva tiempo en background), el analizador deja de leer datos y la detección de silencio se paraliza. El silencio real no se detecta y hay que esperar a `onEnded`.

**Fix**: en `startSilenceMonitor`, antes de leer el buffer, comprobar el estado del contexto:

```javascript
if (audioCtxRef.current?.state === 'suspended') {
  audioCtxRef.current.resume().catch(() => {});
  return; // skip this tick, try next
}
```

Y en `onVisibility`, si `getActive()?.paused === false` (está "playing" según el elemento pero el contexto está suspendido), hacer resume.

---

## Gotchas conocidos

- **`autoDJActive`** es variable global en `server.js` — sincronizarla con DB al reiniciar servidor si se quiere persistir estado entre reinicios
- **Subsonic API** envía `p=password` en URL — aparece en logs de Navidrome (ver F-0014)
- **`bcastJoinBufMax = 0`** en inicio — los clientes que conectan antes del primer `startBroadcast` no reciben join buffer; esto es correcto pero puede sonar a silencio breve
- **SQLite es síncrono** — todas las operaciones de `db.js` bloquean el event loop de Node. Para cargas altas, considerar WAL mode: `db.pragma('journal_mode = WAL')`

---

## Historial de cambios relevantes

| Fecha | Cambio |
|-------|--------|
| 2026-05-24 | PlayerView: PV-001–004 — MediaSession API, precarga, config silencio en RemoteView, recovery AudioContext |
| 2026-05-24 | PlayerView: crossfader 3s + detección de silencio + fix background/foreground |
| 2026-05-24 | Auditoría de seguridad completa — 20 hallazgos documentados en audit-report.md |
| (previo) | feat: confirmación antes de descarga Spooty |
| (previo) | feat: Spooty notifica cuando canción está disponible en Navidrome |
