import crypto from 'crypto';
import { redisGet, redisSet, isRedisEnabled } from '../../config/redis';

// Revoked token store prefix (storing SHA-256 hashes of tokens, never raw tokens)
const REVOKED_TOKEN_PREFIX = 'cicr:revoked_token:';
const DEFAULT_REVOKE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days (matching standard JWT lifespan)

// In-memory fallback set for instant synchronous / offline checks
const memoryRevokedHashes = new Map<string, number>();

/**
 * Computes a secure SHA-256 hash of a JWT or bearer token.
 * Tokens are NEVER stored in plaintext in the revocation store.
 */
export const hashToken = (rawToken: string): string => {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
};

/**
 * Revokes a token by adding its SHA-256 hash to the revocation blocklist.
 */
export const revokeToken = async (rawToken: string, ttlSeconds = DEFAULT_REVOKE_TTL_SECONDS): Promise<void> => {
  if (!rawToken || typeof rawToken !== 'string') return;
  const hash = hashToken(rawToken);
  const key = `${REVOKED_TOKEN_PREFIX}${hash}`;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 1. Update in-memory map
  memoryRevokedHashes.set(hash, expiresAt);

  // 2. Persist to Redis if available
  if (isRedisEnabled) {
    try {
      await redisSet(key, 'revoked', ttlSeconds);
    } catch (err) {
      console.warn('[SECURITY] Failed to write revoked token to Redis, using in-memory store:', err);
    }
  }
};

/**
 * Checks whether a token has been revoked by verifying its SHA-256 hash.
 */
export const isTokenRevoked = async (rawToken: string): Promise<boolean> => {
  if (!rawToken || typeof rawToken !== 'string') return true;
  const hash = hashToken(rawToken);
  const key = `${REVOKED_TOKEN_PREFIX}${hash}`;

  // 1. Check in-memory first
  const memoryExpiresAt = memoryRevokedHashes.get(hash);
  if (memoryExpiresAt) {
    if (Date.now() < memoryExpiresAt) {
      return true;
    } else {
      memoryRevokedHashes.delete(hash);
    }
  }

  // 2. Check Redis if enabled
  if (isRedisEnabled) {
    try {
      const val = await redisGet(key);
      if (val === 'revoked') {
        memoryRevokedHashes.set(hash, Date.now() + 3600 * 1000);
        return true;
      }
    } catch {
      // Degrade to memory check
    }
  }

  return false;
};

// Periodic cleanup of expired entries in memory map
setInterval(() => {
  const now = Date.now();
  for (const [hash, expiresAt] of memoryRevokedHashes) {
    if (now >= expiresAt) {
      memoryRevokedHashes.delete(hash);
    }
  }
}, 5 * 60 * 1000).unref();
