import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  sendAdminHardwareRequestAlert,
  sendHardwareRequestStatusEmail,
  sendBorrowConfirmation,
  sendAdminBorrowNotification,
  sendStudentHardwareRequestSubmittedEmail,
  sendStudentReturnRequestSubmittedEmail,
  sendAdminReturnRequestAlert,
  sendReturnConfirmation,
  sendAdminReturnNotification,
  SUPER_ADMIN_EMAILS
} from '../../services/emailService';
import { dbRead, dbWrite, supabase } from '../../config/database';

export interface HardwareIssueRequest {
  id: string;
  type?: 'ISSUE' | 'RETURN';
  borrowId?: string;
  returnQuantity?: number;
  itemId: string;
  itemName: string;
  category?: string;
  borrowerName: string;
  borrowerEmail: string;
  rollNumber?: string | null;
  userId?: string;
  quantity: number;
  purpose: string;
  durationDays: number;
  dueDate: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
}

const resolveStoragePath = (fileName: string) => {
  const localPath = path.resolve(process.cwd(), fileName);
  if (fs.existsSync(localPath)) return localPath;
  const backendPath = path.resolve(process.cwd(), 'backend', fileName);
  if (fs.existsSync(backendPath)) return backendPath;
  return path.resolve(__dirname, '..', '..', '..', fileName);
};

const STORAGE_FILE = resolveStoragePath('hardware_requests_data.json');

let requestsState: Record<string, HardwareIssueRequest> = {};

// Load persisted requests state
try {
  if (fs.existsSync(STORAGE_FILE)) {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
    requestsState = JSON.parse(raw);
  }
} catch (err) {
  console.warn('[HARDWARE REQUESTS] Failed to load request storage file, using memory:', err);
}

const saveState = () => {
  try {
    const tmpFile = `${STORAGE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(requestsState, null, 2), 'utf-8');
    fs.renameSync(tmpFile, STORAGE_FILE);
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Failed to save request storage file:', err);
  }
};

const processingRequestIds = new Set<string>();

export const resolveRealBorrowerEmail = async (
  userId?: string | null,
  rollNumber?: string | null,
  existingEmail?: string | null
): Promise<string> => {
  const norm = (existingEmail || '').toLowerCase().trim();
  if (norm && norm.includes('@') && !norm.startsWith('student@') && !norm.includes('unknown')) {
    return norm;
  }
  if (userId) {
    try {
      const { data: u } = await dbRead.from('users').select('email, roll_number').eq('id', userId).maybeSingle();
      if (u?.email && !u.email.toLowerCase().startsWith('student@')) return u.email.trim();
      if (u?.roll_number) return `${u.roll_number.trim()}@mail.jiit.ac.in`;
    } catch {}
  }
  if (rollNumber && rollNumber.trim() && rollNumber !== '—') {
    return `${rollNumber.trim()}@mail.jiit.ac.in`;
  }
  return norm || '';
};

export const createHardwareRequest = async (payload: {
  itemId: string;
  itemName?: string;
  borrowerName: string;
  borrowerEmail: string;
  rollNumber?: string | null;
  userId?: string;
  quantity: number;
  purpose: string;
  durationDays?: number;
  dueDate?: string;
}): Promise<HardwareIssueRequest> => {
  // Resolve real email if payload has generic or missing email
  const resolvedEmail = await resolveRealBorrowerEmail(payload.userId, payload.rollNumber, payload.borrowerEmail);
  if (resolvedEmail) {
    payload.borrowerEmail = resolvedEmail;
  }

  // Rapid submission debounce: if the same borrower submitted an identical request within the last 5 seconds, return existing record
  const now = Date.now();
  const recentDuplicate = Object.values(requestsState).find(r => {
    if (!r || r.status !== 'PENDING') return false;
    const sameBorrower = (r.borrowerEmail || '').toLowerCase().trim() === (payload.borrowerEmail || '').toLowerCase().trim() ||
      (r.borrowerName || '').toLowerCase().trim() === (payload.borrowerName || '').toLowerCase().trim();
    const sameItem = r.itemId === payload.itemId;
    const sameQty = Number(r.quantity) === Number(payload.quantity);
    const samePurpose = (r.purpose || '').toLowerCase().trim() === (payload.purpose || '').toLowerCase().trim();
    const ageMs = now - new Date(r.requestedAt).getTime();
    return sameBorrower && sameItem && sameQty && samePurpose && ageMs < 5000;
  });
  if (recentDuplicate) {
    return recentDuplicate;
  }

  const id = `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const requestedAt = new Date().toISOString();
  const durationDays = payload.durationDays || 7;

  let itemName = payload.itemName || 'Hardware Component';
  let category = 'Robotics';

  // Fetch actual item details from database if possible
  try {
    const { data: item } = await dbRead
      .from('inventory')
      .select('name, category')
      .eq('id', payload.itemId)
      .single();
    if (item) {
      itemName = item.name;
      category = item.category || 'Robotics';
    }
  } catch (e) {
    // Non-blocking
  }

  const defaultDueDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dueDate = payload.dueDate || defaultDueDate;

  const newRequest: HardwareIssueRequest = {
    id,
    itemId: payload.itemId,
    itemName,
    category,
    borrowerName: payload.borrowerName,
    borrowerEmail: payload.borrowerEmail,
    rollNumber: payload.rollNumber || null,
    userId: payload.userId,
    quantity: payload.quantity,
    purpose: payload.purpose,
    durationDays,
    dueDate,
    status: 'PENDING',
    requestedAt
  };

  requestsState[id] = newRequest;
  saveState();
  invalidateHardwareRequestsCache();

  // 1. Mirror into Supabase borrow_records with status = 'PENDING'
  try {
    const isUUID = (str?: string) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));
    const safeUserId = isUUID(payload.userId) ? payload.userId : null;
    const safeItemId = isUUID(payload.itemId) ? payload.itemId : null;

    if (safeItemId) {
      const { data: insertedRec } = await supabase.from('borrow_records').insert([
        {
          id: isUUID(id) ? id : undefined,
          user_id: safeUserId,
          borrower_name: payload.borrowerName,
          roll_number: payload.rollNumber || null,
          inventory_id: safeItemId,
          quantity: payload.quantity,
          purpose: payload.purpose,
          borrowed_at: requestedAt,
          due_date: dueDate,
          status: 'PENDING'
        }
      ]).select().single();

      if (insertedRec && insertedRec.id && insertedRec.id !== id) {
        newRequest.borrowId = insertedRec.id;
        saveState();
      }
    }
  } catch (err) {
    console.warn('[HARDWARE REQUEST] Note mirroring to Supabase borrow_records:', err);
  }

  // Instant notification to Super Admins (Zero Emojis, Authentic High-Priority Cyber Notification)
  sendAdminHardwareRequestAlert(SUPER_ADMIN_EMAILS, {
    requestId: id,
    itemName,
    category,
    quantity: payload.quantity,
    borrowerName: payload.borrowerName,
    borrowerEmail: payload.borrowerEmail,
    rollNumber: payload.rollNumber,
    purpose: payload.purpose,
    durationDays,
    dueDate,
    requestedAt
  }).catch((err) => console.error('[HARDWARE REQUEST] Admin email alert failed:', err));

  // Instant notification to Student Borrower
  if (payload.borrowerEmail) {
    sendStudentHardwareRequestSubmittedEmail(payload.borrowerEmail, payload.borrowerName, {
      itemName,
      quantity: payload.quantity,
      purpose: payload.purpose,
      durationDays,
      dueDate,
      requestedAt
    }).catch((err) => console.error('[HARDWARE REQUEST] Student submission email failed:', err));
  }

  return newRequest;
};

