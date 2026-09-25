import jwt from 'jsonwebtoken';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return secret;
}

const JWT_EXPIRY = process.env.JWT_EXPIRY || '15m';

export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username,
    },
    getSecret(),
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    }
    throw new Error('Invalid token');
  }
}

export function decodeToken(token) {
  return jwt.decode(token);
}

/** Express middleware — used by routes and server.js */
export function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Access token required',
        code: 'NO_TOKEN',
      });
    }

    jwt.verify(token, getSecret(), (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({
            error: 'Token has expired',
            code: 'TOKEN_EXPIRED',
          });
        }
        return res.status(403).json({
          error: 'Invalid or malformed token',
          code: 'INVALID_TOKEN',
        });
      }

      req.user = decoded;
      req.userId = decoded.id;
      next();
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Authentication error',
      code: 'AUTH_ERROR',
    });
  }
}
