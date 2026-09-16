import { Request, Response } from 'express';
import { dbRead } from '../../config/database';
import { cacheGetJSON, cacheSetJSON } from '../../config/redis';
import { AuthRequest } from '../../middleware/auth.middleware';
import { logAuditEvent } from '../../services/auditService';
import { cleanupExpiredAuditLogs, RETENTION_DAYS } from '../../services/auditCleanupService';

const STATS_CACHE_KEY = 'cicr:cache:stats';
const STATS_CACHE_TTL = 15; // seconds

// GET /api/stats (Dashboard Analytics) — independent read-pool queries in parallel, cached 15s
export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const cached = await cacheGetJSON<any>(STATS_CACHE_KEY);
    if (cached) {
      return res.status(200).json(cached);
    }

    const [
      { count: totalItems },
      { count: totalUsers },
      { count: activeBorrows },
      { data: items }
    ] = await Promise.all([
      dbRead.from('inventory').select('*', { count: 'exact', head: true }),
      dbRead.from('users').select('*', { count: 'exact', head: true }),
      dbRead
        .from('borrow_records')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'BORROWED'),
      dbRead.from('inventory').select('quantity, available_quantity')
    ]);

    const totalQuantity = items?.reduce((acc: number, curr: any) => acc + curr.quantity, 0) || 0;
    const availableQuantity = items?.reduce((acc: number, curr: any) => acc + curr.available_quantity, 0) || 0;

    const payload = {
      status: 'success',
      data: {
        total_items: totalItems || 0,
        total_users: totalUsers || 0,
        active_borrows: activeBorrows || 0,
        total_quantity: totalQuantity,
        available_quantity: availableQuantity,
        borrowed_quantity: totalQuantity - availableQuantity
      }
    };

    await cacheSetJSON(STATS_CACHE_KEY, payload, STATS_CACHE_TTL);
    return res.status(200).json(payload);
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// GET /api/audit (Audit Logs List & 7-Day Telemetry Hub)
export const getAuditLogs = async (req: AuthRequest, res: Response) => {
  try {
    const { category, search, limit, days, day } = req.query;
    const requestedDays = Math.min(Math.max(Number(days) || RETENTION_DAYS, 1), 7);
    const maxLimit = Math.min(Math.max(Number(limit) || 2500, 1), 5000);

    const cutoffTime = Date.now() - requestedDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffTime).toISOString();

    // 1. Fetch raw 7-day logs to calculate true activity spectrum & category counts
    const { data: raw7DayLogs, error: rawError } = await dbRead
      .from('audit_logs')
      .select('id, action, timestamp')
      .gte('timestamp', cutoffDate)
      .order('timestamp', { ascending: false })
      .limit(5000);

    if (rawError) throw rawError;

    const base7DayLogs = raw7DayLogs || [];

    // 2. Compute 7-day daily activity spectrum (Today back 6 days)
    const dailyMap: Record<string, number> = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dailyCounts: Array<{ date: string; dayName: string; count: number; percentage: number }> = [];

    for (let i = requestedDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = d.toISOString().split('T')[0];
      dailyMap[ymd] = 0;
      const isToday = i === 0;
      const isYesterday = i === 1;
      const label = isToday ? 'Today' : isYesterday ? 'Yesterday' : dayNames[d.getDay()];
      dailyCounts.push({ date: ymd, dayName: label, count: 0, percentage: 0 });
    }

    // 3. Compute Category Distribution across all 7-day logs
    const categoryCounts = {
      all: base7DayLogs.length,
      auth: 0,
      inventory: 0,
      hardware: 0,
      loans: 0,
      system: 0
    };

    base7DayLogs.forEach((l: any) => {
      // Daily count
      const logDate = (l.timestamp ? new Date(l.timestamp).toISOString() : '').split('T')[0];
      if (dailyMap[logDate] !== undefined) {
        dailyMap[logDate]++;
      }

      // Category count
      const act = l.action || '';
      if (['Sign In', 'Sign Up', 'User Approved', 'User Rejected', 'Role Changed', 'User Deleted', 'Password Reset'].includes(act)) {
        categoryCounts.auth++;
      } else if (['Item Added', 'Item Edited', 'Item Deleted', 'Stock Alert', 'Low Stock'].includes(act)) {
        categoryCounts.inventory++;
      } else if (['Hardware Requested', 'Hardware Approved', 'Hardware Rejected', 'Hardware Cancelled'].includes(act)) {
        categoryCounts.hardware++;
      } else if (['Borrowed', 'Returned', 'OTP Requested', 'Item Borrowed', 'Item Returned', 'Approved Return', 'Return Requested'].includes(act)) {
        categoryCounts.loans++;
      } else {
        categoryCounts.system++;
      }
    });

    // Populate daily counts with percentages
    let maxDayCount = 1;
    dailyCounts.forEach(dc => {
      dc.count = dailyMap[dc.date] || 0;
      if (dc.count > maxDayCount) maxDayCount = dc.count;
    });
    dailyCounts.forEach(dc => {
      dc.percentage = Math.round((dc.count / maxDayCount) * 100);
    });

    // 4. Query filtered logs list
    let query = dbRead
      .from('audit_logs')
      .select('*, users(name, email, role), inventory(name, category)')
      .gte('timestamp', cutoffDate)
      .order('timestamp', { ascending: false })
      .limit(maxLimit);

    // Filter by specific day if requested (YYYY-MM-DD)
    if (day && typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.trim())) {
      const targetDay = day.trim();
      const nextDay = new Date(new Date(targetDay).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      query = query.gte('timestamp', `${targetDay}T00:00:00.000Z`).lt('timestamp', `${nextDay}T00:00:00.000Z`);
    }

    if (category && typeof category === 'string' && category !== 'all') {
      const cat = category.toLowerCase();
      if (cat === 'auth') {
        query = query.in('action', ['Sign In', 'Sign Up', 'User Approved', 'User Rejected', 'Role Changed', 'User Deleted', 'Password Reset']);
      } else if (cat === 'inventory') {
        query = query.in('action', ['Item Added', 'Item Edited', 'Item Deleted', 'Stock Alert', 'Low Stock']);
      } else if (cat === 'hardware') {
        query = query.in('action', ['Hardware Requested', 'Hardware Approved', 'Hardware Rejected', 'Hardware Cancelled']);
      } else if (cat === 'loans') {
        query = query.in('action', ['Borrowed', 'Returned', 'OTP Requested', 'Item Borrowed', 'Item Returned', 'Approved Return', 'Return Requested']);
      } else if (cat === 'system') {
        query = query.in('action', ['System Event', 'System Alert', 'Auto-Sync', 'Database Purge', 'Retention Prune', 'Maintenance']);
      }
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim();
      query = query.or(`action.ilike.%${term}%,description.ilike.%${term}%`);
    }

    const { data: logs, error } = await query;

    if (error) throw error;

    const allLogs = logs || [];

    return res.status(200).json({
      status: 'success',
      count: allLogs.length,
      retentionDays: requestedDays,
      windowStart: cutoffDate,
      dailyCounts,
      categoryCounts,
      data: allLogs
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/audit (Client & System Audit Event Ingestion)
export const createAuditEvent = async (req: AuthRequest, res: Response) => {
  try {
    const { action, description, itemId, metadata, severity } = req.body;

    if (!action || typeof action !== 'string') {
      return res.status(400).json({ status: 'error', message: 'Action name is required.' });
    }

    const userId = req.user?.id || null;
    const cleanDesc = (description && typeof description === 'string')
      ? description.trim()
      : `Action: ${action} recorded by ${req.user?.name || 'System'}`;

    await logAuditEvent({
      action: action.trim(),
      userId,
      itemId: itemId || null,
      description: cleanDesc,
      metadata: metadata || null,
      severity: severity || 'info'
    });

    return res.status(201).json({ status: 'success', message: 'Audit event persisted to 7-day backend ledger.' });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/audit/cleanup (Admin-Triggered 7-Day Retention Purge)
export const triggerAuditCleanup = async (req: AuthRequest, res: Response) => {
  try {
    const result = await cleanupExpiredAuditLogs();
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.error || 'Failed to prune expired audit records.' });
    }

    return res.status(200).json({
      status: 'success',
      message: '7-Day audit log retention policy successfully enforced.',
      cutoffDate: result.cutoffDate
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};