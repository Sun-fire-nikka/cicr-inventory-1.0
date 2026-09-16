import { dbWrite } from '../config/database';

let cleanupTimer: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run every 6 hours
export const RETENTION_DAYS = 7;

/**
 * Purges audit log entries older than 7 days from the backend database.
 * Returns the number of purged records if available, or status.
 */
export const cleanupExpiredAuditLogs = async (): Promise<{ success: boolean; cutoffDate: string; error?: string }> => {
  const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffTime).toISOString();

  try {
    const { error } = await dbWrite
      .from('audit_logs')
      .delete()
      .lt('timestamp', cutoffDate);

    if (error) {
      console.warn(`[AUDIT RETENTION] Error deleting logs older than ${cutoffDate}:`, error.message);
      return { success: false, cutoffDate, error: error.message };
    }

    console.log(`[AUDIT RETENTION] Successfully enforced 7-day retention cutoff (${cutoffDate}).`);
    return { success: true, cutoffDate };
  } catch (err: any) {
    console.error('[AUDIT RETENTION] Exception during audit log cleanup:', err?.message || err);
    return { success: false, cutoffDate, error: err?.message || String(err) };
  }
};

/**
 * Starts the recurring background scheduler for 7-day audit log retention.
 */
export const startAuditRetentionScheduler = (): void => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  // Run initial cleanup 15 seconds after server boot to allow database pools to warm up
  setTimeout(() => {
    cleanupExpiredAuditLogs().catch(err => {
      console.warn('[AUDIT RETENTION] Initial boot cleanup error:', err);
    });
  }, 15000);

  // Set recurring interval
  cleanupTimer = setInterval(() => {
    cleanupExpiredAuditLogs().catch(err => {
      console.warn('[AUDIT RETENTION] Periodic cleanup error:', err);
    });
  }, CLEANUP_INTERVAL_MS);

  console.log(`⏱️ [AUDIT RETENTION] 7-Day log retention scheduler active (Cycle: every 6h, Window: ${RETENTION_DAYS} days).`);
};

/**
 * Stops the background retention scheduler (used during graceful shutdown).
 */
export const stopAuditRetentionScheduler = (): void => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[AUDIT RETENTION] Retention scheduler stopped.');
  }
};
