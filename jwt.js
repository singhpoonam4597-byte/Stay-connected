import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_this_in_production_min_32_chars';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

export function generateToken(user) {
  try {
    const token = jwt.sign(
      {
        id: user.id,
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
