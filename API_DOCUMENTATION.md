# API Documentation — CICR VAULT

Base URL (local dev): `http://localhost:5000`
All request/response bodies are JSON. All responses follow the shape:

```json
{ "status": "success" | "error", "message"?: string, "data"?: any, "count"?: number }
```

## Authentication

Protected routes require a JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

Obtain a token from `POST /api/auth/login`. Tokens are signed with `JWT_SECRET`
(see `.env`) and expire after **7 days**. The decoded payload
(`{ id, email, role }`) is attached to `req.user` by the `authenticateToken`
middleware. Routes marked **Admin only** additionally require `role === 'ADMIN'`
(enforced by `requireAdmin`).

---

## Health

### `GET /api/health`
No auth required.

**Response `200`**
```json
{ "status": "success", "message": "CICR Inventory API is live! 🚀" }
```

---

## Auth — `/api/auth`

### `POST /api/auth/register`
No auth required.

**Body**
```json
{
  "name": "string (required)",
  "email": "string (required)",
  "password": "string (required)",
  "roll_number": "string (optional)",
  "role": "'ADMIN' | 'MEMBER' (optional, defaults to MEMBER)"
}
```

**Response `201`**
```json
{
  "status": "success",
  "message": "User registered!",
  "data": { "id": "uuid", "name": "...", "email": "...", "roll_number": "...", "role": "MEMBER", "created_at": "..." }
}
```

**Errors**: `400` missing fields or email already registered.

---

### `POST /api/auth/login`
No auth required.

**Body**
```json
{ "email": "string (required)", "password": "string (required)" }
```

**Response `200`**
```json
{
  "status": "success",
  "token": "jwt-string",
  "user": { "id": "uuid", "name": "...", "email": "...", "roll_number": "...", "role": "MEMBER" }
}
```

**Errors**: `400` missing fields, `401` invalid credentials.

---

### `GET /api/auth/profile`
**Auth required.**

**Response `200`**
```json
{
  "status": "success",
  "data": { "id": "uuid", "name": "...", "email": "...", "roll_number": "...", "role": "...", "created_at": "..." }
}
```

**Errors**: `404` user not found.

---

## Inventory — `/api/items`

### `GET /api/items`
No auth required.

**Query params** (optional)
- `category` — exact match, e.g. `Controllers`
- `search` — matches against `name` or `description` (case-insensitive, partial)

**Response `200`**
```json
{ "status": "success", "count": 12, "data": [ { "id": "...", "name": "...", "category": "...", "quantity": 10, "available_quantity": 7, "...": "..." } ] }
```

---

### `GET /api/items/categories`
No auth required.

**Response `200`**
```json
{ "status": "success", "data": ["Controllers", "Sensors", "Power", "Actuators", "Tools"] }
```
> Note: this list is hardcoded in the controller, not derived from distinct DB values.

---

### `GET /api/items/:id`
No auth required.

**Response `200`**: single item object. **`404`** if not found.

---

### `POST /api/items`
**Admin only.**

**Body**
```json
{
  "name": "string (required)",
  "description": "string",
  "category": "string (required)",
  "location": "string (required)",
  "quantity": "number (required)",
  "image": "string (optional URL)",
  "tags": "string[] (optional)"
}
```

On create, `available_quantity` is set equal to `quantity`. Writes an
`audit_logs` entry (`action: "Item Added"`).

**Response `201`**: created item. **Errors**: `400` missing required fields.

---

### `PATCH /api/items/:id`
**Admin only.**

**Body**: any subset of item fields to update. If `quantity` is included, the
server recalculates `available_quantity` by applying the delta
(`new_quantity - old_quantity`) to the existing `available_quantity`, floored at 0.
Writes an `audit_logs` entry (`action: "Item Edited"`).

**Response `200`**: updated item. **Errors**: `404` item not found.

---

### `DELETE /api/items/:id`
**Admin only.**

Writes an `audit_logs` entry (`action: "Deleted"`) before removing the row.

**Response `200`**
```json
{ "status": "success", "message": "Item deleted successfully!" }
```

---

## Borrow / Return — `/api/borrow`

### `POST /api/borrow`
**Auth required.**

**Body**
```json
{
  "inventory_id": "uuid (required)",
  "quantity": "number (required, > 0)",
  "purpose": "string (required)",
  "duration_days": "number (optional, default 5, must be 1–30)"
}
```

Validates `quantity <= inventory.available_quantity`, inserts a `borrow_records`
row (`status: "BORROWED"`), decrements `inventory.available_quantity`, and
writes an `audit_logs` entry (`action: "Borrowed"`).

`duration_days` is capped to the **1–30 day** rental window — values outside it
are rejected with `400`. `due_date` is computed as `borrowed_at + duration_days`.

**Response `201`**: the created borrow record.

**Errors**: `400` missing fields, invalid quantity, out-of-range `duration_days`,
or insufficient stock; `404` item not found.

---

### `GET /api/borrow/admins`
**Auth required.**

Lists the **admin directory** used for OTP approval. Each entry: `{ id, name, email }`
(currently **KUSH**).

**Response `200`**
```json
{
  "status": "success",
  "count": 1,
  "data": [
    { "id": "kush", "name": "KUSH", "email": "kushagragargdelhi@gmail.com" }
  ]
}
```

---

### `POST /api/borrow/request-otp`
**Auth required.**

