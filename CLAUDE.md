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
GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com   # OPCIONAL — acceso con Google
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
| `SILENCE_THRESHOLD` | 0.02 | Amplitud RMS (~−34 dB) — detector local, hoy solo respaldo |
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

### PV-003 — Ajuste de silencio desde RemoteView (P3) ⛔ REVERTIDO 2026-08-11

Se implementó (dos sliders en RemoteView + `POST /api/player/silence-config`) y **se ha quitado**:
no existe un par de valores que valga para toda la biblioteca, y el detector del navegador
llegaba tarde. Ahora el punto de mezcla lo calcula el servidor por canción — ver
"Regla del solapamiento". El endpoint sigue existiendo pero solo fuerza un recálculo.

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

## El mando: un solo reproductor a la vez (✅ 2026-08-16)

**"Sesión" significa dos cosas** en este proyecto: el login de un usuario y el evento musical.
En la interfaz el evento se llama ahora **"fiesta"**; en el código, `session_active`.

El **mando** es una tercera cosa, y es la que importa para el audio: **qué dispositivo
reproduce y dirige**. Cualquier admin puede estar identificado a la vez, pero solo uno tiene el
mando. Hizo falta porque el panel es quien dirige la reproducción: con dos paneles abiertos, los
dos piden el avance en el mismo instante (se salta una canción) y los dos escriben la posición.

| Pieza | Detalle |
|---|---|
| Identidad | `deviceId` en `localStorage` (`jv_device`), compartido por `UnifiedView` y `PlayerView` |
| Estado | `mando = { deviceId, nombre, username, socketId, desde, latido }` en `server.js` |
| Protocolo | `control:pedir` (no arrebata) · `control:tomar` (arrebata) · `control:latido` (10 s) · `control:soltar` · `control:revocado` |
| Caducidad | `MANDO_TTL_MS` 30 s sin latido → queda libre |
| Refuerzo | `soloMando` en `/api/session/*`; en `/api/player/next` solo si `porMezcla`; sockets `player:progress` y `player:auto-next` comparan `deviceId` |

⚠️ **El mando NO se limpia en `resetRuntimeState()`.** Se probó y estaba mal: esa función corre
al **iniciar** la fiesta, justo después de que el DJ cogiera el mando al abrir el panel, así que
le dejaba sin control y otro dispositivo podía cogerlo sin que saltara ningún aviso. El mando va
con el dispositivo, no con la fiesta.

⚠️ **Un skip a mano lo puede pedir cualquier admin**, también `RemoteView` — es un mando a
distancia legítimo que no reproduce. Lo que se rechaza de otro dispositivo es el avance
**automático** de una mezcla (`porMezcla: true`), que es donde una pestaña olvidada hace daño.

⚠️ **Al desconectarse un socket NO se libera el mando**: en el móvil el socket se cae al
bloquear la pantalla. Se deja caducar por latido.

## Cierre de la fiesta: dos criterios (✅ 2026-08-16)

Se cierra por el que llegue antes:

1. **Duración fija** (la de siempre): `session_end_time`, opcional, se elige al iniciar.
2. **Inactividad**: `session_inactividad_min` (por defecto **120**, `0` = desactivado).

Motivo: una sesión abierta a las 12:07 siguió sonando **6,5 h y 97 canciones** sin que nadie la
escuchara — **96 de los 97 avances los pidió el temporizador de seguridad**, solo 1 el panel.

**Qué cuenta como actividad** (`marcarActividad`):
- acciones humanas: añadir, votar, chat, `user:join`, rutas de admin;
- **un mando vivo reproduciendo** (`player:progress` del dispositivo al mando).

⚠️ **NO cuenta que AutoDJ avance canciones.** Si contase, la sesión olvidada no caducaría nunca.

⚠️ **SÍ cuenta el mando reproduciendo**, y es imprescindible: el caso más común es el admin que
engancha el altavoz y la gente baila sin tocar el móvil — cero interacciones durante horas con
la fiesta muy viva. Verificado con las dos caras en la misma pasada: con el panel reproduciendo
**no se cierra**; en cuanto el panel se va, **se cierra**.

Aviso al admin cuando quedan `AVISO_MIN` (15) minutos, con **[Seguimos aquí]**
(`POST /api/session/sigo`). La comprobación corre cada 20 s.

## Gotchas conocidos

