const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

// Sin fallback: un valor por defecto en un repo publico permite falsificar
// tokens de admin contra cualquier despliegue que no defina la variable.
// Preferimos que el servidor no arranque a que arranque inseguro.
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET no definido (o < 32 caracteres). Define JWT_SECRET en .env.');
  process.exit(1);
}

const hashPassword   = (pw)   => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, h) => bcrypt.compareSync(pw, h);
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

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authMiddleware, adminMiddleware };