Step 1 of the **admin OTP approval** workflow. Generates a 6-digit OTP
(**10-minute TTL**) and emails it to the selected admin.

**Body**
```json
{
  "item_id": "uuid (required)",
  "quantity": "number (required, > 0)",
  "purpose": "string (optional)",
  "duration_days": "number (optional, default 5, must be 1–30)",
  "selected_admin_id": "string (required — admin id from GET /api/borrow/admins)"
}
```

Validates the item exists and has enough stock *before* any OTP is issued.

**Response `200`**
```json
{
  "status": "success",
  "message": "OTP sent to admin KUSH (kushagragargdelhi@gmail.com). It expires in 10 minutes.",
  "data": {
    "expires_in_seconds": 600,
    "item_id": "...",
    "duration_days": 5,
    "selected_admin": { "id": "kush", "name": "KUSH", "email": "kushagragargdelhi@gmail.com" }
  }
}
```

**Errors**: `400` missing fields / out-of-range `duration_days` / insufficient
stock; `404` unknown admin or item; `502` OTP generated but email failed to send.

---

### `POST /api/borrow/verify-otp`
**Auth required.**

Step 2 of the **admin OTP approval** workflow. Verifies the OTP the student
received from the admin, then completes the borrow (same insert/stock/audit
path as `POST /api/borrow`).

**Body**
```json
{ "otp": "string (required, 6 digits)" }
```

**Response `201`**
```json
{
  "status": "success",
  "message": "OTP verified. Borrow confirmed successfully!",
  "data": {
    "borrow": { "...": "created borrow record" },
    "approved_by_admin_id": "kush"
  }
}
```

**Errors**: `400` missing/invalid/expired OTP, or OTP issued to a different user.

---

### `POST /api/borrow/return-request`
**Auth required.**

Initiates a physical return request for an active loan with customizable return quantity (full or partial). Requests are routed to the Admin Portal queue awaiting administrative inspection and verification.

**Body**
```json
{
  "borrowId": "string (required, loan ID)",
  "returnQuantity": "number (optional, defaults to all issued units)"
}
```

**Response `200`**
```json
{
  "status": "success",
  "message": "Return request submitted successfully. Awaiting administrator verification in the Admin Portal.",
  "data": {
    "id": "req-ret-178950...",
    "type": "RETURN",
    "borrowId": "0a666766-...",
    "returnQuantity": 1,
    "status": "PENDING"
  }
}
```

---

### `POST /api/borrow/requests/:id/approve`
**Auth required (Admin only).**

Approves a pending hardware issue or return request. When approving a return, inventory `available_quantity` is restored, and the borrow record is marked as `RETURNED` (or updated with remaining borrowed quantity for partial returns).

---

### `POST /api/borrow/return`
**Auth required.**

**Body**
```json
{ "borrow_id": "uuid (required)" }
```

Sets the matching `borrow_records` row to `status: "RETURNED"` with a
`return_date` timestamp, restores the quantity to `inventory.available_quantity`,
and writes an `audit_logs` entry (`action: "Returned"`).

**Response `200`**: the updated borrow record.

**Errors**: `400` missing `borrow_id` or already returned; `404` record not found.

---

### `GET /api/borrow/history`
**Auth required.**

Members see only their own records; admins see all records. Each record is
joined with the borrowing user (`name`, `email`, `roll_number`) and the item
(`name`, `category`, `image`).

**Response `200`**
```json
{ "status": "success", "count": 5, "data": [ { "id": "...", "status": "BORROWED", "users": { "...": "..." }, "inventory": { "...": "..." } } ] }
```

---

## Dashboard — `/api`

### `GET /api/stats`
No auth required.

**Response `200`**
```json
{
  "status": "success",
  "data": {
    "total_items": 12,
    "total_users": 40,
    "active_borrows": 6,
    "total_quantity": 250,
    "available_quantity": 190,
    "borrowed_quantity": 60
  }
}
```

---

### `GET /api/audit`
**Auth required.**

Returns the 50 most recent audit log entries, newest first, joined with the
acting user (`name`, `email`) and referenced item (`name`).

**Response `200`**
```json
{ "status": "success", "count": 50, "data": [ { "id": "...", "action": "Borrowed", "description": "...", "timestamp": "...", "users": {"...":"..."}, "inventory": {"...":"..."} } ] }
```

---

## Route summary

| Method | Path                     | Auth        |
| ------ | ------------------------- | ----------- |
| GET    | `/api/health`              | None        |
| POST   | `/api/auth/register`       | None        |
| POST   | `/api/auth/login`          | None        |
| GET    | `/api/auth/profile`        | Token       |
| GET    | `/api/items`                | None        |
| GET    | `/api/items/categories`     | None        |
| GET    | `/api/items/:id`            | None        |
| POST   | `/api/items`                | Admin       |
| PATCH  | `/api/items/:id`            | Admin       |
| DELETE | `/api/items/:id`            | Admin       |
| POST   | `/api/borrow`               | Token       |
| GET    | `/api/borrow/admins`        | Token       |
| POST   | `/api/borrow/request-otp`   | Token       |
| POST   | `/api/borrow/verify-otp`    | Token       |
| POST   | `/api/borrow/return`        | Token       |
| GET    | `/api/borrow/history`       | Token       |
| GET    | `/api/stats`                | None        |
| GET    | `/api/audit`                | Token       |

Source: `backend/src/app.ts` and each module's `*.routes.ts` under
`backend/src/modules/`.