export const createReturnRequest = async (payload: {
  borrowId: string;
  returnQuantity: number;
  userId?: string;
  userName?: string;
  userEmail?: string;
  userRoll?: string;
  userRole?: string;
}): Promise<{ success: boolean; request?: HardwareIssueRequest; message?: string }> => {
  const { borrowId, returnQuantity } = payload;
  if (!borrowId) {
    return { success: false, message: 'borrowId is required.' };
  }

  // 1. Fetch borrow record from database
  const { data: record, error } = await dbRead
    .from('borrow_records')
    .select('*, inventory(name, category)')
    .eq('id', borrowId)
    .maybeSingle();

  if (error || !record) {
    return { success: false, message: 'Active borrow record not found in system.' };
  }

  if (record.status === 'PENDING') {
    return { success: false, message: 'Cannot request return: This component issue is still pending admin approval.' };
  }

  if (record.status === 'RETURNED') {
    return { success: false, message: 'This item has already been marked as returned.' };
  }

  if (record.status === 'RETURN_REQUESTED') {
    const existing = Object.values(requestsState).find(
      r => r && r.type === 'RETURN' && (r.borrowId === record.id || r.id === record.id) && r.status === 'PENDING'
    );
    return { success: true, request: existing, message: 'A return verification request is already pending for this loan.' };
  }

  const existingPendingReturn = Object.values(requestsState).find(
    r => r && r.type === 'RETURN' && (r.borrowId === record.id || r.id === record.id) && r.status === 'PENDING'
  );
  if (existingPendingReturn) {
    return { success: true, request: existingPendingReturn, message: 'A return verification request is already pending for this loan.' };
  }

  // Enforce strict ownership: only the user who issued/borrowed this item can return it, UNLESS the requester is an ADMIN
  const isOwner = (() => {
    if (payload.userRole === 'ADMIN') {
      return true;
    }
    // 1. Match by user_id
    if (payload.userId && record.user_id && payload.userId === record.user_id) {
      return true;
    }
    // 2. Match by student roll number
    const normUserRoll = (payload.userRoll || '').trim().toLowerCase();
    const normRecRoll = (record.roll_number || '').trim().toLowerCase();
    if (normUserRoll && normRecRoll && normUserRoll === normRecRoll) {
      return true;
    }
    // 3. Match by student email containing roll number
    const normUserEmail = (payload.userEmail || '').trim().toLowerCase();
    if (normUserEmail && normRecRoll && (normUserEmail.startsWith(`${normRecRoll}@`) || normUserEmail === `${normRecRoll}@mail.jiit.ac.in`)) {
      return true;
    }
    // 4. Match by exact email if available on record
    const recEmail = (record.borrower_email || record.email || '').trim().toLowerCase();
    if (normUserEmail && recEmail && normUserEmail === recEmail) {
      return true;
    }
    // 5. Match by exact full name or substring name
    const normUserName = (payload.userName || '').trim().toLowerCase();
    const normRecName = (record.borrower_name || '').trim().toLowerCase();
    const isGeneric = (n: string) => !n || ['member', 'student', 'user', 'admin', 'borrower', 'guest'].includes(n) || n.length < 3;
    if (!isGeneric(normUserName) && !isGeneric(normRecName)) {
      if (normUserName === normRecName || normUserName.includes(normRecName) || normRecName.includes(normUserName)) {
        return true;
      }
    }
    return false;
  })();

  if (!isOwner) {
    return {
      success: false,
      message: 'Access Denied: You can only return items that you personally borrowed.'
    };
  }

  const numToReturn = Math.max(1, Math.min(Number(returnQuantity) || 1, record.quantity));
  const itemName = record.inventory?.name || 'Hardware Component';
  const category = record.inventory?.category || 'Robotics';
  const borrowerName = record.borrower_name || payload.userName || 'Member';
  const borrowerEmail = await resolveRealBorrowerEmail(payload.userId || record.user_id, record.roll_number || payload.userRoll, payload.userEmail || record.borrower_email);
  const rollNumber = record.roll_number || payload.userRoll || null;
  const requestedAt = new Date().toISOString();
  const id = `req-ret-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  const newReturnReq: HardwareIssueRequest = {
    id,
    type: 'RETURN',
    borrowId: record.id,
    returnQuantity: numToReturn,
    itemId: record.inventory_id,
    itemName,
    category,
    borrowerName,
    borrowerEmail,
    rollNumber,
    userId: payload.userId || record.user_id,
    quantity: numToReturn,
    purpose: `Return ${numToReturn} of ${record.quantity} units`,
    durationDays: 0,
    dueDate: '',
    status: 'PENDING',
    requestedAt
  };

  requestsState[id] = newReturnReq;
  saveState();
  invalidateHardwareRequestsCache();

  // Update borrow_records in Supabase so return request is persistent across server nodes
  try {
    await supabase
      .from('borrow_records')
      .update({ status: 'RETURN_REQUESTED' })
      .eq('id', record.id);
  } catch (dbErr) {
    console.warn('[HARDWARE RETURN] Note setting RETURN_REQUESTED on borrow_records:', dbErr);
  }

  // 2. Dispatch email confirmation to student
  if (borrowerEmail) {
    sendStudentReturnRequestSubmittedEmail(borrowerEmail, borrowerName, {
      itemName,
      quantity: numToReturn,
      requestedAt
    }).catch((err) => console.error('[HARDWARE RETURN] Student submission email error:', err));
  }

  // 3. Dispatch alert to Super Admins
  sendAdminReturnRequestAlert(SUPER_ADMIN_EMAILS, {
    requestId: id,
    borrowerName,
    borrowerEmail,
    rollNumber,
    itemName,
    quantity: numToReturn,
    requestedAt
  }).catch((err) => console.error('[HARDWARE RETURN] Admin return alert error:', err));

  return { success: true, request: newReturnReq };
};

export interface BulkReturnItemPayload {
  itemId?: string;
  borrowId?: string;
  quantity: number;
}

export interface BulkReturnPayload {
  userId?: string;
  userName?: string;
  userEmail?: string;
  userRoll?: string;
  userRole?: string;
  items: BulkReturnItemPayload[];
}

export const createBulkReturnRequest = async (
  payload: BulkReturnPayload
): Promise<{ success: boolean; message?: string; count?: number; requests?: HardwareIssueRequest[] }> => {
  if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
    return { success: false, message: 'No return items provided in bulk return manifest.' };
  }

  const validItems = payload.items.filter((it) => Number(it.quantity) > 0);
  if (validItems.length === 0) {
    return { success: false, message: 'All specified return quantities are zero.' };
  }

  // Query all active loans in Supabase
  const { data: allActiveLoans, error: fetchErr } = await dbRead
    .from('borrow_records')
    .select('*, inventory(id, name, category)')
    .eq('status', 'BORROWED')
    .order('borrowed_at', { ascending: true });

  if (fetchErr) {
    console.error('[BULK RETURN] Error querying active loans:', fetchErr);
    return { success: false, message: 'Failed to query active loans for bulk return.' };
  }

  const loans = allActiveLoans || [];

  // Helper to match loan ownership
  const isLoanMatch = (rec: any): boolean => {
    if (payload.userId && rec.user_id && String(rec.user_id).toLowerCase() === String(payload.userId).toLowerCase()) return true;
    const normUserRoll = (payload.userRoll || '').trim().toLowerCase();
    const recRoll = (rec.roll_number || rec.roll || '').trim().toLowerCase();
    if (normUserRoll && recRoll && normUserRoll === recRoll) return true;
    const normUserEmail = (payload.userEmail || '').trim().toLowerCase();
    const recEmail = (rec.borrower_email || rec.email || '').trim().toLowerCase();
    if (normUserEmail && recEmail && normUserEmail === recEmail) return true;
    const normUserName = (payload.userName || '').trim().toLowerCase();
    const normRecName = (rec.borrower_name || '').trim().toLowerCase();
    const isGeneric = (n: string) => !n || ['member', 'student', 'user', 'admin', 'borrower', 'guest'].includes(n) || n.length < 3;
    if (!isGeneric(normUserName) && !isGeneric(normRecName)) {
      if (normUserName === normRecName || normUserName.includes(normRecName) || normRecName.includes(normUserName)) return true;
    }
    return false;
  };

  const userLoans = loans.filter(isLoanMatch);
  const createdRequests: HardwareIssueRequest[] = [];

  for (const item of validItems) {
    let remainingToReturn = Number(item.quantity) || 0;
    if (remainingToReturn <= 0) continue;

    if (item.borrowId) {
      // Direct loan ID specified
      const res = await createReturnRequest({
        borrowId: item.borrowId,
        returnQuantity: remainingToReturn,
        userId: payload.userId,
        userName: payload.userName,
        userEmail: payload.userEmail,
        userRoll: payload.userRoll,
        userRole: payload.userRole
      });
      if (res.success && res.request) {
        createdRequests.push(res.request);
      }
    } else if (item.itemId) {
      // Item ID specified - allocate across user's loans of this item in FIFO order
      const matchingLoans = userLoans.filter((l: any) => l.inventory_id === item.itemId || l.inventory?.id === item.itemId);
      for (const loanRec of matchingLoans) {
        if (remainingToReturn <= 0) break;
        const take = Math.min(Number(loanRec.quantity) || 1, remainingToReturn);
        const res = await createReturnRequest({
          borrowId: loanRec.id,
          returnQuantity: take,
          userId: payload.userId,
          userName: payload.userName,
          userEmail: payload.userEmail,
          userRoll: payload.userRoll,
          userRole: payload.userRole
        });
        if (res.success && res.request) {
          createdRequests.push(res.request);
        }
        remainingToReturn -= take;
      }
    }
  }

  if (createdRequests.length === 0) {
    return { success: false, message: 'Could not match requested items with active loans under your account.' };
  }

  return {
    success: true,
    count: createdRequests.length,
    requests: createdRequests,
    message: `Submitted return requests for ${createdRequests.length} component loan(s) in 1 go.`
  };
};

let cachedHardwareRequests: HardwareIssueRequest[] | null = null;
let lastHardwareRequestsFetchTime = 0;
// Zero TTL to guarantee instant, real-time consistency across cloud and local nodes
const HARDWARE_REQUESTS_CACHE_TTL_MS = 0;

export const invalidateHardwareRequestsCache = () => {
  cachedHardwareRequests = null;
  lastHardwareRequestsFetchTime = 0;
};

export const getAllHardwareRequests = async (force = false): Promise<HardwareIssueRequest[]> => {
  // Ensure fresh disk state is merged with in-memory state
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const diskData = JSON.parse(raw);
      requestsState = { ...diskData, ...requestsState };
    }
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Failed to reload request storage file:', err);
  }

  // Strictly collect PENDING requests with canonical deduplication
  const canonicalMap = new Map<string, HardwareIssueRequest>();

  const getCanonicalKey = (r: HardwareIssueRequest): string => {
    if (r.type === 'RETURN' || Boolean(r.borrowId)) {
      return `ret__${(r.borrowId || r.id || '').trim()}`;
    }
    const email = (r.borrowerEmail || '').toLowerCase().trim();
    const name = (r.borrowerName || '').toLowerCase().trim();
    const itemId = (r.itemId || '').toLowerCase().trim();
    const qty = Number(r.quantity) || 1;
    const purp = (r.purpose || '').toLowerCase().trim();
    const reqTime = r.requestedAt ? new Date(r.requestedAt).getTime() : 0;
    const timeBucket = reqTime > 0 ? Math.floor(reqTime / 120000) : 0;
    return `iss__${email}__${name}__${itemId}__${qty}__${purp}__${timeBucket}`;
  };

  for (const r of Object.values(requestsState)) {
    if (r && r.status === 'PENDING') {
      const key = getCanonicalKey(r);
      if (!canonicalMap.has(key) && !canonicalMap.has(r.id)) {
        canonicalMap.set(key, r);
      }
    }
  }

  // 1. Query pending and return-requested rows from Supabase borrow_records
  try {
    const { data: dbRecords } = await dbRead
      .from('borrow_records')
      .select('*, inventory(name, category)')
      .in('status', ['PENDING', 'RETURN_REQUESTED'])
      .order('borrowed_at', { ascending: false });

    if (dbRecords && dbRecords.length > 0) {
      for (const rec of dbRecords) {
        const isReturn = rec.status === 'RETURN_REQUESTED';
        const recEmail = rec.roll_number ? `${rec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in';
        const recName = (rec.borrower_name || '').toLowerCase().trim();
        const reqTime = rec.borrowed_at ? new Date(rec.borrowed_at).getTime() : 0;
        const timeBucket = reqTime > 0 ? Math.floor(reqTime / 120000) : 0;
        const key = isReturn
          ? `ret__${rec.id}`
          : `iss__${recEmail.toLowerCase().trim()}__${recName}__${(rec.inventory_id || '').toLowerCase().trim()}__${Number(rec.quantity) || 1}__${(rec.purpose || 'testing').toLowerCase().trim()}__${timeBucket}`;

        // Check if this database record is already in canonicalMap
        const alreadyExists = canonicalMap.has(key) ||
          Array.from(canonicalMap.values()).some(r => r.id === rec.id || (isReturn && r.borrowId === rec.id));

        if (!alreadyExists) {
          const newReq: HardwareIssueRequest = {
            id: rec.id,
            type: isReturn ? 'RETURN' : 'ISSUE',
            borrowId: isReturn ? rec.id : undefined,
            returnQuantity: isReturn ? (rec.quantity || 1) : undefined,
            itemId: rec.inventory_id,
            itemName: rec.inventory?.name || 'Hardware Component',
            category: rec.inventory?.category || 'Robotics',
            borrowerName: rec.borrower_name || 'Member',
            borrowerEmail: recEmail,
            rollNumber: rec.roll_number,
            userId: rec.user_id,
            quantity: rec.quantity || 1,
            purpose: rec.purpose || (isReturn ? `Return ${rec.quantity || 1} units` : 'Testing'),
            durationDays: 7,
            dueDate: rec.due_date ? rec.due_date.split('T')[0] : '',
            status: 'PENDING',
            requestedAt: rec.borrowed_at || new Date().toISOString()
          };
          canonicalMap.set(key, newReq);
        }
      }
    }
  } catch (err) {
    console.warn('[HARDWARE REQUEST] Error reading pending records from Supabase:', err);
  }

  const sorted = Array.from(canonicalMap.values()).sort((a, b) => {
    return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
  });

  cachedHardwareRequests = sorted;
  lastHardwareRequestsFetchTime = Date.now();
  return sorted;
};