- **`autoDJActive`** es variable global en `server.js` — sincronizarla con DB al reiniciar servidor si se quiere persistir estado entre reinicios
- **Subsonic API** envía `p=password` en URL — aparece en logs de Navidrome (ver F-0014)
- **`bcastJoinBufMax = 0`** en inicio — los clientes que conectan antes del primer `startBroadcast` no reciben join buffer; esto es correcto pero puede sonar a silencio breve
- **SQLite es síncrono** — todas las operaciones de `db.js` bloquean el event loop de Node. Para cargas altas, considerar WAL mode: `db.pragma('journal_mode = WAL')`
- **Servicio systemd en producción**: el servicio se llama `turiadj.service` (NO `jukevote.service` — ese era un duplicado antiguo que se ha eliminado). Cwd: `/opt/jukevote`. `Restart=always` con `RestartSec=5`. Para reiniciar tras deploy: `sudo systemctl restart turiadj.service`.
- **Crossfade del servidor para voters (`/api/live`)**: sigue SIN implementar (el solapamiento solo existe en cliente, con dual `<audio>`: PlayerView y UnifiedView admin). Lo que SÍ se arregló (2026-08-07) es el **silencio** entre canciones: hoy la transición es un corte limpio *gapless*, sin hueco mudo. Ver la sección "Transiciones sin silencio". El intento antiguo con ffmpeg `acrossfade` fracasó por dos razones ya entendidas: el muxer MP3 escribe ID3v2+Xing al inicio (de ahí `mp3float: Header missing`, se evita con `-write_xing 0 -id3v2_version 0`), y el arranque de ~5s deja de importar porque `player:peek-next` avisa con ~90s de antelación.
- **⚠️ Los tags ID3v2 son audio-time en el broadcast**: el 99,6% de la biblioteca lleva carátula incrustada (45 KB de media, hasta 263 KB). Como `/api/live` dosifica bytes a ritmo de reproducción, **cada KB de tag consume tiempo real de emisión**. Cualquier código que meta bytes en el broadcast DEBE saltar el tag primero (`findAudioStart`). Ojo: no basta con buscar el sync `0xFFEx`, porque el JPEG de la carátula puede imitar cabeceras — hay que saltar el tag por su longitud declarada (syncsafe) y solo después buscar el frame.

---

## Robustez de sesión en eventos largos (✅ 2026-06-07)

Tras horas con la sesión abierta de forma **indefinida**, el panel admin en móvil (`UnifiedView.jsx`) se degradaba. Mecanismos implementados (todos gated a `role === 'admin'`; `PlayerView.jsx` NO se toca):

### Servidor (`server.js`)
- **`resetRuntimeState()`**: pone a cero TODO el estado efímero (`advanceInFlight`, `lastAutoAdvanceAt`, `lastProgress`, `pendingAutoDJ`, `autoDJActive`, `chatMessages`, `onlineUsers`, `chatRateLimit`). Se llama al **iniciar** y **terminar** sesión → cada sesión empieza/termina pristina y no hereda estado viejo (p.ej. un `advanceInFlight` colgado que bloquearía todos los avances).
- **Heartbeat**: `io.emit('heartbeat', Date.now())` cada 10s. Permite al watchdog del cliente detectar un socket muerto en ~20s (el `ping-timeout` de socket.io tarda ~45s).
- **`startBroadcast`**: `bcastGen` (token de generación) evita un segundo `bcastTicker` si una promesa axios vieja resuelve tarde; `timeout: 15000` (antes `0`) acota la conexión a Navidrome.

### Cliente (`UnifiedView.jsx`)
- **`resyncAll()`**: re-sincroniza `session/status` + `now-playing` + `queue` + `autodj/status` + `user:join`. Reutiliza la reconciliación de audio (carga solo si el src difiere; reintenta play si está pausado → no reinicia una canción en curso). Se llama en: montaje, `socket.on('connect')` (reconexión), y `visibilitychange` (volver de background). **Antes solo se refrescaba now-playing.**
- **Watchdog** (`setInterval` 12s, solo con pestaña visible): señal primaria = tiempo sin `heartbeat`/contacto (NO `socket.connected`, que va con retraso). `>20s` → reconectar + `resyncAll`; `>60s` → `guardedReload`. `guardedReload` nunca recarga con pestaña oculta y aplica backoff de 90s (`localStorage.jv_last_reload`) anti-bucle. Recarga preventiva por antigüedad `>6h` solo en idle (sin canción / sesión cerrada).
- **`session:update`**: al terminar sesión resetea la UI a idle (para ambos `<audio>`, limpia cola/nowPlaying/chat); al reiniciar tras estar cerrada → `resyncAll`.
- **chatMessages** acotado a 100 (evita crecimiento sin límite en sesiones largas).

