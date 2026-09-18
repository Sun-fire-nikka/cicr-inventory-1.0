-- Migration 008: Add avatar_url to users table
-- Version: v2.14.0
-- Adds avatar_url column to support user profile pictures with real-time backend synchronization

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
