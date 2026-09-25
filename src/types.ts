export interface BorrowRecord {
    id?: string;
    userId?: string;
    name: string;
    userName?: string;
    borrowerName?: string;
    roll: string;
    userRoll?: string;
    email?: string;
    userEmail?: string;
    qty: number;
    purpose: string;
    date: string;
    dueDate?: string;
    returned?: boolean;
    returnedAt?: string;
    returnDate?: string;
    status?: string;
    adminApprovedBy?: string;
    approvedBy?: string;
    reviewedBy?: string;
}

export interface RequestRecord {
    id: string;
    type?: 'ISSUE' | 'RETURN';
    borrowId?: string;
    returnQuantity?: number;
    itemId: string;
    itemName: string;
    name: string;
    roll: string;
    qty: number;
    originalQuantity?: number;
    queuePosition?: number;
    queueAvailable?: number;
    queueAllocated?: number;
    purpose: string;
    dueDate?: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    requestedAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
    reviewNote?: string;
}

export interface InventoryItem {
    id: string;
    name: string;
    category: string;
    quantity: number;
    availableQuantity?: number;
    location: string;
    specs: string;
    image?: string;
    tags?: string[];
    status?: string;
    borrowedBy: BorrowRecord[];
}

export interface ActivityLog {
    type: 'system' | 'borrow' | 'return' | 'add' | 'request' | 'approve' | 'reject' | 'overdue' | 'low_stock';
    timestamp: string;
    text: string;
}

export interface UserDatabase {
    [username: string]: string; // username -> password mapping
}