Verificado E2E (Chromium, producción): resync background→foreground (canción del servidor + reproduciendo), fin→inicio con globales reseteados (posición 0, autodj inactivo, avance funcional), watchdog detecta socket caído ~25s y recupera sin recarga prematura.

---

## Crossfade (✅ VERIFICADO funcionando 2026-06-01)

El crossfade está verificado con test E2E en Chromium headless. Funciona en:

- **PlayerView** (`/player`, reproductor físico) — dual audio A/B + `setInterval` ticks
- **UnifiedView** (panel admin) — dual audio A/B + `requestAnimationFrame`
- **Voters** (`/api/live`) — mezcla renderizada con ffmpeg en el servidor (ver más abajo)

### Regla del solapamiento (⚠️ reescrita 2026-08-11 — ya NO se configura)

**Las canciones se solapan 3 segundos. Punto.** Lo único que se calcula por canción es
**dónde** arranca ese solape, y depende de cómo acabe la saliente:

| Final de la saliente | Dónde entra la siguiente |
|---|---|
| Seco | 3 s antes del final del fichero |
| Con silencio de cola | 3 s antes del final de la **música** (el silencio no cuenta) |
| Con fundido | **2 s después de empezar el fundido** |

La regla vive en `mezcla.js` (`puntosDeMezcla`), **fuera de `server.js` a propósito**, para
poder medirla contra la biblioteca real sin arrancar el servidor. Entra por parámetro una
serie de niveles RMS del tramo final y salen `mixStartMs`, `audioEndMs` y `fadeMs`.

Antes hubo dos mandos (umbral en dB y recorte máximo) en el panel y en RemoteView. Se han
quitado: **no había un par de valores que valiese para toda la biblioteca**, y el mando de
"duración del crossfade" (1–10 s) contradecía la regla de los 3 s. `crossfade_ms` sigue en
la DB pero ya no lo lee nadie.

#### Cómo se mide (dos trampas que cuestan horas)

1. **`astats` imprime una línea por FRAME (~26 ms), no por ventana**, y dentro de una ventana
   el valor es un RMS acumulado que va cayendo. `reset=N` a secas da una serie en dientes de
   sierra, no la curva de la canción. La forma correcta es `asetnsamples` + `reset=1`
   (constante `FILTRO_RMS` en `mezcla.js`).
2. **`silencedetect` no sirve** para el final: exige nivel bajo *continuo* y un fundido con
   golpes sueltos lo resetea. Sí sirve, en cambio, para el silencio **inicial**.

#### Silencio con el que ARRANCA la entrante

Censo sobre 120 canciones: **44 % empiezan con algo de silencio, 13 % con 1 s o más, 7 % con
2 s o más; la peor ("Fantasy Girl") 7,9 s**. `analizarIntro` lo mide con `silencedetect` al
añadir la canción a la cola y al precargarla, y viaja al cliente como `introMs` en la cola,
en `now-playing`, en `/api/player/next` y en `player:peek-next`.

Se recorta en **todos** los arranques, no solo en las transiciones:

| Camino | Dónde se aplica |
|---|---|
| Mezcla del servidor (voters) | `renderBridge` abre B en `introMs`; `enterBridge` suma ese salto |
| Arranque en seco (voters) | `startBroadcast` → `saltarSilencioInicial` (usa `skipFrames`/`skipPendingMs`) |
| Panel admin | `startCrossfade` y `loadAndPlay` ponen `currentTime` |
| PlayerView | `saltarIntro` en preload, crossfade, switch inmediato y `player:update` |

⚠️ **No aplicar cuando se reanuda a mitad de canción** (`offsetSec`): ya se está por delante.

A/B medidos sobre "Fantasy Girl": el solape de una transición terminaba en **−93,5 dB**
(silencio digital) y ahora en −31 dB; un arranque en seco emitía **17 ventanas mudas de 0,5 s**
(8,5 s de nada) y ahora **0**.

### Cuándo se dispara

| Evento | Acción |
|---|---|
| `currentTime ≥ mixStartMs` en `handleTimeUpdate` | **Crossfade de 3 s** (camino normal) |
| `onEnded` (canción terminó sin pre-trigger) | Crossfade (cliente) o switch inmediato (fallback) |
| Silencio detectado RMS < threshold durante `silenceSecs` (PlayerView) | **Switch inmediato** — respaldo: con `mixStartMs` la mezcla ya ha empezado antes |
| Admin pulsa "Skip" (`handleSkip`) | **Switch inmediato** (acción explícita del DJ) |

