-- ============ 009_add_token_version_to_users.sql ============
-- H-3: server-side JWT invalidation via token_version.
-- Every password change, role change, or equivalent security event assigns a
-- fresh token_version; authenticateToken rejects JWTs whose tv claim does not
-- match the row. Deleted users have no row, so their tokens fail closed.
--
-- Run this manually in BOTH Supabase (SQL Editor) and Neon, then restart all
-- backend instances. Code that reads token_version must be deployed only
-- after this column exists on both databases (middleware fails closed when
-- the lookup errors).

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
