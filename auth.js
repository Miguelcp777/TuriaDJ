const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const SECRET = process.env.JWT_SECRET || 'turiaDJ-falla-2025-secret';

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