### ⚠️ Dos fallos que rompían el crossfade del panel (corregidos 2026-08-15)

**1. `rAF` puede entregar una marca de tiempo ANTERIOR a `t0`.** El bucle del
fundido calculaba `p = Math.min((now - t0) / fadeMs, 1)` sin acotar por abajo.
`requestAnimationFrame` pasa la marca del **fotograma**, y ese fotograma pudo
empezar antes de que se leyera `t0`: con `now < t0`, `p` sale negativo, `1 - p`
pasa de 1 y asignar ese volumen lanza `IndexSizeError`. La excepción mataba el
bucle **en su primer paso**: saliente clavada a tope, entrante a cero, y al
acabar la canción `handleEnded` cortaba en seco con la siguiente entrando de
golpe. Acotar `p` a `[0,1]` (y el volumen antes de asignarlo) es todo el fix.
Sale por consola, no leyendo el código: **capturar `pageerror` en los tests E2E**.

**2. El panel no precargaba la siguiente canción.** `PlayerView` sí (PV-002),
pero `UnifiedView` —el que suena en la sala— ponía el `src` de la entrante *en el
instante* de la mezcla. Con la regla nueva eso son 3 s antes del final: si la
descarga tardaba más, la saliente se acababa y se oía el corte. Ahora
`precargarSiguiente()` la baja **45 s antes** del punto de mezcla (cola o
`player:peek-next` en AutoDJ) y `startCrossfade` no toca el `src` si ya está lista.

### ⚠️ Sin panel conectado, el motor y la app se separaban (corregido 2026-08-15)

`enterBridge` movía el **audio** a la canción siguiente en el punto de mezcla, pero
`nowPlaying` no avanzaba hasta que saltaba la red de seguridad en `duración + 2`.
Con un panel vivo no se notaba (el avance lo pide él), pero **sin ningún reproductor**
el desfase se acumula canción a canción — medido en una sesión real: 0 s → 35 s →
40 s → 64 s. Y como `nextUpId()`, la precarga y la verja anti-obsoletos se calculan
desde la DB, al crecer el desfase el motor preparaba la mezcla hacia una canción que
en la emisión ya había sonado: **corte antes de tiempo y temas repetidos**.

Ahora, cuando la mezcla arranca sola por el reloj de audio, avanza también la DB.
Dos guardas imprescindibles:

- **Solo si nadie dirige** (`Date.now() - ultimoProgresoAt > 15000`). Con un panel
  reportando posición, él pide el avance; si lo pidiesen los dos se saltaría una canción.
- **No desde `startBroadcast`**: ahí el avance ya está en curso y se entraría en
  recursión (`advanceQueue → startBroadcast → enterBridge → advanceQueue`). Por eso
  `enterBridge(esperado, avanzarDb)` recibe el flag y solo `bcastTick` pasa `true`.

Además `finishBridge` ya no pone `emittedMs = 0`: conserva los ms que sonaron dentro
de la mezcla (y atrasa `clockStart` lo mismo, para no alterar el ritmo de emisión),
si no el puente siguiente disparaba tarde.

A/B con AutoDJ y **cero navegadores**, 4 canciones: desfase máximo **33,4 s → 0,0 s**.

### Precarga de la siguiente canción (CLAVE para el solapamiento)

Para que el crossfade SOLAPE de verdad, la siguiente canción debe estar bufferada **antes** de empezar el fade. `preloadNext()` (en `handleTimeUpdate`, ~90s antes del final) la carga en el elemento `<audio>` inactivo:

- **Modo cola**: la siguiente es `queue[0]`, conocida en el cliente → precarga directa.
- **Modo AutoDJ**: la cola está vacía, la siguiente la decide el servidor. El cliente emite `socket.emit('player:peek-next', cb)` → el servidor pre-elige y **memoiza** la canción en `pendingAutoDJ` (sin avanzar) y la devuelve. `advanceQueue` luego reproduce **exactamente esa misma** canción (consume `pendingAutoDJ`). Sin esto, en AutoDJ la canción se cargaba recién en el pre-trigger (5s antes del final) → no daba tiempo a bufear → **corte seco** (bug corregido 2026-06-05).

`pendingAutoDJ` se invalida al consumirla, al entrar canciones en la cola, y al terminar la sesión.

### Detalles importantes

