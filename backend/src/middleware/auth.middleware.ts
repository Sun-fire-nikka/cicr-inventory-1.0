// Authentication & authorization middleware (v1.5.0).
//
// Authentication is JWT-first (Bearer) with a Redis-backed express-session
// cookie fallback:
//   1. A Bearer JWT is verified with strict claim validation (exp handled by
//      jsonwebtoken, role restricted to ADMIN|MEMBER, optional iss/aud checked
//      when JWT_ISSUER / JWT_AUDIENCE are configured).
//   2. If no Bearer token is present, the signed session cookie
//      (express-session + connect-redis) is trusted — req.session.user is the
//      same AuthUser shape the JWT carries.
//
// Authorization is role-based (RBAC): `requireRole('ADMIN')` / `requireAdmin`
// for admin endpoints, `requireRole('ADMIN','MEMBER')` for member endpoints.
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { dbRead } from '../config/database';
import { isTokenRevoked } from '../modules/auth/tokenRevocationService';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  roll_number?: string | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

declare module 'express-session' {
  interface SessionData {
    user?: AuthUser;
  }
}

const VALID_ROLES: AuthUser['role'][] = ['ADMIN', 'MEMBER'];

const parseJwtUser = (decoded: unknown): AuthUser | null => {
  if (!decoded || typeof decoded !== 'object') return null;
  const d = decoded as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.email !== 'string') return null;
  if (d.role !== 'ADMIN' && d.role !== 'MEMBER') return null;
  return {
    id: d.id,
    name: typeof d.name === 'string' ? d.name : 'User',
    email: d.email,
    role: d.role,
    roll_number: typeof d.roll_number === 'string' ? d.roll_number : null
  };
};

const parseTokenVersion = (decoded: unknown): number | null => {
  if (!decoded || typeof decoded !== 'object') return null;
  const tv = (decoded as Record<string, unknown>).tv;
  if (typeof tv !== 'number' || !Number.isInteger(tv) || tv <= 0) return null;
  return tv;
};

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    // Check if token has been revoked via SHA-256 hash blocklist
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ status: 'error', message: 'Token has been revoked. Please sign in again.' });
    }

    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        console.error('FATAL: JWT_SECRET environment variable is not set.');
        return res.status(500).json({ status: 'error', message: 'Server misconfiguration.' });
      }
      const options: jwt.VerifyOptions = {};
      if (process.env.JWT_ISSUER) options.issuer = process.env.JWT_ISSUER;
      if (process.env.JWT_AUDIENCE) options.audience = process.env.JWT_AUDIENCE;

      const decoded = jwt.verify(token, secret, options);
      const user = parseJwtUser(decoded);
      if (!user) {
        return res.status(403).json({ status: 'error', message: 'Invalid token claims.' });
      }
      // H-3: tokens without a valid tv claim are rejected (forces re-login).
      const tv = parseTokenVersion(decoded);
      if (tv === null) {
        return res.status(403).json({ status: 'error', message: 'Invalid or expired token.' });
      }

      // H-3: server-side token-version check. The DB router covers Supabase
      // primary / Neon failover. Fail closed on lookup error.
      try {
        const { data, error } = await dbRead
          .from('users')
          .select('id, token_version')
          .eq('id', user.id)
          .single();

        if (error && (error.code === '42703' || String(error.message).includes('token_version does not exist'))) {
          // Schema does not yet have token_version column -> fallback to user existence check
          const fallback = await dbRead
            .from('users')
            .select('id')
            .eq('id', user.id)
            .single();

          if (fallback.error || !fallback.data) {
            return res.status(401).json({ status: 'error', message: 'Access denied. User no longer exists.' });
          }
        } else if (error || !data) {
          return res.status(401).json({ status: 'error', message: 'Access denied. User no longer exists.' });
        } else {
          const recordVersion =
            typeof (data as any).token_version === 'number' &&
            Number.isInteger((data as any).token_version) &&
            (data as any).token_version > 0
              ? (data as any).token_version
              : 1;

          if (recordVersion !== tv) {
            return res.status(403).json({ status: 'error', message: 'Invalid or expired token.' });
          }
        }
      } catch {
        return res.status(503).json({ status: 'error', message: 'Authentication temporarily unavailable.' });
      }

      req.user = user;
      return next();
    } catch (err) {
      return res.status(403).json({ status: 'error', message: 'Invalid or expired token.' });
    }
  }

  // Redis cookie session fallback (express-session store).
  const sessionUser = req.session?.user;
  if (sessionUser && VALID_ROLES.includes(sessionUser.role)) {
    req.user = sessionUser;
    return next();
  }

  return res.status(401).json({ status: 'error', message: 'Access denied. Token missing.' });
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ status: 'error', message: 'Forbidden. Admin access required.' });
  }
  next();
};

// Strict RBAC: allow only the listed roles through.
export const requireRole =
  (...roles: AuthUser['role'][]) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden. Required role not satisfied.' });
    }
    next();
  };

// Invalidate any stale in-session user on the express-session store (used on
// logout). With Redis this deletes the session cookie server-side.
export const clearSessionUser = (req: Request): Promise<void> =>
  new Promise((resolve) => {
    try {
      req.session?.destroy(() => resolve());
    } catch {
      resolve();
    }
  });
