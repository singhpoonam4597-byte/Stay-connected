/** Auth domain — re-exports (API paths unchanged) */
export { default as authRoutes } from '../../authRoutes.js';
export {
  authenticateToken,
  generateToken,
  verifyToken,
  decodeToken,
} from '../../jwt.js';
export { hashPassword, verifyPassword } from '../../passwords.js';