- **Espera `canplay`** antes de empezar el fade — sin esto, los primeros segundos del crossfade son silencio mientras el navegador buferea
- **`doImmediateSwitch`** (skip / silencio) usa el elemento ya precargado si la canción coincide (flip de `activeRef`, sin recargar) → switch **gapless**
- **Mutex `advancingRef.current`** (PlayerView) — previene doble avance. Se libera automáticamente tras 5s si el callback nunca llega
- **`crossfadeMsRef.current`** se actualiza dinámicamente al recibir `player:crossfade-config`
- Pre-trigger calculado como `crossfadeMs/1000 + 1` segundos antes del final
- `handleEnded(false, true)` (fromSilence=true) → switch inmediato, no crossfade

---

## Sincronización background → foreground (✅ Implementado 2026-06-01)

En móvil, cuando la pestaña/PWA está en background:
- Los timers JS (`setInterval`, `setTimeout`, `rAF`) se throttean a >1s
- El socket.io puede desconectarse
- El pre-trigger nunca dispara
- Si la canción acaba: `handleEnded` llama `socket.emit('auto-next', cb)` pero el callback nunca llega (socket desconectado), `advancingRef.current` queda en `true` para siempre
- El servidor avanza por su lado (`scheduleSongEnd` safety) y emite `player:update`, pero el cliente lo IGNORA por el mutex
- Resultado: el audio se queda parado, solo arranca cuando el usuario vuelve a foreground

### Mecanismos de recuperación

1. **Liberación del mutex obsoleto**: `player:update` no se ignora si `advancingRef` lleva > 3 segundos pegado
2. **`syncWithServer()`** en PlayerView y `onAdminVisibility()` en UnifiedView:
   - Llamado en `visibilitychange` (back to foreground), `socket.on('connect')`, y desde el guard/onEnded cuando un avance no recibe respuesta
   - Hace `fetch /api/now-playing` (HTTP, **independiente del socket**)
   - Si el src actual del audio ≠ desired: `doImmediateSwitch(song)`
   - Si es igual pero pausado: reintenta `play()`
3. **Server safety timer** (`scheduleSongEnd`): el servidor avanza la cola 2 segundos después del final esperado de la canción si nadie ha pedido `next`. Esto garantiza que `nowPlaying` esté siempre actualizado en el servidor independientemente del estado del cliente.
4. **Guard timeout en `handleEnded`** (6s): si el ACK del socket o la respuesta HTTP no llega, libera `advancingRef` Y llama `syncWithServer()` para recuperar activamente (no basta soltar el mutex).
5. **`handleAudioEnded`**: si la canción termina con un avance en curso pero SIN crossfade iniciado (ACK perdido), recupera vía `syncWithServer()` de inmediato.

### Stall por ACK de socket perdido (⚠️ causa raíz del "a veces no avanza")

El avance automático usa `socket.emit('player:auto-next', {}, cb)` (ack sin timeout). Si el ACK se pierde (wifi saturado, socket reconectando) PERO el servidor SÍ avanzó (y su `player:update` fue ignorado por el mutex `advancingRef`), el reproductor se quedaba parado hasta que el usuario interactuaba. **NO confiar solo en el ACK**: el guard de 6s y `handleAudioEnded` ahora recuperan vía `syncWithServer()` (fetch HTTP, no depende del socket). Verificado con E2E bloqueando `socket.io` por CDP.

### Anti doble-avance en servidor

`advanceQueue({ auto })`: los avances **automáticos** (`player:auto-next` socket + `scheduleSongEnd`) se debouncean 2s para que un solo fin de canción no dispare dos avances (pre-trigger del cliente + safety timer, o varios clientes → saltaría una canción). El **skip explícito** del DJ (`POST /api/player/next`) NO se debouncea. `advanceInFlight` cubre además la carrera del `await` a Navidrome en la rama AutoDJ.

### Bug del doble crossfade (corregido)

En `doCrossfade`, el fallback de 1.5s podía llamar `startPlay()` dos veces si `next.play()` resolvía lento → dos `setInterval` compitiendo (uno se filtraba). Corregido con flag `started` idempotente. La condición vieja `!crossfadeTimer.current` era defectuosa; usar un flag local, no el handle del timer.

### Verificado con test E2E

Test simula:
1. Pestaña en foreground → reproduce canción A
2. Marca `document.hidden = true` + `Emulation.setHiddenAndMuted`
3. POST `/api/player/next` (simula safety timer del servidor)
4. Marca pestaña como visible
5. Verifica que `audio.src` se actualizó a la nueva canción Y que `paused === false`

Resultado: ✅ AFTER WAKE: src changed to new song / audio is PLAYING

---

## Transiciones sin silencio en `/api/live` (✅ 2026-08-07)

Los voters oían ~2-3 s de silencio en **cada** cambio de canción. No era un problema de red ni del cliente.

