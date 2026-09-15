// Database routing policy (v2.4.0).
//
// Supabase = authoritative PRIMARY for all application CRUD.
// Neon     = SECONDARY / DR for:
//              - borrow_records (atomic multi-statement operations)
//              - replicated tables while the primary is unavailable (failover)
//
// Health-aware rule:
//   When the PRIMARY is unavailable, SELECTs and writes for the replicated
//   tables are routed to Neon. Writes are additionally recorded in the durable
//   pending-change queue (handled in database.ts) for reconciliation.
//   There is NO dual-write: a given operation targets exactly one database.
import { isSupabaseConfigured } from './supabasePool';
import { isNeonConfigured } from './neonPool';
import { isPrimaryAvailable } from './dbHealth';
import { QueryFilter, QueryOperation } from './databaseTypes';

// Tables that route to Supabase PostgREST (PRIMARY)
export const SUPABASE_PRIMARY_TABLES = new Set([
  'users',
  'inventory',
  'audit_logs',
  'hardware_requests',
  'borrow_records',
]);

// Tables replicated Supabase → Neon and eligible for failover routing.
export const SUPABASE_REPLICATED_TABLES = new Set([
  'users',
  'inventory',
  'audit_logs',
  'borrow_records',
]);

// Tables that require Neon for atomic multi-table operations.
// When Supabase is healthy, all tables use Supabase primary; if Supabase fails,
// they automatically fail over to Neon secondary.
export const NEON_ATOMIC_TABLES = new Set<string>([
]);

// Filter operations that the Supabase PostgREST helper (supabaseQuery) can apply
// to UPDATE/DELETE statements. Used so a single conditional UPDATE (e.g. the
// atomic inventory stock decrement) stays on one consistent database path.
const SUPABASE_UPDATE_DELETE_FILTERS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'ilike',
  'is_null',
]);

// Check if a table should route to Supabase under the current health state.
export function routeToSupabase(table: string): boolean {
  if (!isSupabaseConfigured()) return false;
  if (NEON_ATOMIC_TABLES.has(table)) return false;
  if (!SUPABASE_PRIMARY_TABLES.has(table)) return false;

  // Health-aware failover: replicated tables fall back to Neon while the
  // primary is unavailable. Non-replicated tables keep targeting Supabase.
  if (!isPrimaryAvailable() && SUPABASE_REPLICATED_TABLES.has(table)) return false;

  return true;
}

// Check if a table should route to Neon.
export function routeToNeon(table: string): boolean {
  if (!isNeonConfigured()) return false;
  if (NEON_ATOMIC_TABLES.has(table)) return true;
  return !isPrimaryAvailable() && SUPABASE_REPLICATED_TABLES.has(table);
}

// Check if an operation can use Supabase directly.
export function canUseSupabaseDirect(
  table: string,
  operation: QueryOperation,
  filters: QueryFilter[]
): boolean {
  if (!routeToSupabase(table)) return false;

  // For UPDATE/DELETE on Supabase tables, only filters supported by supabaseQuery
  // are allowed. This keeps conditional writes (e.g. the atomic stock decrement)
  // on the primary instead of silently splitting them onto Neon.
  if (operation === 'update' || operation === 'delete') {
    const hasUnsupportedFilter = filters.some((f) => !SUPABASE_UPDATE_DELETE_FILTERS.has(f.type));
    if (hasUnsupportedFilter) return false;
  }

  return true;
}

// Get the database target for a table under the current health state.
export type DatabaseTarget = 'supabase' | 'neon' | 'none';

export function getDatabaseTarget(table: string): DatabaseTarget {
  if (routeToSupabase(table)) return 'supabase';
  if (routeToNeon(table)) return 'neon';
  return 'none';
}
