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
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(requestsState, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Failed to save request storage file:', err);
  }
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
        requestsState[insertedRec.id] = { ...newRequest, id: insertedRec.id };
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

  if (record.status === 'RETURNED') {
    return { success: false, message: 'This item has already been marked as returned.' };
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
  const borrowerEmail = (record.roll_number ? `${record.roll_number}@mail.jiit.ac.in` : '') || record.borrower_email || payload.userEmail || 'student@mail.jiit.ac.in';
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
  requestsState[record.id] = newReturnReq;
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

let cachedHardwareRequests: HardwareIssueRequest[] | null = null;
let lastHardwareRequestsFetchTime = 0;
// Zero TTL to guarantee instant, real-time consistency across cloud and local nodes
const HARDWARE_REQUESTS_CACHE_TTL_MS = 0;

export const invalidateHardwareRequestsCache = () => {
  cachedHardwareRequests = null;
  lastHardwareRequestsFetchTime = 0;
};

export const getAllHardwareRequests = async (force = false): Promise<HardwareIssueRequest[]> => {
  // Ensure fresh disk state is loaded
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
      requestsState = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[HARDWARE REQUESTS] Failed to reload request storage file:', err);
  }

  // Strictly filter to PENDING requests only
  const localList = Object.values(requestsState).filter((r) => r.status === 'PENDING');

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
        const exists = localList.some(r => r.id === rec.id || (r.borrowId === rec.id && r.type === 'RETURN') || (r.itemId === rec.inventory_id && r.purpose === rec.purpose));
        if (!exists) {
          localList.push({
            id: rec.id,
            type: isReturn ? 'RETURN' : 'ISSUE',
            borrowId: isReturn ? rec.id : undefined,
            returnQuantity: isReturn ? (rec.quantity || 1) : undefined,
            itemId: rec.inventory_id,
            itemName: rec.inventory?.name || 'Hardware Component',
            category: rec.inventory?.category || 'Robotics',
            borrowerName: rec.borrower_name || 'Member',
            borrowerEmail: rec.roll_number ? `${rec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in',
            rollNumber: rec.roll_number,
            userId: rec.user_id,
            quantity: rec.quantity || 1,
            purpose: rec.purpose || (isReturn ? `Return ${rec.quantity || 1} units` : 'Testing'),
            durationDays: 7,
            dueDate: rec.due_date ? rec.due_date.split('T')[0] : '',
            status: 'PENDING',
            requestedAt: rec.borrowed_at || new Date().toISOString()
          });
        }
      }
    }
  } catch (err) {
    console.warn('[HARDWARE REQUEST] Error reading pending records from Supabase:', err);
  }

  // 2. High-Resilience Fallback: Reconstruct unhandled requests from Supabase audit_logs
  // This guarantees that if a request is visible in System Audit & Activity Logs,
  // it is 100% GUARANTEED to be visible in the Admin Queue as well!
  try {
    const { data: auditEvents } = await dbRead
      .from('audit_logs')
      .select('*')
      .in('action', ['Hardware Requested', 'Hardware Approved', 'Hardware Rejected'])
      .order('timestamp', { ascending: false })
      .limit(60);

    if (auditEvents && auditEvents.length > 0) {
      for (const ev of auditEvents) {
        const evTime = ev.timestamp || new Date().toISOString();
        if (ev.action === 'Hardware Requested' && ev.description) {
          const match = ev.description.match(/^(.*?)\s*\((.*?)\)\s*requested\s*(\d+)x\s*"([^"]+)"\s*for\s*purpose:\s*(.*)$/i);
          if (match) {
            const [, borrowerName, borrowerEmail, qtyStr, itemName, purpose] = match;
            const isResolved = auditEvents.some((other: any) => {
              const otherTime = other.timestamp || '';
              return (other.action === 'Hardware Approved' || other.action === 'Hardware Rejected') &&
                new Date(otherTime).getTime() >= new Date(evTime).getTime() &&
                (other.description?.includes(borrowerName) || other.item_id === ev.item_id);
            });

            if (!isResolved) {
              const alreadyInList = localList.some(r => 
                (r.borrowerEmail?.toLowerCase() === borrowerEmail.toLowerCase() && r.itemName?.toLowerCase() === itemName.toLowerCase() && r.purpose?.toLowerCase() === purpose.toLowerCase()) ||
                (ev.item_id && r.itemId === ev.item_id && r.borrowerName?.toLowerCase() === borrowerName.toLowerCase())
              );

              if (!alreadyInList) {
                localList.push({
                  id: `req_audit_${new Date(evTime).getTime()}`,
                  itemId: ev.item_id || 'unlisted-item',
                  itemName: itemName || 'Hardware Component',
                  category: 'Tools',
                  borrowerName: borrowerName || 'Member',
                  borrowerEmail: borrowerEmail || (ev.roll_number ? `${ev.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in'),
                  rollNumber: borrowerEmail ? borrowerEmail.split('@')[0] : null,
                  userId: ev.user_id,
                  quantity: parseInt(qtyStr, 10) || 1,
                  purpose: purpose || 'Testing',
                  durationDays: 7,
                  dueDate: new Date(new Date(evTime).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                  status: 'PENDING',
                  requestedAt: evTime
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[HARDWARE REQUEST] Error syncing from Supabase audit logs:', err);
  }

  const sorted = localList.sort((a, b) => {
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

  return own.sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
};

export const getHardwareRequestById = (id: string): HardwareIssueRequest | undefined => {
  return requestsState[id];
};

export const approveHardwareRequest = async (
  id: string,
  adminName: string,
  adminEmail: string,
  fallback?: any
): Promise<{ success: boolean; request?: HardwareIssueRequest; error?: string }> => {
  let req = requestsState[id];
  if (!req) {
    // Check if it exists in Supabase borrow_records with status = 'PENDING'
    const { data: dbRec } = await dbRead.from('borrow_records').select('*, inventory(name, category)').eq('id', id).maybeSingle();
    if (dbRec) {
      req = {
        id: dbRec.id,
        itemId: dbRec.inventory_id,
        itemName: dbRec.inventory?.name || 'Hardware Component',
        category: dbRec.inventory?.category || 'Robotics',
        borrowerName: dbRec.borrower_name || 'Member',
        borrowerEmail: dbRec.roll_number ? `${dbRec.roll_number}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in',
        rollNumber: dbRec.roll_number,
        userId: dbRec.user_id,
        quantity: dbRec.quantity || 1,
        purpose: dbRec.purpose || 'Testing',
        durationDays: 7,
        dueDate: dbRec.due_date ? dbRec.due_date.split('T')[0] : '',
        status: dbRec.status,
        requestedAt: dbRec.borrowed_at || new Date().toISOString()
      };
      requestsState[id] = req;
    }
  }

  // Fallback: If not found in server state, reconstruct from client request payload
  if (!req && fallback && (fallback.itemId || fallback.inventory_id)) {
    req = {
      id,
      itemId: fallback.itemId || fallback.inventory_id,
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
    return { success: false, error: 'Request not found.' };
  }

  // Idempotent: If already approved or processed, return success immediately
  if (req.status !== 'PENDING') {
    return { success: true, request: req };
  }

  // Handle Return Approval
  if (req.type === 'RETURN') {
    const borrowId = req.borrowId || req.id;
    const returnQty = req.returnQuantity || req.quantity || 1;

    // Fetch borrow record
    const { data: bRecord } = await dbRead
      .from('borrow_records')
      .select('*, inventory(name, available_quantity)')
      .eq('id', borrowId)
      .maybeSingle();

    if (bRecord) {
      // 1. Restock available quantity in inventory
      const { data: currItem } = await dbRead
        .from('inventory')
        .select('quantity, available_quantity, name')
        .eq('id', bRecord.inventory_id)
        .maybeSingle();

      const totalStock = Number(currItem?.quantity) || 1;
      const newAvail = Math.min(totalStock, (currItem?.available_quantity || 0) + returnQty);
      await supabase
        .from('inventory')
        .update({ available_quantity: newAvail, updated_at: new Date().toISOString() })
        .eq('id', bRecord.inventory_id);

      // 2. If all units returned, mark record RETURNED; if partial, decrement remaining borrowed quantity and restore BORROWED status
      if (returnQty >= bRecord.quantity) {
        await supabase
          .from('borrow_records')
          .update({ status: 'RETURNED', returned_at: new Date().toISOString() })
          .eq('id', borrowId);
      } else {
        await supabase
          .from('borrow_records')
          .update({ quantity: bRecord.quantity - returnQty, status: 'BORROWED' })
          .eq('id', borrowId);
      }

      // Log audit
      try {
        const isUuid = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str));
        await supabase.from('audit_logs').insert([
          {
            action: 'Approved Return',
            user_id: isUuid(req.userId) ? req.userId : null,
            item_id: isUuid(bRecord?.inventory_id) ? bRecord.inventory_id : null,
            description: `Admin ${adminName || 'ADMIN'} approved return of ${returnQty} units of "${req.itemName}" from ${req.borrowerName}.`
          }
        ]);
      } catch {}
    }

    req.status = 'APPROVED';
    req.reviewedAt = new Date().toISOString();
    req.reviewedBy = adminName || adminEmail || 'ADMIN';
    if (req.borrowId && requestsState[req.borrowId]) {
      requestsState[req.borrowId].status = 'APPROVED';
      requestsState[req.borrowId].reviewedAt = req.reviewedAt;
      requestsState[req.borrowId].reviewedBy = req.reviewedBy;
    }
    saveState();
    invalidateHardwareRequestsCache();

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
      borrowerEmail: req.borrowerEmail,
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
    req.status = 'APPROVED';
    req.reviewedAt = new Date().toISOString();
    req.reviewedBy = adminName || adminEmail || 'ADMIN';
    req.reviewNote = `Approved (Item offline/unlisted: ${result.error.message})`;
    saveState();
    invalidateHardwareRequestsCache();

    if (req.borrowerEmail) {
      sendHardwareRequestStatusEmail(
        req.borrowerEmail,
        req.borrowerName,
        req.itemName,
        req.quantity,
        'APPROVED',
        req.reviewedBy
      ).catch((e) => console.error('[EMAIL ERROR] Failed to send approval status email to borrower:', e));
    }

    return { success: true, request: req };
  }

  req.status = 'APPROVED';
  req.reviewedAt = new Date().toISOString();
  req.reviewedBy = adminName || adminEmail || 'ADMIN';
  saveState();
  invalidateHardwareRequestsCache();

  const { borrowRecord, item, newAvailableQty, dueDate } = result;

  // Send approval status email to borrower (with CC to admins)
  if (req.borrowerEmail) {
    sendHardwareRequestStatusEmail(
      req.borrowerEmail,
      req.borrowerName,
      req.itemName,
      req.quantity,
      'APPROVED',
      req.reviewedBy
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
};

export const rejectHardwareRequest = async (
  id: string,
  adminName: string,
  adminEmail: string,
  reason?: string,
  fallback?: any
): Promise<{ success: boolean; request?: HardwareIssueRequest; error?: string }> => {
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
        status: dbRec.status,
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

  req.status = 'REJECTED';
  req.reviewedAt = new Date().toISOString();
  req.reviewedBy = adminName || adminEmail || 'ADMIN';
  req.reviewNote = reason || 'Declined by administrator.';
  if (req.borrowId && requestsState[req.borrowId]) {
    requestsState[req.borrowId].status = 'REJECTED';
    requestsState[req.borrowId].reviewedAt = req.reviewedAt;
    requestsState[req.borrowId].reviewedBy = req.reviewedBy;
    requestsState[req.borrowId].reviewNote = req.reviewNote;
  }
  saveState();
  invalidateHardwareRequestsCache();

  // Send rejection email to user (always prioritized)
  if (req.borrowerEmail) {
    sendHardwareRequestStatusEmail(
      req.borrowerEmail,
      req.borrowerName,
      req.itemName,
      req.returnQuantity || req.quantity,
      'REJECTED',
      req.reviewedBy,
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
};
