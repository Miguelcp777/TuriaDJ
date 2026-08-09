const jwt = require('jsonwebtoken');

// `bcrypt` nativo hace el trabajo en el threadpool de libuv, FUERA del hilo
// principal. `bcryptjs` es JavaScript puro: aunque su API sea asincrona, calcula
// en el mismo hilo que emite el audio del broadcast. Medido con 60 logins
// simultaneos, retraso maximo del emisor: bcryptjs 5347 ms  vs  nativo 2 ms.
// Los hashes son compatibles entre ambos ($2a$/$2b$), asi que el respaldo no
// invalida ninguna contrasena si el modulo nativo no carga.
let bcrypt, bcryptImpl;
try { bcrypt = require('bcrypt');   bcryptImpl = 'nativo'; }
catch (e) { bcrypt = require('bcryptjs'); bcryptImpl = 'bcryptjs (respaldo JS puro)';
            console.warn('AVISO: bcrypt nativo no disponible, usando bcryptjs. ' +
                         'Una avalancha de logins puede cortar el audio.'); }

// Sin fallback: un valor por defecto en un repo publico permite falsificar
// tokens de admin contra cualquier despliegue que no defina la variable.
// Preferimos que el servidor no arranque a que arranque inseguro.
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET no definido (o < 32 caracteres). Define JWT_SECRET en .env.');
  process.exit(1);
}

// ASINCRONAS a proposito. Las versiones *Sync de bcrypt bloquean el unico hilo
// de Node durante ~88 ms por operacion, y ese mismo hilo es el que emite el
// audio del broadcast cada 50 ms. Medido: 60 logins simultaneos dejaban ~4,75 s
// sin audio a TODOS los oyentes — el escenario tipico de una fiesta, cuando
// llega la gente y abre la app a la vez. La variante asincrona de bcryptjs
// trocea el trabajo y cede el control entre rondas, asi que el audio no se para.
const hashPassword   = (pw)    => bcrypt.hash(pw, 10);
const verifyPassword = (pw, h) => bcrypt.compare(pw, h);
// Solo para el arranque (seed del admin), antes de aceptar conexiones: ahi
// bloquear es inofensivo y simplifica el orden de inicializacion.
const hashPasswordSync = (pw)  => bcrypt.hashSync(pw, 10);
const signToken      = (user)  => jwt.sign(
  { id: user.id, username: user.username, role: user.role },
  SECRET, { expiresIn: '30d' }
);
const verifyToken = (token) => { try { return jwt.verify(token, SECRET); } catch { return null; } };

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Sesion expirada' });
  req.user = payload;
  next();
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

module.exports = { hashPassword, hashPasswordSync, verifyPassword, signToken, verifyToken, authMiddleware, adminMiddleware, bcryptImpl };