**Causa dominante — el tag ID3v2.** El 99,6% de las canciones lleva carátula incrustada (45 KB de media). El broadcast emite a ritmo de reproducción (`bcastBPS ≈ 17 KB/s`), así que transmitir el tag gastaba **2,82 s de media** (mediana 2,55 s; **peor caso 15,95 s** con un tag de 263 KB) sin entregar un solo frame de audio. El admin no lo sufre: su navegador descarga el fichero entero a toda velocidad y salta el tag al instante.

**Causas secundarias.** `startBroadcast` paraba el ticker y vaciaba la cola *antes* de la petición asíncrona a Navidrome; y el corte por número de bytes partía frames, provocando `Header missing` en cada transición.

### Motor actual
| Pieza | Función |
|---|---|
| `findAudioStart` | Salta el ID3v2 por longitud declarada y luego busca el sync |
| `makeSink`/`sinkFeed` | Acumulador que descarta todo lo previo al primer frame |
| `openSource` | Abre un stream de Navidrome hacia un sink, sin tocar la emisión |
| `prefetchBroadcast` | Descarga la siguiente canción por adelantado (desde `peek-next` y tras cada avance) |
| `frameAlignedCut` | Emite siempre frames completos → el empalme nunca parte una trama |

El ticker **ya no se para** en los cambios de canción, y `bcastBPS` se calcula sobre bytes de audio (sin el tag).

### Cómo medirlo (importante)
`silencedetect` sobre una captura **NO sirve**: el tag no es audio, ffmpeg lo salta al abrir el fichero y se pierde la información de temporización. La métrica correcta es **segundos de audio entregados por segundo de reloj**, parseando los frames según llegan; si cae a ~0, eso es el silencio real.

Verificado A/B con dos instancias aisladas y misma carga (5 transiciones forzadas):

| | Antes | Después |
|---|---|---|
| Ventanas de hambre (<0,35 s audio/s) | **9** (las 9 junto a un cambio) | **0** |
| Bytes que no eran audio | 9,8% | **0%** |
| Errores de decodificación | `Header missing` | **ninguno** |

También se arregló una **fuga en el reproductor voter con MSE** (`UnifiedView.jsx`): el bucle nunca llamaba a `sb.remove()`, así que el `SourceBuffer` crecía sin límite y al agotar la cuota el `catch` silenciaba el error y el stream moría solo. Afecta a Android/Chrome; iPhone Safari no implementa `MediaSource` y usa la rama alternativa.

---

## Historial de cambios relevantes

