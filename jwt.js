import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_this_in_production_min_32_chars';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

export function generateToken(user) {
  try {
    const token = jwt.sign(
      {
        id: user.id,
        userId: user.id,
        email: user.email,
        username: user.username
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );
    return token;
  } catch (error) {
    throw new Error(`Token generation failed: ${error.message}`);
  }
}

export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    }
    throw new Error('Invalid token');
  }
}

export function decodeToken(token) {
  try {
    const decoded = jwt.decode(token);
    return decoded;
  } catch (error) {
    throw new Error('Token decode failed');
  }
}

export const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ 
        error: 'Access denied. No token provided.',
        code: 'MISSING_TOKEN'
      });
    }

    const decoded = verifyToken(token);
    
    req.user = decoded; 
    req.userId = decoded.userId || decoded.id; // Sets req.userId so auth.js routes find the user
    
    next();
  } catch (error) {
    return res.status(403).json({ 
      error: error.message,
      code: 'INVALID_TOKEN'
    });
  }
};
