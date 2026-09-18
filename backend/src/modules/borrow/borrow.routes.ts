import { Router } from 'express';
import {
  borrowItem,
  returnItem,
  getBorrowHistory,
  getBorrowLedger,
  getAdmins,
  requestOtp,
  verifyOtp,
  createHardwareRequestHandler,
  getHardwareRequestsHandler,
  approveHardwareRequestHandler,
  rejectHardwareRequestHandler,
  submitReturnRequestHandler,
  submitBulkReturnRequestHandler
} from './borrow.controller';
import { authenticateToken, requireAdmin } from '../../middleware/auth.middleware';

const router = Router();

router.get('/admins', getAdmins);
router.post('/', authenticateToken, borrowItem);
router.post('/request', authenticateToken, createHardwareRequestHandler);
router.get('/requests', authenticateToken, getHardwareRequestsHandler);
router.post('/requests/:id/approve', authenticateToken, requireAdmin, approveHardwareRequestHandler);
router.post('/requests/:id/reject', authenticateToken, requireAdmin, rejectHardwareRequestHandler);
router.post('/request-otp', authenticateToken, requestOtp);
router.post('/verify-otp', authenticateToken, verifyOtp);
router.post('/return', authenticateToken, returnItem);
router.post('/return-request', authenticateToken, submitReturnRequestHandler);
router.post('/bulk-return-request', authenticateToken, submitBulkReturnRequestHandler);
router.get('/history', authenticateToken, getBorrowHistory);
router.get('/ledger', authenticateToken, requireAdmin, getBorrowLedger);

export default router;