| Fecha | Cambio |
|-------|--------|
| 2026-08-15 | **Sin panel conectado, la emisión y la app se separaban** — el puente movía el audio pero `nowPlaying` esperaba a la red de seguridad (`duración + 2`); el desfase se acumulaba (medido en producción: 0 → 35 → 40 → 64 s) y acababa preparando la mezcla hacia una canción ya sonada: corte antes de tiempo y repeticiones. Descubierto al ver que en una sesión de 6,5 h **96 de 97 avances los pidió el temporizador de seguridad**, no el panel. A/B con AutoDJ y cero navegadores: **33,4 s → 0,0 s**. |
| 2026-08-16 | **Un solo dispositivo al mando + cierre por inactividad** — cualquier número de admins podía reproducir a la vez (dos paneles = dos avances simultáneos = canción saltada) y una fiesta podía quedarse abierta indefinidamente. Nuevo concepto de **mando** con traspaso explícito, caducidad por latido de 30 s y rechazo en servidor de las órdenes de quien no lo tiene. Cierre por inactividad (120 min por defecto) que **distingue una fiesta con el altavoz puesto de una sesión olvidada**. ⚠️ Dos hallazgos al probar: `resetRuntimeState()` borraba el mando justo al iniciar la fiesta, y el avance automático de la mezcla hay que distinguirlo del skip a mano o se rompe `RemoteView`. |
| 2026-08-15 | **Crossfade del panel arreglado de raíz** — dos fallos: (a) el bucle del fundido moría en su primer fotograma por un `IndexSizeError` al asignar un volumen > 1 (`rAF` entrega la marca del fotograma, que puede ser anterior a `t0` → `p` negativo); (b) el panel **no precargaba** la siguiente canción y la cargaba en el instante de la mezcla, 3 s antes del final. Verificado en Chromium con red estrangulada sobre transiciones reales, 4 casos (entrante normal, con 7,9 s de silencio inicial, con 1 s, y AutoDJ): **2,8 s de solape real y 0,00 s de silencio en los cuatro**. ⚠️ El primero solo se encontró **capturando `pageerror` de la página** en el test. |
| 2026-08-11 | **Silencio inicial recortado en TODO arranque** — el recorte solo se aplicaba dentro de una transición, así que la primera canción de la sesión, un skip del DJ o una recarga del panel emitían el silencio entero. Censo: **44% de la biblioteca empieza con algo de silencio, 13% con 1 s o más**. A/B sobre "Fantasy Girl" arrancando en seco: **17 ventanas mudas de 0,5 s → 0**. |
| 2026-08-11 | **Regla de mezcla única: solapar 3 s, sin mandos** — se quitan los dos sliders de silencio (y el de duración del crossfade, que la contradecía). El servidor calcula por canción dónde entra la siguiente según su final (seco / silencio de cola / fundido) y lo manda como `mixStartMs`; sala, `/player` y móviles usan el mismo punto. ⚠️ Dos hallazgos: `astats` imprime **por frame**, no por ventana (había que agrupar con `asetnsamples`), y **7 de cada 20 canciones empiezan con silencio** (la peor 7,9 s) — sin recortarlo el solape terminaba en −93,5 dB. Verificado sobre **60 canciones** de la biblioteca real (17 secas, 16 con cola muda, 27 con fundido): el solape cae siempre sobre música. |
| 2026-08-09 | **Acceso con cuenta de Google** — botón junto al formulario de siempre, que sigue funcionando. Flujo de *ID token*: el servidor verifica el JWT con `google-auth-library` (firma, emisor y audiencia); **no hay client secret que custodiar**. Se exige `email_verified`. Alta automática al primer acceso, vinculando por email si la cuenta ya existía. ⚠️ `password_hash` es NOT NULL y SQLite no deja quitarlo sin reconstruir la tabla: las cuentas de Google guardan un centinela `google:<aleatorio>` y el login por contraseña **rechaza explícitamente** lo que no empiece por `$2`. Todo inactivo si falta `GOOGLE_CLIENT_ID`. |
| 2026-08-09 | **`bcrypt` nativo** — 60 logins simultáneos dejaban ~4,75 s sin audio a todos los oyentes (bcrypt bloquea el hilo que emite). ⚠️ Pasar de `compareSync` a `compare` NO arregla nada: `bcryptjs` es JS puro y su API asíncrona solo trocea el trabajo en el mismo hilo. El fix es `bcrypt` nativo, que usa el threadpool de libuv. Retraso máximo del emisor: 5347 ms → **2 ms**. `bcryptjs` queda como respaldo; los hashes son compatibles en ambos sentidos. |
| 2026-08-09 | **Ritmo del broadcast por ms de audio, no por bytes** — `bcastBPS = fileSize/duration` se desviaba con VBR y despachaba 110 s de audio en ~85 s, dejando ~25 s mudos antes de cada cambio. ⚠️ No lo detecté antes porque las pruebas usaban avances forzados y ninguna canción llegaba a agotarse: **al probar el motor, dejar que la canción termine sola**. |
| 2026-08-09 | **Crossfade de servidor con detección del final audible** — `silencedetect` NO sirve para esto (exige nivel bajo *continuo*, y un fade con golpes sueltos lo resetea). Se usa RMS por ventana de ~1 s buscando la última que supere la media −12 dB. Solapamiento mínimo 3 s. Interruptor en caliente: `POST /api/player/server-crossfade`. |
| 2026-08-07 | **Audio del voter en segundo plano + crossfade de servidor** — (a) el oyente vivía con ~1,5 s de colchón porque el motor emite a tiempo real exacto: al pasar el móvil a segundo plano se quedaba sin datos y la música moría. `JOIN_BUF_SECS` 1,5 → 6 (medido: arranca con 6,98 s en buffer). (b) El handler de `visibilitychange` estaba restringido a admin, así que nadie reanudaba el stream del votante al volver; ahora hay recuperación propia + vigilante de atascos cada 3 s. (c) **Crossfade real para voters** vía ffmpeg (`afade`+`amix`, NO `acrossfade`) con recorte del silencio de cola por `silencedetect`. |
| 2026-08-07 | **Login colgado y audio mudo en iPhone** — `resyncAll` salía antes de pedir `/api/session/status` para los no-admin, y el render se bloquea con `sessionActive === null`: spinner eterno en móvil. Además la rama iOS creaba un `AudioContext` justo antes de `play()`, lo que cambia la categoría de sesión de audio del sistema y deja el `<audio>` mudo. |
| 2026-08-07 | **`/api/admin/log` nunca funcionó** — estaba declarado DESPUÉS del catch-all `app.get('*')`, así que devolvía `index.html`. Express casa por orden de registro. Movido arriba. |
| 2026-08-07 | **Transiciones sin silencio en el stream de voters** — causa: los tags ID3v2 (45 KB de media) se transmitían a ritmo de reproducción, gastando 2,82 s de media por canción. Ahora se saltan; además precarga de la siguiente canción, ticker que no se detiene y emisión alineada a frame. + fix de la fuga de MSE en el voter. Verificado A/B: 9 → 0 ventanas de silencio. |
| 2026-08-07 | **Seguridad P0** — producción no definía `JWT_SECRET`, así que usaba el fallback hardcodeado de `auth.js`, publicado en el repo (público) y con el sitio expuesto a Internet; el admin conservaba la contraseña por defecto `admin`/`admin` y Socket.IO aceptaba `origin: '*'`. Corregido: secreto obligatorio (aborta si falta), `ALLOWED_ORIGIN` por lista, seed de admin desde `ADMIN_PASSWORD`. |
| 2026-08-07 | **Fix del join buffer para late joiners** — el buffer rodante empezaba a media trama y el decodificador no sincronizaba: quien entraba a mitad de canción no oía nada hasta el siguiente tema. `parseMp3Header`/`findMp3FrameStart` (Layer III + encadenado de 2 frames para descartar falsos positivos). |
| 2026-08-07 | **Fix de la posición en el voter** — al pulsar Escuchar, el `<audio>` cargaba `/api/live` (currentTime desde 0, duration Infinity) y `handleTimeUpdate` emitía eso por `player:progress`, sobrescribiendo `lastProgress` global y corrompiendo la posición de la sesión para todos. Ahora el voter no emite y toma la posición del servidor. |
| 2026-06-07 | **Robustez de sesión en eventos largos** — `resetRuntimeState()` en inicio/fin de sesión (servidor), heartbeat cada 10s, watchdog de auto-recuperación en el panel admin (`resyncAll` en reconexión/foreground; recarga con backoff si el socket lleva >60s muerto), trim de chat a 100, `bcastGen`+timeout en broadcast. Solo admin; PlayerView intacto. Verificado E2E. |
| 2026-06-05 | **Fix crossfade en AutoDJ (corte seco → solapamiento real)** — la siguiente canción de AutoDJ no se precargaba (la cola está vacía y se decidía en el último momento). Nuevo `pickAutoDJSong()` + `pendingAutoDJ` + socket `player:peek-next`: el cliente consulta la siguiente ~90s antes y la precarga; `advanceQueue` reproduce esa misma. `doImmediateSwitch` usa el preload (silencio/skip gapless). Verificado con 3 E2E (solapamiento 4s real, silencio→cambio, preload readyState 4). |
| 2026-06-03 | **Fix stall intermitente "a veces no avanza"** — causa raíz: ACK de `player:auto-next` perdido dejaba el reproductor parado (el `player:update` del servidor era ignorado por el mutex y nada re-disparaba). Ahora el guard (6s) y `handleAudioEnded` recuperan vía `syncWithServer()`. + fix doble-crossfade en `doCrossfade` (flag `started`) + debounce 2s anti doble-avance para avances automáticos en `advanceQueue({auto})`. Verificado con 3 tests E2E en Chromium. |
| 2026-06-01 | **Crossfade VERIFICADO funcionando** — fix de background sync (cliente recupera estado tras volver de background), eliminado servicio duplicado `jukevote.service` (queda solo `turiadj.service`), `scheduleSongEnd` safety reducido de +8s a +2s |
| 2026-06-01 | Crossfade configurable 1–10s (default 4s) — slider en RemoteView y panel admin Control, `POST /api/player/crossfade-config`, persistido en `state.crossfade_ms` |
| 2026-06-01 | Botón "Borrar caché y recargar" en pestaña Sesión del panel admin |
| 2026-06-01 | `Cache-Control: no-store` en `/` e `/index.html` para que el navegador siempre cargue el JS más reciente (los assets con hash siguen cacheándose normalmente) |
| 2026-05-24 | PlayerView: PV-001–004 — MediaSession API, precarga, config silencio en RemoteView, recovery AudioContext |
| 2026-05-24 | PlayerView: crossfader 3s + detección de silencio + fix background/foreground |
| 2026-05-24 | Auditoría de seguridad completa — 20 hallazgos documentados en audit-report.md |
| (previo) | feat: confirmación antes de descarga Spooty |
| (previo) | feat: Spooty notifica cuando canción está disponible en Navidrome |
