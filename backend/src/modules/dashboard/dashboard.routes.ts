import { Router } from 'express';
import { getDashboardStats, getAuditLogs, createAuditEvent, triggerAuditCleanup } from './dashboard.controller';
import { authenticateToken, requireAdmin } from '../../middleware/auth.middleware';

const router = Router();

router.get('/stats', getDashboardStats);
router.get('/audit', authenticateToken, requireAdmin, getAuditLogs);
router.post('/audit', authenticateToken, createAuditEvent);
router.post('/audit/cleanup', authenticateToken, requireAdmin, triggerAuditCleanup);

export default router;