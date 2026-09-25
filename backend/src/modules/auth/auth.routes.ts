import { Router } from 'express';
import {
  register,
  login,
  verifyLoginOtp,
  resendLoginOtp,
  getProfile,
  updateProfile,
  listUsersForAdmin,
  approveUser,
  rejectUser,
  changeUserRole,
  deleteUser,
  forgotPassword,
  resetPassword,
  changePassword,
  adminCreateUser,
  logout
} from './auth.controller';
import { sendOtp, verifyOtp } from './authOtpController';
import { authenticateToken, requireAdmin } from '../../middleware/auth.middleware';
import { authLimiter, otpLimiter, registerLimiter, adminLimiter } from '../../middleware/rateLimit';
import { validate, loginSchema, registerSchema, verifyOtpSchema, resendOtpSchema } from '../../validators/auth.validator';

const router = Router();

// Public routes with rate limiting and validation
router.post('/register', registerLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/logout', authenticateToken, logout);
router.post('/verify-login-otp', otpLimiter, validate(verifyOtpSchema), verifyLoginOtp);
router.post('/resend-login-otp', otpLimiter, validate(resendOtpSchema), resendLoginOtp);
router.post('/send-otp', otpLimiter, sendOtp);
router.post('/verify-otp', otpLimiter, validate(verifyOtpSchema), verifyOtp);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.patch('/profile', authenticateToken, updateProfile);

// Password recovery and update routes
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);
router.post('/change-password', authenticateToken, changePassword);

// Admin user approval and member management routes with stricter rate limits
router.get('/admin/users', authenticateToken, requireAdmin, adminLimiter, listUsersForAdmin);
router.post('/admin/users/create', authenticateToken, requireAdmin, adminLimiter, adminCreateUser);
router.post('/admin/users/:id/approve', authenticateToken, requireAdmin, adminLimiter, approveUser);
router.post('/admin/users/:id/reject', authenticateToken, requireAdmin, adminLimiter, rejectUser);
router.post('/admin/users/:id/role', authenticateToken, requireAdmin, adminLimiter, changeUserRole);
router.delete('/admin/users/:id', authenticateToken, requireAdmin, adminLimiter, deleteUser);

export default router;
