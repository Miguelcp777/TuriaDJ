# TuriaDJ 🎵

Jukebox democrático para **Falla Turia · Plaça de l'Ajuntament**.  
Los asistentes votan las canciones desde sus móviles; el DJ controla la sesión desde un panel de administración.

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Node.js 22 · Express · Socket.IO · better-sqlite3 |
| Frontend | React 18 · Vite · Tailwind CSS v3 · Lucide icons |
| Música | Navidrome (API Subsonic) |
| Auth | JWT · bcryptjs |
| Deploy | systemd · Ubuntu |

## Características

- **Sesiones DJ** — el admin abre/cierra sesiones con nombre y descripción; link copiable para compartir
- **Cola democrática** — más votos = antes suena; empates se rompen por orden de voto
- **Crossfade** — mezcla de 4 segundos entre canciones (admin)
- **Panel de admin** — gestión de usuarios, roles, rate-limit (máx. 2 canciones / 4 min por usuario)
- **Tiempo real** — actualizaciones vía WebSocket para todos los clientes
- **Autenticación** — registro/login; solo el admin controla la reproducción

## Instalación

```bash
# 1. Clonar
git clone https://github.com/Miguelcp777/TuriaDJ.git
cd TuriaDJ

# 2. Variables de entorno
cp .env.example .env
# Editar .env con tus credenciales de Navidrome y un JWT_SECRET

# 3. Dependencias backend
npm install

# 4. Dependencias y build del frontend
cd client && npm install && npm run build && cd ..

# 5. Arrancar
node server.js
```

Accede en `http://localhost:3001`

**Credenciales por defecto:** `admin` / `admin`  
*(Cámbialas en producción)*

## Despliegue con systemd

```ini
[Unit]
Description=TuriaDJ
After=network.target

[Service]
WorkingDirectory=/opt/jukevote
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=/opt/jukevote/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now jukevote
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `NAVIDROME_URL` | URL base de tu instancia Navidrome |
| `NAVIDROME_USER` | Usuario de servicio en Navidrome |
| `NAVIDROME_PASS` | Contraseña del usuario de servicio |
| `JWT_SECRET` | Secreto para firmar tokens JWT |
| `PORT` | Puerto del servidor (por defecto 3001) |
| `DATA_DIR` | Directorio para la base de datos SQLite |
