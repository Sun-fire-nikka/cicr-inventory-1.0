// Shared runtime database health state (v2.0.0).
//
// Single source of truth for "is the Supabase PRIMARY usable right now?".
// Used by healthMonitor (publisher), databaseRouter (routing), system.controller.
//
// Multi-instance behavior:
//   - An in-process cache gives a synchronous fast path for routing.
//   - State is mirrored to Redis so multiple backend instances agree on
//     supabaseHealthy / simulatedOutage / recovering and therefore routing mode.
//   - Fail-safe: if Redis is unreachable the last known in-process state is kept.
//     We never flip to "healthy" merely because Redis failed. A transient Redis
//     outage can therefore never cause blind routing back to Supabase.
//
// Health is only flipped UNHEALTHY by the threshold-based health monitor, and
// only flipped back to HEALTHY after a successful reconciliation (see
// replication.performRecovery). A single transient failure never flips it.
import { redisClient } from './redis';

export type RoutingMode = 'primary' | 'secondary';

const KEY_HEALTHY = 'cicr:db:supabaseHealthy';
const KEY_SIMULATED = 'cicr:db:simulatedOutage';
const KEY_RECOVERING = 'cicr:db:recovering';

// In-process cache (fast path).
let realSupabaseHealthy = true;
let simulatedOutage = false;
let recovering = false;
let lastChangedAt = new Date().toISOString();

const boolToStr = (b: boolean): string => (b ? '1' : '0');

const publish = (key: string, value: boolean): void => {
  if (!redisClient) return;
  redisClient.set(key, boolToStr(value)).catch((err: any) => {
    console.warn('[DBHEALTH] Failed to publish shared state:', err?.message);
  });
};

// ------------------------------------------------------------ publishers
export const setSupabaseHealthy = (healthy: boolean): void => {
  if (realSupabaseHealthy !== healthy) lastChangedAt = new Date().toISOString();
  realSupabaseHealthy = healthy;
  publish(KEY_HEALTHY, healthy);
};

export const setSimulatedOutage = (active: boolean): void => {
  lastChangedAt = new Date().toISOString();
  simulatedOutage = active;
  publish(KEY_SIMULATED, active);
};

export const setRecovering = (active: boolean): void => {
  recovering = active;
  publish(KEY_RECOVERING, active);
};

// ------------------------------------------------------------ synchronous readers
export const isSupabaseHealthy = (): boolean => realSupabaseHealthy;
export const isSimulatedOutage = (): boolean => simulatedOutage;
export const isRecovering = (): boolean => recovering;

// PRIMARY is used only when genuinely healthy, not under simulated outage, and
// not mid-recovery (so we never resume PRIMARY before reconciliation finishes).
export const isPrimaryAvailable = (): boolean =>
  realSupabaseHealthy && !simulatedOutage && !recovering;

export const getRoutingMode = (): RoutingMode => (isPrimaryAvailable() ? 'primary' : 'secondary');

export interface DbHealthSnapshot {
  supabaseHealthy: boolean;
  simulatedOutage: boolean;
  recovering: boolean;
  primaryAvailable: boolean;
  routingMode: RoutingMode;
  lastChangedAt: string;
}

export const getDbHealthSnapshot = (): DbHealthSnapshot => ({
  supabaseHealthy: realSupabaseHealthy,
  simulatedOutage,
  recovering,
  primaryAvailable: isPrimaryAvailable(),
  routingMode: getRoutingMode(),
  lastChangedAt,
});

// ------------------------------------------------------------ shared-state sync
/**
 * Pull shared state from Redis into the in-process cache. On first run, missing
 * keys are seeded from the current cache. On Redis failure the cache is left
 * untouched (fail-safe).
 */
let hasLoggedDbHealthErr = false;

export async function refreshDbContext(): Promise<void> {
  if (!redisClient) return;
  try {
    const [h, s, r] = await Promise.all([
      redisClient.get(KEY_HEALTHY),
      redisClient.get(KEY_SIMULATED),
      redisClient.get(KEY_RECOVERING),
    ]);

    if (h === null) await redisClient.set(KEY_HEALTHY, boolToStr(realSupabaseHealthy));
    else realSupabaseHealthy = h === '1';

    if (s === null) await redisClient.set(KEY_SIMULATED, boolToStr(simulatedOutage));
    else simulatedOutage = s === '1';

    if (r === null) await redisClient.set(KEY_RECOVERING, boolToStr(recovering));
    else recovering = r === '1';
    hasLoggedDbHealthErr = false;
  } catch (err: any) {
    if (!hasLoggedDbHealthErr) {
      console.warn('[DBHEALTH] Shared-state refresh failed (keeping last known state):', err?.message);
      hasLoggedDbHealthErr = true;
    }
  }
}

let dbHealthTimer: ReturnType<typeof setInterval> | null = null;

export function startDbHealthSync(intervalMs = 5000): void {
  if (dbHealthTimer) return;
  refreshDbContext().catch(() => { /* logged inside */ });
  dbHealthTimer = setInterval(() => {
    refreshDbContext().catch(() => { /* logged inside */ });
  }, intervalMs);
  if (dbHealthTimer && typeof dbHealthTimer === 'object' && 'unref' in dbHealthTimer) {
    dbHealthTimer.unref();
  }
}

export function stopDbHealthSync(): void {
  if (dbHealthTimer) {
    clearInterval(dbHealthTimer);
    dbHealthTimer = null;
  }
}