// Returns a single member's own requests across ALL statuses (PENDING,
// APPROVED, REJECTED) so the member's client can show approval/rejection
// feedback in the notifications drawer in addition to the transactional email.
export const getUserHardwareRequests = async (identity: {
  userId?: string;
  email?: string;
  rollNumber?: string | null;
}): Promise<HardwareIssueRequest[]> => {
  // Always reload the freshest persisted state so status changes made by an
  // admin on another node are reflected for the member.
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      requestsState = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Failed to reload request storage file:', err);
  }

  const norm = (v?: string | null) => (v || '').toLowerCase().trim();
  const targetEmail = norm(identity.email);
  const targetRoll = norm(identity.rollNumber);
  const targetUser = identity.userId;

  const own = Object.values(requestsState).filter((r) => {
    if (targetUser && r.userId && r.userId === targetUser) return true;
    if (targetEmail && norm(r.borrowerEmail) === targetEmail) return true;
    if (targetRoll && norm(r.rollNumber) === targetRoll) return true;
    return false;
  });

  // Also query pending & return-requested rows from Supabase borrow_records for this user
  try {
    let query = dbRead
      .from('borrow_records')
      .select('*, inventory(name, category)')
      .in('status', ['PENDING', 'RETURN_REQUESTED']);

    if (identity.userId && identity.rollNumber) {
      query = query.or(`user_id.eq.${identity.userId},roll_number.eq.${identity.rollNumber}`);
    } else if (identity.userId) {
      query = query.eq('user_id', identity.userId);
    } else if (identity.rollNumber) {
      query = query.eq('roll_number', identity.rollNumber);
    }

    const { data: dbOwn } = await query;
    if (dbOwn && dbOwn.length > 0) {
      for (const rec of dbOwn) {
        const alreadyIn = own.some(r => r.id === rec.id || r.borrowId === rec.id);
        if (!alreadyIn) {
          const isRet = rec.status === 'RETURN_REQUESTED';
          own.push({
            id: rec.id,
            type: isRet ? 'RETURN' : 'ISSUE',
            borrowId: isRet ? rec.id : undefined,
            returnQuantity: isRet ? (rec.quantity || 1) : undefined,
            itemId: rec.inventory_id,
            itemName: rec.inventory?.name || 'Hardware Component',
            category: rec.inventory?.category || 'Robotics',
            borrowerName: rec.borrower_name || 'Member',
            borrowerEmail: identity.email || (rec.roll_number ? `${rec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in'),
            rollNumber: rec.roll_number,
            userId: rec.user_id,
            quantity: rec.quantity || 1,
            purpose: rec.purpose || (isRet ? 'Return verification' : 'Issue request'),
            durationDays: 7,
            dueDate: rec.due_date ? rec.due_date.split('T')[0] : '',
            status: 'PENDING',
            requestedAt: rec.borrowed_at || new Date().toISOString()
          });
        }
      }
    }
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Error fetching member requests from Supabase:', err);
  }

  // Canonical deduplication so the member never sees duplicate cards
  const canonicalOwn = new Map<string, HardwareIssueRequest>();
  for (const r of own) {
    if (r) {
      const reqTime = r.requestedAt ? new Date(r.requestedAt).getTime() : 0;
      const timeBucket = reqTime > 0 ? Math.floor(reqTime / 120000) : 0;
      const key = (r.type === 'RETURN' || Boolean(r.borrowId))
        ? `ret__${r.borrowId || r.id}`
        : `iss__${r.itemId}__${r.quantity}__${(r.purpose || '').toLowerCase().trim()}__${r.status}__${timeBucket}`;
      if (!canonicalOwn.has(key) && !canonicalOwn.has(r.id)) {
        canonicalOwn.set(key, r);
      }
    }
  }

  return Array.from(canonicalOwn.values()).sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
};

export const getHardwareRequestById = (id: string): HardwareIssueRequest | undefined => {
  return requestsState[id];
};

const resolveMatchingInRequestsState = (
  req: HardwareIssueRequest,
  id: string,
  targetStatus: 'APPROVED' | 'REJECTED',
  adminName?: string,
  adminEmail?: string,
  note?: string
) => {
  const timestamp = new Date().toISOString();
  const reviewer = adminName || adminEmail || 'ADMIN';
  const tBorrowId = req.borrowId;
  const tItemId = req.itemId;
  const tEmail = (req.borrowerEmail || '').toLowerCase().trim();
  const tPurp = (req.purpose || '').toLowerCase().trim();

  req.status = targetStatus;
  req.reviewedAt = timestamp;
  req.reviewedBy = reviewer;
  if (note) req.reviewNote = note;

  for (const k of Object.keys(requestsState)) {
    const r = requestsState[k];
    if (!r) continue;
    const matchId = k === id || r.id === id;
    const matchBorrow = tBorrowId && (r.borrowId === tBorrowId || r.id === tBorrowId || k === tBorrowId);
    const matchContent = tItemId && r.itemId === tItemId && (r.borrowerEmail || '').toLowerCase().trim() === tEmail && (r.purpose || '').toLowerCase().trim() === tPurp;
    if (matchId || matchBorrow || matchContent) {
      r.status = targetStatus;
      r.reviewedAt = timestamp;
      r.reviewedBy = reviewer;
      if (note) r.reviewNote = note;
    }
  }
  saveState();
  invalidateHardwareRequestsCache();
};

export const approveHardwareRequest = async (
  id: string,
  adminName: string,
  adminEmail: string,
  fallback?: any
): Promise<{ success: boolean; request?: HardwareIssueRequest; error?: string }> => {
  if (processingRequestIds.has(id)) {
    return { success: false, error: 'Request is currently being processed by another transaction.' };
  }
  processingRequestIds.add(id);

  try {
    let req = requestsState[id];
    if (!req) {
      // Check if it exists in Supabase borrow_records with status = 'PENDING'
      const { data: dbRec } = await dbRead.from('borrow_records').select('*, inventory(name, category)').eq('id', id).maybeSingle();
      if (dbRec) {
        const isRet = dbRec.status === 'RETURN_REQUESTED';
        req = {
          id: dbRec.id,
          type: isRet ? 'RETURN' : 'ISSUE',
          borrowId: isRet ? dbRec.id : undefined,
          returnQuantity: isRet ? (dbRec.quantity || 1) : undefined,
          itemId: dbRec.inventory_id,
          itemName: dbRec.inventory?.name || 'Hardware Component',
          category: dbRec.inventory?.category || 'Robotics',
          borrowerName: dbRec.borrower_name || 'Member',
          borrowerEmail: dbRec.roll_number ? `${dbRec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in',
          rollNumber: dbRec.roll_number,
          userId: dbRec.user_id,
          quantity: dbRec.quantity || 1,
          purpose: dbRec.purpose || (isRet ? `Return ${dbRec.quantity || 1} units` : 'Testing'),
          durationDays: 7,
          dueDate: dbRec.due_date ? dbRec.due_date.split('T')[0] : '',
          status: 'PENDING',
          requestedAt: dbRec.borrowed_at || new Date().toISOString()
        };
        requestsState[id] = req;
      }
    }

    // Fallback: If not found in server state, reconstruct from client request payload
    if (!req && fallback && (fallback.itemId || fallback.inventory_id || fallback.borrowerEmail || fallback.borrowerName)) {
      const isRet = fallback.type === 'RETURN' || Boolean(fallback.borrowId);
      req = {
        id,
        type: isRet ? 'RETURN' : 'ISSUE',
        borrowId: fallback.borrowId || (isRet ? id : undefined),
        returnQuantity: Number(fallback.returnQuantity || fallback.quantity || 1),
        itemId: fallback.itemId || fallback.inventory_id || '',
        itemName: fallback.itemName || 'Hardware Component',
        category: fallback.category || 'Robotics',
        borrowerName: fallback.borrowerName || fallback.borrower_name || 'Member',
        borrowerEmail: fallback.borrowerEmail || fallback.borrower_email || (fallback.rollNumber ? `${fallback.rollNumber}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in'),
        rollNumber: fallback.rollNumber || fallback.roll_number || null,
        userId: fallback.userId || fallback.user_id,
        quantity: Number(fallback.quantity || fallback.qty) || 1,
        purpose: fallback.purpose || (isRet ? 'Return hardware' : 'Testing'),
        durationDays: Number(fallback.durationDays || fallback.duration_days) || 7,
        dueDate: fallback.dueDate || fallback.due_date || '',
        status: 'PENDING',
        requestedAt: fallback.requestedAt || new Date().toISOString()
      };
      requestsState[id] = req;
    }

    if (!req) {
      return { success: false, error: 'Request not found.' };
    }

    // Idempotent: If already approved or processed, return success immediately
    if (req.status !== 'PENDING') {
      return { success: true, request: req };
    }

    // Resolve real borrower email immediately so all notification steps have the verified student email
    req.borrowerEmail = await resolveRealBorrowerEmail(req.userId, req.rollNumber, req.borrowerEmail);

    // Handle Return Approval
    if (req.type === 'RETURN') {
      const borrowId = req.borrowId || req.id;
      const returnQty = req.returnQuantity || req.quantity || 1;

      // Order Check: Verify there is no unresolved pending issue request for this exact item and borrower
      const pendingIssue = Object.values(requestsState).find(r =>
        r && r.status === 'PENDING' && r.type !== 'RETURN' &&
        r.itemId === req.itemId &&
        ((r.borrowerEmail && req.borrowerEmail && r.borrowerEmail.toLowerCase().trim() === req.borrowerEmail.toLowerCase().trim()) ||
         (r.userId && req.userId && r.userId === req.userId))
      );
      if (pendingIssue) {
        return {
          success: false,
          error: 'Order Violation: Cannot approve return before the pending component issue request is approved.'
        };
      }

      // Fetch borrow record
      let bRecord: any = null;
      if (borrowId) {
        const { data } = await dbRead
          .from('borrow_records')
          .select('*, inventory(name, available_quantity)')
          .eq('id', borrowId)
          .maybeSingle();
        bRecord = data;
      }

      // Fallback: If not found by borrowId (e.g. client ID mismatch), query active record by item and borrower
      if (!bRecord && req.itemId) {
        let q = dbRead
          .from('borrow_records')
          .select('*, inventory(name, available_quantity)')
          .eq('inventory_id', req.itemId)
          .in('status', ['BORROWED', 'RETURN_REQUESTED']);
        if (req.userId) {
          q = q.eq('user_id', req.userId);
        } else if (req.borrowerName) {
          q = q.eq('borrower_name', req.borrowerName);
        }
        const { data: matches } = await q.limit(1);
        if (matches && matches.length > 0) {
          bRecord = matches[0];
        }
      }

      const activeRecordId = bRecord?.id || (borrowId && !borrowId.startsWith('req-') ? borrowId : null);
      const inventoryItemId = bRecord?.inventory_id || req.itemId;

      if (inventoryItemId) {
        // 1. Restock available quantity in inventory using CAS retry loop
        let restockSuccess = false;
        let restockAttempts = 0;
        while (restockAttempts < 5 && !restockSuccess) {
          restockAttempts++;
          const { data: currItem } = await dbRead
            .from('inventory')
            .select('quantity, available_quantity, name')
            .eq('id', inventoryItemId)
            .maybeSingle();

          if (!currItem) break;
          const totalStock = Number(currItem?.quantity) || 1;
          const currentAvail = Number(currItem?.available_quantity) || 0;
          const newAvail = Math.min(totalStock, currentAvail + returnQty);

          const { data: updatedRows } = await supabase
            .from('inventory')
            .update({ available_quantity: newAvail, updated_at: new Date().toISOString() })
            .eq('id', inventoryItemId)
            .eq('available_quantity', currentAvail)
            .select('available_quantity');

          if (updatedRows && updatedRows.length > 0) {
            restockSuccess = true;
            break;
          }
          await new Promise(r => setTimeout(r, 15 + Math.random() * 25));
        }
      }

      // 2. Mark record RETURNED in Supabase borrow_records
      if (bRecord && bRecord.id) {
        if (returnQty >= bRecord.quantity) {
          await supabase
            .from('borrow_records')
            .update({ status: 'RETURNED', returned_at: new Date().toISOString() })
            .eq('id', bRecord.id);
        } else {
          await supabase
            .from('borrow_records')
            .update({ quantity: bRecord.quantity - returnQty, status: 'BORROWED' })
            .eq('id', bRecord.id);
        }
      } else if (activeRecordId) {
        await supabase
          .from('borrow_records')
          .update({ status: 'RETURNED', returned_at: new Date().toISOString() })
          .eq('id', activeRecordId);
      }

      // Log audit
      try {
        const isUuid = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str));
        await supabase.from('audit_logs').insert([
          {
            action: 'Approved Return',
            user_id: isUuid(req.userId) ? req.userId : null,
            item_id: isUuid(inventoryItemId) ? inventoryItemId : null,
            description: `Admin ${adminName || 'ADMIN'} approved return of ${returnQty} units of "${req.itemName}" from ${req.borrowerName}.`
          }
        ]);
      } catch {}

      resolveMatchingInRequestsState(req, id, 'APPROVED', adminName, adminEmail);

      // Re-resolve real borrower email with fallback from bRecord
      req.borrowerEmail = await resolveRealBorrowerEmail(req.userId || bRecord?.user_id, req.rollNumber || bRecord?.roll_number, req.borrowerEmail);

      // Send Return Confirmation to student
      if (req.borrowerEmail) {
        sendReturnConfirmation(
          req.borrowerEmail,
          req.borrowerName,
          req.itemName,
          new Date()
        ).catch((e) => console.error('[EMAIL ERROR] Return confirmation to student failed:', e));
      }

      // Send Admin Return Notification
      sendAdminReturnNotification(SUPER_ADMIN_EMAILS, {
        borrowerName: req.borrowerName,
        borrowerEmail: req.borrowerEmail || 'N/A',
        itemName: req.itemName,
        quantity: returnQty,
        returnedAt: new Date()
      }).catch((e) => console.error('[EMAIL ERROR] Admin return notification failed:', e));

      return { success: true, request: req };
    }

  // Finalize borrow in database / inventory
  const { finalizeBorrow } = await import('./borrow.controller');
  const result = await finalizeBorrow({
    userId: req.userId || '',
    userName: req.borrowerName,
    itemId: req.itemId,
    quantity: req.quantity,
    purpose: req.purpose,
    durationDays: req.durationDays
  });

  if (result.error) {
    // If the item doesn't exist in Supabase inventory (e.g. mock test component or unlisted item),
    // mark as approved with note so it is resolved and never stuck in PENDING limbo!
    console.warn(`[HARDWARE REQUEST] finalizeBorrow note: ${result.error.message}. Resolving request as APPROVED.`);
    resolveMatchingInRequestsState(req, id, 'APPROVED', adminName, adminEmail, `Approved (Item offline/unlisted: ${result.error.message})`);

    req.borrowerEmail = await resolveRealBorrowerEmail(req.userId, req.rollNumber, req.borrowerEmail);

    if (req.borrowerEmail) {
      sendHardwareRequestStatusEmail(
        req.borrowerEmail,
        req.borrowerName,
        req.itemName,
        req.quantity,
        'APPROVED',
        req.reviewedBy || adminName || 'ADMIN'
      ).catch((e) => console.error('[EMAIL ERROR] Failed to send approval status email to borrower:', e));
    }

    return { success: true, request: req };
  }

  resolveMatchingInRequestsState(req, id, 'APPROVED', adminName, adminEmail);

  const { borrowRecord, item, newAvailableQty, dueDate } = result;

  // Clean up transient initial pending mirror record if present
  if (req.borrowId && borrowRecord?.id && req.borrowId !== borrowRecord.id) {
    try {
      await supabase.from('borrow_records').delete().eq('id', req.borrowId);
    } catch {}
  }

  // Re-resolve real borrower email for notification dispatch
  req.borrowerEmail = await resolveRealBorrowerEmail(req.userId, req.rollNumber, req.borrowerEmail);

  // Send approval status email to borrower (with CC to admins)
  if (req.borrowerEmail) {
    sendHardwareRequestStatusEmail(
      req.borrowerEmail,
      req.borrowerName,
      req.itemName,
      req.quantity,
      'APPROVED',
      req.reviewedBy || adminName || 'ADMIN'
    ).catch((e) => console.error('[EMAIL ERROR] Failed to send approval status email to borrower:', e));

    const { data: activeHolders } = await dbRead
      .from('borrow_records')
      .select('borrower_name, roll_number, quantity, borrowed_at')
      .eq('inventory_id', req.itemId)
      .eq('status', 'BORROWED')
      .neq('id', borrowRecord.id);

    sendBorrowConfirmation(req.borrowerEmail, req.borrowerName, {
      itemName: item.name,
      category: item.category,
      quantity: req.quantity,
      remainingStock: newAvailableQty,
      holders: activeHolders || [],
      durationDays: req.durationDays,
      dueDate
    }).catch((e) => console.error('[EMAIL ERROR] Failed to send borrower confirmation on approval:', e));
  }

  // Send admin borrow alert
  sendAdminBorrowNotification(SUPER_ADMIN_EMAILS, {
    borrowerName: req.borrowerName,
    borrowerEmail: req.borrowerEmail,
    rollNumber: req.rollNumber,
    itemName: item.name,
    category: item.category,
    quantity: req.quantity,
    remainingStock: newAvailableQty,
    purpose: req.purpose,
    durationDays: req.durationDays,
    dueDate
  }).catch((e) => console.error('[EMAIL ERROR] Failed to send admin borrow alert on approval:', e));

  return { success: true, request: req };
  } finally {
    processingRequestIds.delete(id);
  }
};

export const rejectHardwareRequest = async (
  id: string,
  adminName: string,
  adminEmail: string,
  reason?: string,
  fallback?: any
): Promise<{ success: boolean; request?: HardwareIssueRequest; error?: string }> => {
  if (processingRequestIds.has(id)) {
    return { success: false, error: 'Request is currently being processed by another transaction.' };
  }
  processingRequestIds.add(id);

  try {
    let req = requestsState[id];
    if (!req) {
      const { data: dbRec } = await dbRead.from('borrow_records').select('*, inventory(name, category)').eq('id', id).maybeSingle();
      if (dbRec) {
        const isRet = dbRec.status === 'RETURN_REQUESTED';
        req = {
          id: dbRec.id,
          type: isRet ? 'RETURN' : 'ISSUE',
          borrowId: isRet ? dbRec.id : undefined,
          returnQuantity: isRet ? (dbRec.quantity || 1) : undefined,
          itemId: dbRec.inventory_id,
          itemName: dbRec.inventory?.name || 'Hardware Component',
          category: dbRec.inventory?.category || 'Robotics',
          borrowerName: dbRec.borrower_name || 'Member',
          borrowerEmail: dbRec.roll_number ? `${dbRec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in',
          rollNumber: dbRec.roll_number,
          userId: dbRec.user_id,
          quantity: dbRec.quantity || 1,
          purpose: dbRec.purpose || (isRet ? 'Return verification' : 'Testing'),
          durationDays: 7,
          dueDate: dbRec.due_date ? dbRec.due_date.split('T')[0] : '',
          status: 'PENDING',
          requestedAt: dbRec.borrowed_at || new Date().toISOString()
        };
        requestsState[id] = req;
      }
    }

    // Fallback: If not found in server state, reconstruct from client request payload
    if (!req && fallback && (fallback.itemId || fallback.inventory_id || fallback.borrowerEmail || fallback.borrowerName)) {
      const isRet = fallback.type === 'RETURN' || Boolean(fallback.borrowId);
      req = {
        id,
        type: isRet ? 'RETURN' : 'ISSUE',
        borrowId: fallback.borrowId || (isRet ? id : undefined),
        returnQuantity: Number(fallback.returnQuantity || fallback.quantity || 1),
        itemId: fallback.itemId || fallback.inventory_id || '',
        itemName: fallback.itemName || 'Hardware Component',
        category: fallback.category || 'Robotics',
        borrowerName: fallback.borrowerName || fallback.borrower_name || 'Member',
        borrowerEmail: fallback.borrowerEmail || fallback.borrower_email || (fallback.rollNumber ? `${fallback.rollNumber}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in'),
        rollNumber: fallback.rollNumber || fallback.roll_number || null,
        userId: fallback.userId || fallback.user_id,
        quantity: Number(fallback.quantity || fallback.qty) || 1,
        purpose: fallback.purpose || 'Testing',
        durationDays: Number(fallback.durationDays || fallback.duration_days) || 7,
        dueDate: fallback.dueDate || fallback.due_date || '',
        status: 'PENDING',
        requestedAt: fallback.requestedAt || new Date().toISOString()
      };
      requestsState[id] = req;
    }

    if (!req) {
      // If completely unknown, return clean rejection response
      invalidateHardwareRequestsCache();
      return {
        success: true,
        request: {
          id,
          itemId: '',
          itemName: 'Component',
          borrowerName: 'Member',
          borrowerEmail: '',
          quantity: 1,
          purpose: '',
          durationDays: 7,
          dueDate: '',
          status: 'REJECTED',
          requestedAt: new Date().toISOString(),
          reviewedAt: new Date().toISOString(),
          reviewedBy: adminName,
          reviewNote: reason || 'Declined by administrator.'
        }
      };
    }

    if (req.status !== 'PENDING') {
      return { success: true, request: req };
    }

    // If this was a RETURN request, set status back to BORROWED in database
    if (req.type === 'RETURN') {
      try {
        const borrowId = req.borrowId || req.id;
        await supabase.from('borrow_records').update({ status: 'BORROWED' }).eq('id', borrowId);
      } catch (e) {
        console.warn('[REJECT RETURN] Failed to restore BORROWED status in Supabase:', e);
      }
    } else {
      // If this was an ISSUE request persisted in borrow_records, delete the pending record
      try {
        await supabase.from('borrow_records').delete().eq('id', id);
      } catch (e) {
        // Non-blocking
      }
    }

    resolveMatchingInRequestsState(req, id, 'REJECTED', adminName, adminEmail, reason || 'Declined by administrator.');

    // Send rejection email to user (always prioritized)
    if (req.borrowerEmail) {
      sendHardwareRequestStatusEmail(
        req.borrowerEmail,
        req.borrowerName,
        req.itemName,
        req.returnQuantity || req.quantity,
        'REJECTED',
        req.reviewedBy || adminName || 'ADMIN',
        req.reviewNote
      ).catch((e) => console.error('[EMAIL ERROR] Failed to send rejection email to requester:', e));
    }

    // Log audit safely with UUID validation
    try {
      const isUuid = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str));
      await supabase.from('audit_logs').insert([
        {
          action: req.type === 'RETURN' ? 'Rejected Return' : 'Rejected Request',
          user_id: isUuid(req.userId) ? req.userId : null,
          item_id: isUuid(req.itemId) ? req.itemId : null,
          description: `Admin ${adminName || 'ADMIN'} rejected ${req.borrowerName}'s ${req.type === 'RETURN' ? 'return' : 'issue request'} for ${req.returnQuantity || req.quantity}x ${req.itemName}. Reason: ${req.reviewNote}`
        }
      ]);
    } catch (e) {
      // Non-blocking
    }

    return { success: true, request: req };
  } finally {
    processingRequestIds.delete(id);
  }
};
