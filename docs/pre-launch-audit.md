# Pre-launch audit: e-LMS × Shopify ("Teach Me Like a Tot")

| | |
|---|---|
| Client | Instructional Graphics LLC |
| Code audited | branch `e-lms-v8`, commit `fcaa669` (identical to `e-lms-v7`) |
| Audit date | 2026-11-20 |
| Type | Read-only code audit. No code changed, no migrations, no orders, no live services touched. |
| Tests run | **None.** The repository has no automated test suite (`package.json` has no `test` script, and there are no test files). `npm run typecheck` was not run because it writes generated files. Every status below comes from reading code. |
| Update | **2026-11-20:** the seven bugs in section 3 (B1–B7) are **fixed** in commit `7ab3e84` and verified against a local copy of the app. See [Fix status](#fix-status-2026-11-20). The statuses below are as audited at `fcaa669`; rows the fixes change carry an **Update** note. |

## Fix status (2026-11-20)

All seven bugs are fixed in commit `7ab3e84`. The new features in section 3 (MFA, organizations and the rest) are **not** built; they remain new work.

| Bug | What changed | How it was verified |
|---|---|---|
| B1 | Default device limit is now **2**. A migration sets the new default and moves accounts still on the old default (1) to 2. Unlimited (0) and other admin-chosen values stay. | Migration run on a copy of the old schema: 1 became 2, 0 and 3 were unchanged. A newly registered account got 2. Devices A and B stayed signed in together, and a third sign-in still left exactly 2 active sessions. |
| B2 | Shopify **test orders issue no keys**; the admin gets an email instead. A staging server can opt in with `SHOPIFY_ALLOW_TEST_ORDERS=true`. | Signed test-order delivery: no key issued. With the flag set: key issued. |
| B3 | `orders/cancelled` is ignored unless the payload has `cancelled_at`, so a paid order's signed body replayed with the cancelled topic can't revoke keys. Recording `X-Shopify-Webhook-Id` was not added: order and refund IDs already make repeat deliveries harmless. | Paid body sent as `orders/cancelled`: ignored, key stayed PENDING. A genuine cancellation still revoked its key. |
| B4 | The Shopify order number (`#1001`) is stored on each key and order, is searchable ("#1001" or "1001"), and appears in a new Order column, the admin emails and the CSV export. | Both search forms found the key. The Order column showed `#1001`. The CSV had a "Shopify Order Number" column. |
| B5 | Paid items that match no course are **recorded on the order** and listed on the License Keys page until an admin marks them resolved. A later delivery that maps them, or a cancellation, clears the flag. | A mixed order and a fully unmatched order were both recorded and listed. The cancelled one dropped off the list, and "Mark resolved" cleared the other. |
| B6 | Activation emails no longer say "Order Confirmed", and the steps tell returning customers to sign in so all their courses stay on one account. | Code review only. Emails weren't sent: the test environment has no Resend key. |
| B7 | In production the server **refuses to start without a valid `APP_URL`**, instead of emailing `http://localhost` links. `npm run doctor` checks it. | In production mode: refused with `APP_URL` unset and with `lms.example.com`; started with a valid URL. |

**Also checked:**
- Typecheck passes.
- After the migrations, `prisma migrate diff` shows no difference from `schema.prisma`.
- Flows that worked before still work: retries, refunds, genuine cancellations, and rejection of bad signatures.

**Before deploying:**
- **`APP_URL` must be set on the server, or the app will not start.**
- The two migrations run automatically on "Restart App".
- Nothing new needs registering in Shopify.
- For manual end-to-end tests on staging, set `SHOPIFY_ALLOW_TEST_ORDERS=true` there, and never on the live server.

## How to read the statuses

**Status**

- **Implemented**: the code does what the requirement asks.
- **Partial**: some of it exists, or it works differently from what the requirement asks.
- **Missing**: no code path exists.
- **Unclear**: it can't be decided from the code.

**Basis** (how each status was established)

- **Read**: I traced the code path end to end.
- **Grep**: I confirmed the absence by searching the whole `app/`, `prisma/` and `scripts/` tree.
- **Inferred**: I reasoned from the code about browser or Shopify behaviour without running it.
- **Config**: the result also depends on Shopify admin or server environment settings that are not in this repository.

**Classification** (for Partial and Missing items)

- **Bug**: a code path exists but does not meet the requirement.
- **Not built**: no code path exists, so this is new work.
- **Config**: Shopify or env setup only, no code.
- **Decision**: the client has to choose.

I have not seen the development agreement. Items that could go either way are marked *arguable*.

**File references** use the file name and line numbers. Every name is unique in the repo:

- `app/routes/`: `shopify.webhook.tsx`, `redeem.tsx`, `licenses.tsx`, `users.tsx`, `sessions.tsx`, `auth.*.tsx`, `student.*.tsx`, `certificate.$courseId.tsx`, `settings.tsx`, `reports.export.tsx`
- `app/utils/`: `auth.server.ts`, `shopify.server.ts`, `license.ts`, `license.server.ts`, `access.server.ts`, `email.server.ts`, `rate-limit.server.ts`, `storyline.ts`
- `app/components/`: `StorylinePlayer.tsx`
- `prisma/`: `schema.prisma`

---

## Headline findings

1. **A paid order does not unlock a course automatically. It emails a licence key.**
   - The webhook creates PENDING keys and emails them to the buyer.
   - Access starts only when someone opens the link and redeems the key, by creating an account or signing in.
   - The webhook never creates users. Keys are bearer codes: whoever holds one can redeem it under any email.
2. **The device limit does not block a third device.**
   - Every login succeeds. The least recently used session is signed out instead.
   - The default limit was **1** per user, not 2. It's set per user in the database (`schema.prisma:62`), and there is no global setting. **Update (B1, fixed):** the default is now 2, for new and existing accounts.
   - Enforcement is server-side and works on *concurrent sessions*, not registered devices.
   - The project docs describe this eviction behaviour as intended (`projectv2.md:581`), so changing it is a change request, not a defect.
3. **There is no MFA of any kind**, for admins or learners. There's no new-device verification either. Admin accounts are protected only by an 8-character-minimum password and the email reset flow.
4. **There are no organizations.**
   - Bulk orders produce the right number of keys for the right course, tied to the Shopify order ID and buyer email.
   - There's no organization record, invitation email, seat-balance view or manager portal.
   - The `CORPORATE` role exists only as a dropdown label.
5. **A bundle sold as its own Shopify product cannot unlock both courses.** Each line item maps to exactly one course. The bundle works only if Shopify puts the two courses on the order as separate line items.
6. **Payment-state handling is solid.**
   - Signatures are verified with a timing-safe compare.
   - Retries and concurrent deliveries are idempotent.
   - Pending and failed payments issue nothing, cancellations revoke, and full refunds revoke the returned seats.
   - **Shopify test orders are treated as real orders**, so test-mode payments left on in production would grant free access. **Update (B2, fixed):** test orders now issue no keys unless a staging server opts in.
7. **Reconciliation and failure recovery are thin.**
   - Only Shopify's internal order ID is stored, not the `#1001` order number staff see. **Update (B4, fixed):** the order number is now stored and searchable.
   - A paid order whose item didn't match a course leaves no record in the LMS database. It produces only an admin email and a log line. **Update (B5, fixed):** such orders are now recorded and listed for the admin.
   - There's no way to re-pull an order from Shopify.
   - There's no way to correct the email on a licence.

---

## 1. Architecture

### Stack

- React Router v7 (framework mode, SSR) on Node/Express (`server.js`), TypeScript, Tailwind.
- PostgreSQL via Prisma 7 (`@prisma/adapter-pg`).
- Auth: bcrypt passwords and a JWT in an HttpOnly cookie, backed by a `UserSession` table.
- Email: Resend. Media: Cloudinary. Storyline lessons run in iframes from a separate origin.
- Deployed on Plesk (`PLESK_DEPLOYMENT.md`).

### How Shopify talks to the LMS

- **Webhooks only, one endpoint:** `POST /shopify/webhook` (`shopify.webhook.tsx`). It handles three topics (`shopify.webhook.tsx:22`), all registered by hand in Shopify admin (`PLESK_DEPLOYMENT.md:199-213`):
  - `orders/paid`
  - `refunds/create`
  - `orders/cancelled`
- **No Shopify Admin API calls, no app proxy, no Storefront API.** `SHOPIFY_ACCESS_TOKEN` appears in `.env.example:38` but no code reads it.
- **Product-to-course mapping** (`shopify.webhook.tsx:580-600`): the variant SKU must equal the course's UUID. Failing that, the line item's `product_id` must match `Course.shopifyProductId`, which is one product per course (`schema.prisma:276`). A product ID set on two courses is refused, not split.

### Data model (relevant parts)

| Model | Purpose | Key fields |
|---|---|---|
| `User` (`schema.prisma:53-72`) | Learner or admin account | `email` (unique), `role` ADMIN/STUDENT/CORPORATE, `maxDevices` (default 1), `isBanned`, `isSuspended`. No MFA fields. |
| `UserSession` (`:87-101`) | One row per sign-in. This is what the code calls a "device". | `token` (SHA-256 of the JWT), `deviceId` (hash of user agent and IP), `isActive`, `expiresAt`, `lastActiveAt` |
| `License` (`:439-473`) | The entitlement. One key unlocks one course for one user. | `key`, `status` PENDING/ACTIVE/REVOKED, `courseId`, `userId`, `customerEmail`, `shopifyOrderId`, `shopifyLineItemId`, `amountPaid`, `isBulk`, `revokedReason` |
| `ShopifyOrder` (`:240-247`) | Per-order lock and cancellation marker | `orderId` (Shopify's internal numeric ID), `cancelledAt` |
| `ShopifyRefund` (`:252-262`) | Refund de-duplication | `refundId`, `orderId`, `lineItems` |
| `Enrollment`, `Progress`, `LessonProgress`, `QuizAttempt` | Progress records. Access is decided by the licence alone (`access.server.ts:21-27`). | |
| *Organization, Device, MFA secret, invitation, order line, webhook log* | **Do not exist** | |

### Order-to-entitlement flow (`orders/paid`)

1. **Verify the request.** Shopify POSTs the order and the HMAC-SHA256 of the raw body is checked. A missing secret means everything is rejected (`shopify.webhook.tsx:47-54`, `shopify.server.ts:9-29`).
2. **Skip non-payable orders.** A cancelled order, or a `financial_status` other than `paid` or `partially_refunded`, returns 200 and is ignored (`:114-121`).
3. **Map line items to courses.** Each line item is matched to a course. Items that don't match are collected as "unmapped" (`:143-165`). If nothing matched, the webhook emails the admin and returns 200 **without writing anything to the database** (`:171-187`).
4. **Mint the keys.** In one transaction with a row lock on `ShopifyOrder` (`:192-262`, `:540-548`):
   - If the order was already cancelled, issue nothing.
   - Otherwise, top up each line item to (quantity − refunded) keys. Keys are created PENDING with the order ID, line item ID, per-unit amount paid and `isBulk = quantity > 1` (`:245-257`).
   - A duplicate delivery finds nothing missing and creates nothing.
5. **Send emails after the commit, without waiting for them** (`:279-296`, `:607-617`):
   - The buyer gets one email with every key and its `/redeem?key=…` link.
   - The admin gets a notification.
   - A failed email is logged only.
6. **Activation.** The learner opens the link and either creates an account or signs in to an existing one with its password. The key turns ACTIVE and is tied to that user (`redeem.tsx:106-278`). Holding an ACTIVE licence is the only thing that opens a course (`access.server.ts:53-63`).

`refunds/create` revokes the returned seats, unredeemed keys first (`shopify.webhook.tsx:349-456`). `orders/cancelled` revokes every key on the order and blocks any later `orders/paid` for it (`:463-515`).

---

## 2. Requirement-by-requirement results

### 1. Storefront and purchasing

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 1.1 | Money → Money only; Markets → Markets only; bundle → both | **Partial** | Read, Config | `shopify.webhook.tsx:580-600`, `schema.prisma:276` | Single courses work once each product's SKU or product ID is mapped. Each line item maps to one course. A bundle sold as its own product unlocks at most one course; if its product ID is put on both courses, the line is refused and nothing is issued. It works only if Shopify records the two courses as separate line items, as Shopify's Bundles app is meant to (confirm with a test order). |
| 1.2 | Returning customer, same email, keeps one account with both entitlements | **Implemented** (with a caveat) | Read | `redeem.tsx:172-227`, `:238-257`; `license.server.ts:48-64` | Redeeming with an existing email requires that account's password and attaches the course to it. The webhook never creates users, so there are no duplicate accounts from orders. Caveat: the key isn't bound to the order email. A learner who redeems under a different email ends up with a second account. |
| 1.3 | Abandoned checkout, declined or pending payment create no access | **Implemented** | Read, Config | `shopify.webhook.tsx:22`, `:114-121` | Only `orders/paid` issues keys, and other `financial_status` values are ignored. There are no checkout handlers. If the store uses manual payment capture, keys wait until capture. **Update (B2, fixed):** Shopify test orders (test payments) no longer issue keys unless a staging server sets `SHOPIFY_ALLOW_TEST_ORDERS=true`. |
| 1.4 | Approved discounts still produce correct access | **Implemented** | Read | `shopify.webhook.tsx:705-715` | Access never depends on price. Discounts only change the recorded `amountPaid`. Whether Shopify sends `orders/paid` for a $0 (100%-off) order needs a manual test. |
| 1.5 | Duplicate purchase handled with "You already have access" | **Partial** | Read | `redeem.tsx:238-266` | Nothing stops or flags the second purchase: the buyer is charged and a second key is issued. The notice appears only when they try to *redeem* that key, which then stays unused and can be given away. |

### 2. Draft orders and bulk/organizational sales

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 2.1 | Draft order with licence quantity, bulk pricing, organization as customer | **Partial** | Read, Config | `shopify.webhook.tsx:143-165`, `:694-715` | A paid draft order arrives as a normal `orders/paid`. Quantity N produces N keys, and the per-unit price after discounts is recorded. The LMS has no organization concept; the "customer" is the order email. **Custom line items** (no product ID, usually no SKU) won't map, so they issue no keys. Draft orders must use the real product variants. |
| 2.2 | No licences until payment confirmed | **Implemented** | Read, Config | `shopify.webhook.tsx:22`, `:118-121` | Draft orders on payment terms stay `pending`, and keys are issued only when `orders/paid` fires. |
| 2.3 | Exact number and type of licences, tied to the right organization | **Partial** | Read | `shopify.webhook.tsx:226-257`, `schema.prisma:439-473` | The count and course are exact per line item, and idempotent. Keys are tied to the order ID and buyer email, not to an organization (no such model). |
| 2.4 | Licence assignment, activation, learner invitation, remaining-seat balance | **Partial** | Read, Grep | `email.server.ts:202-295`, `licenses.tsx:406-501`, `users.tsx:36` | Activation works by key. The buyer gets one email listing all keys and must forward them by hand. An admin can "Release Seat", which reissues a new key. There's **no invitation email, no org-manager view, and no seat balance** anywhere; an admin can only count an order's PENDING keys through search. `CORPORATE` is a label with no behaviour. |
| 2.5 | Can LMS licence issuance be linked to the purchase? | **Implemented** | Read | `schema.prisma:448-457`, `shopify.webhook.tsx:245-257` | Yes. Every webhook key stores `shopifyOrderId` (Shopify's internal order ID), `shopifyLineItemId` and `amountPaid`, and keys are issued only by the paid-order webhook. **Admin-generated keys and "Grant Access" have no order link** (`licenses.tsx:650-694`, `:331-404`). |
| 2.6 | Admin can see the Shopify order and its matching LMS licence records | **Partial** | Read | `licenses.tsx:113-123`, `:1440-1448`; `reports.export.tsx:31-61` | Admins can search licences by order ID, and the CSV export has an order column. The licence list itself has no order column. Only the internal numeric ID is stored, not the `#1001` number staff see in Shopify's order list. There's no payment status, per-order summary, or link to Shopify. **Update (B4, fixed):** the order number (`#1001`) is stored, searchable, and shown in a new Order column and the CSV. Still missing: payment status, a per-order summary, a link to Shopify (N6). |

### 3. Automated licensing and enrollment

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 3.1 | New customers receive working activation details | **Implemented** (depends on config) | Read, Config | `shopify.webhook.tsx:279-296`; `email.server.ts:39`, `:78-192` | The email contains the key and a one-click `/redeem?key=` link. It needs `RESEND_API_KEY`, a verified sending domain and `APP_URL`. **If `APP_URL` is unset, links silently point to `http://localhost:5173`.** The copy tells every buyer to "create your account", including returning customers (`:145`). **Update (B6, B7, fixed):** the server now refuses to start in production without a valid `APP_URL`, and the email tells returning customers to sign in. |
| 3.2 | Repeated notifications or retries never create extra licences or duplicate users; signature verified | **Implemented** | Read | `shopify.server.ts:9-29`; `shopify.webhook.tsx:47-54`, `:192-262`, `:375`, `:472-478` | The HMAC is checked over the raw body with a timing-safe compare, and the request is rejected if the secret is unset. A per-order row lock plus a per-line-item top-up means a duplicate creates nothing. Refunds are de-duplicated by refund ID and cancellations by `cancelledAt`. The webhook never creates users. One low-severity gap: the topic header isn't signed (see S5). |
| 3.3 | Temporary delivery failure leaves the paid order traceable and recoverable | **Partial** | Read, Config | `shopify.webhook.tsx:171-187`, `:305-309`, `:607-617`; `licenses.tsx:182-208` | A database error returns 500, so Shopify retries for a limited time; check Shopify's current retry window. If the email fails, the keys are still saved and an admin can "Resend Email" one key at a time. Gaps: unmapped items leave **no database record**; there's no queue or failed-order list; there's no way to re-pull an order from Shopify; and manual re-issue isn't linked to the order. The code's recovery notes say to "re-send the order's webhook from Shopify", but I could not confirm Shopify admin offers that for a real order. **Update (B5, fixed):** unmatched paid items are now recorded on the order and listed on the License Keys page until resolved. Still missing: re-pulling an order from Shopify (N7) and order-linked manual re-issue. |

### 4. Device login restriction

See [section 4](#4-device-restriction-exact-behaviour) for the exact definitions.

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 4.1 | Two devices allowed: A and B succeed, C blocked with a clear message | **Partial** (works differently) | Read | `auth.server.ts:164-228`, `:192`; `schema.prisma:62`; `auth.login.tsx:198-209` | **C is never blocked.** Every login succeeds and ends the least recently used session(s) over the limit. The evicted device sees "You were signed out on this device…" on its next request. **The default limit is 1, not 2.** **Update (B1, fixed):** the default is now 2 devices. A third device still signs out the oldest instead of being blocked (N3, a decision for the client). |
| 4.2 | Logout, browser restart, private mode, different browser, network change: no unintended lockout | **Implemented** (under eviction rules) | Read; browser behaviour Inferred | `auth.server.ts:95-103`, `:130-156`, `:203-213`, `:246-264`, `:304-314` | A lockout is impossible because logins never fail on the limit. Per-scenario behaviour is in section 4. One side effect: a private window or second browser counts as another device and can push out the learner's other real device. |
| 4.3 | Device release/reset lets a replacement device log in | **Implemented** | Read | `sessions.tsx:130-147`; `users.tsx:223-232`; `student.settings.tsx:170-177` | Admins can force-logout one session or all of a user's. Learners can "sign out other devices" and log out. With eviction, a replacement device can always sign in anyway. |
| 4.4 | Admin device-management view; admin revoke/reset of a stuck device or session | **Implemented** | Read | `sessions.tsx:25-103`; `users.tsx:199-232` | `/sessions` lists active sessions with IP, user agent and last activity. Admins can force-logout per session or per user, and can edit a user's device limit (0 = unlimited, max 50). |
| 4.5 | Definitions of "device" and "active session", registered vs concurrent, where the limit is configured | **Read** | Read | see section 4 | Concurrent sessions, per-user `maxDevices`, default 1, enforced on the server. |

### 5. Learner experience and notifications

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 5.1 | Emails: order receipt, course activation, organizational invitation, password reset | **Partial** | Read, Config | `email.server.ts:78-295`, `:486-511`; `auth.forgot-password.tsx:12-32` | **Activation:** yes. **Password reset:** yes, with a 1-hour link. **Receipt:** Shopify's own order confirmation (configured in Shopify); the LMS key email is headed "Order Confirmed" but has no order number or amounts. **Organizational invitation:** none. |
| 5.2 | Launch lessons, move between them, Storyline "Continue", return to saved progress | **Implemented** in the LMS; Storyline side **Unclear** | Read, Config | `student.course.$courseId.tsx:517-597`, `:262-268`; `storyline.ts:10-48`; `StorylinePlayer.tsx:77-106` | Lesson completion is saved on the server, the player auto-advances, and the dashboard resumes "where you left off". Storyline completion only works if **every published package contains the postMessage trigger** (see `STORYLINE_INTEGRATION.md`). The position *inside* a Storyline lesson is Storyline's own browser-side resume, not stored by the LMS, so it won't follow the learner to another device. |
| 5.3 | Quiz scores and progress persist after logout/login | **Partial** | Read, Grep | `student.course.$courseId.tsx:598-772`; `schema.prisma:477-491` | Quizzes built in the LMS are graded on the server and stored in `QuizAttempt`, so they persist. **Scores from quizzes inside Storyline are not captured at all**: there's no SCORM or xAPI, and the lesson only sends a "completed" message. |
| 5.4 | No physical shipping, pickup or fulfilment wording anywhere | **Implemented** in the LMS; Shopify **Unclear** | Grep, Config | n/a | The app code has no such wording. The storefront, checkout and Shopify notification templates are Shopify configuration. Orders will stay **"Unfulfilled"** in Shopify because the LMS never marks them fulfilled. |

### 6. MFA, passwords, and recovery

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 6.1 | MFA enrollment and verification for learners and admins, and where it is enforced | **Missing** | Grep, Read | `auth.login.tsx:34-98`; `schema.prisma:53-72` | No MFA code, database fields or libraries exist. Sign-in is password only for every role. |
| 6.2 | Incorrect, expired, reused codes and repeated failures never grant access | **Missing** (no codes); only login throttling exists | Read | `rate-limit.server.ts:24-40`, `:133-140`; `auth.login.tsx:44`, `:63` | Login allows 10 failed attempts per email per 15 minutes, plus 40 per IP only when `TRUST_PROXY=true`. The counters live in process memory, reset on restart, and are per process. There's no account lockout and no alert. |
| 6.3 | Password reset, new-device verification and lost-MFA recovery don't bypass safeguards | **Partial** | Read | `auth.forgot-password.tsx:12-55`; `auth.reset-password.tsx:29-69` | **Password reset is sound:** a 256-bit token stored hashed, 1-hour expiry, consumed exactly once, ends all sessions, and doesn't reveal whether an account exists. **New-device verification:** missing. **Lost-MFA recovery:** not applicable, since there's no MFA. |
| 6.4 | Admin access protected independently of learner access | **Partial** | Read | `auth.server.ts:359-365`; every admin route's loader *and* action calls `requireAdmin` | The role is checked on the server for every admin page and action. That part is confirmed. But admins use the same login, the same 8-character password rule, the same email-only reset, no MFA, and sessions of up to 30 days. |

### 7. Exceptions and reconciliation

| # | Requirement | Status | Basis | Evidence | Explanation |
|---|---|---|---|---|---|
| 7.1 | Failed, pending, cancelled, refunded: licence outcome, and whether a refund revokes access | **Implemented** (depends on config) | Read, Config | `shopify.webhook.tsx:114-121`, `:349-456`, `:463-515`; `licenses.tsx:261-270` | See the outcomes list below the table. This only works if `refunds/create` and `orders/cancelled` are registered in Shopify. |
| 7.2 | An incorrect customer email can be corrected without granting extra access | **Partial** | Read | `licenses.tsx:182-208` | There's **no action to change a licence's email**, and "Resend Email" goes to the stored address. Workaround: revoke the key, then use Generate Bulk Keys or Grant, which loses the order link. Keys are bearer codes, so whoever received the wrong email can redeem until the key is revoked. |
| 7.3 | Reconcile across Shopify order ID, payment state, product, learner, licence ID, seat quantity | **Partial** | Read | `schema.prisma:240-262`, `:439-473`; `reports.export.tsx:31-61` | **Stored:** internal order ID, line item ID, course, learner, key, status and revoke reason, amount paid. **Not stored:** order number, payment status, product, variant or SKU, and quantity (derivable by counting keys). **Update (B4, fixed):** the order number is now stored too. Payment status, product/SKU and quantity are still not stored (N6). |
| 7.4 | Admin can locate an order, check access, review remaining bulk seats, handle a failed issuance | **Partial** | Read | `licenses.tsx:95-174`, `:650-694` | Licences can be searched, filtered by status and exported to CSV. There's no orders view and no per-order seat balance. A failed issuance (unmapped item) is visible only in the admin email or server log. Recovery is manual key generation, not linked to the order. **Update (B4, B5, fixed):** orders can be found by their number, and failed issuances are listed on the License Keys page with a "Mark resolved" action. A per-order seat balance is still missing (N6). |

What happens to the licence in each payment case (requirement 7.1):

- **Failed or pending payment:** no keys are issued.
- **Cancelled order:** every key is revoked, and any later `orders/paid` for that order is ignored.
- **Full refund of items:** those seats are revoked, unredeemed keys first.
- **Partial-amount or money-only refund:** nothing is revoked, and the admin is emailed.
- **Chargebacks and disputes:** not handled at all.
- **Certificates:** a learner keeps any certificate already earned, even after a refund.
- **Restoring:** an admin can restore a refunded key after one confirmation.

---

## 3. Partial and Missing items: classification and rough effort

Estimates cover development plus developer testing. They exclude Shopify-side configuration and the client's acceptance testing. They are rough, ±30%.

### Bugs in existing functionality

| Ref | Item | Req. | Estimate | Status |
|---|---|---|---|---|
| B1 | Raise the default device limit from 1 to 2 and backfill existing users. Assumes the agreement specifies 2. | 4.1 | 1–2 h | **Fixed** (`7ab3e84`) |
| B2 | Shopify test orders issue real keys: the webhook never checks `order.test`. Ignore or flag them in production. | 1.3, security S2 | 1–2 h | **Fixed** (`7ab3e84`) |
| B3 | Webhook hardening: the cancel handler should check the payload's `cancelled_at`; record `X-Shopify-Webhook-Id`. | 3.2, security S5 | 1–2 h | **Fixed** (`7ab3e84`): the `cancelled_at` check. Webhook-ID recording was not added, since order and refund IDs already make repeat deliveries harmless. |
| B4 | Store the Shopify order number (`order.name`, e.g. `#1001`), make it searchable, and add an order column to the licence list. | 2.6, 7.3 | 2–3 h | **Fixed** (`7ab3e84`) |
| B5 | Record paid-but-unmapped orders in the database and show them to the admin. *Arguable:* the current "store nothing" behaviour is deliberate in the code. | 3.3, 7.4 | 4–6 h | **Fixed** (`7ab3e84`) |
| B6 | Activation email wording: returning customers are told to "create your account", and the header says "Order Confirmed" without being a receipt. | 3.1, 5.1 | 0.5–1 h | **Fixed** (`7ab3e84`) |
| B7 | Refuse to start in production when `APP_URL` is unset, instead of emailing localhost links. | 3.1 | 0.5 h | **Fixed** (`7ab3e84`) |
| | **Subtotal** | | **≈ 10–16.5 h** | All fixed |

### Features that were never built (new work, quoted separately)

| Ref | Item | Req. | Estimate |
|---|---|---|---|
| N1 | MFA with an authenticator app (TOTP) and recovery codes: enrollment, verification at login, lockout after repeated failures, admin reset of a learner's MFA, enforced for admins and optional or required for learners | 6.1–6.3 | 28–40 h (admin-only: 16–24 h) |
| N2 | New-device verification by an email code | 6.3 | 10–16 h |
| N3 | Block the device over the limit instead of evicting: clear message plus a self-service "sign out a device" on the login screen. *This changes a documented design.* | 4.1 | 6–10 h |
| N4 | Bundle product that unlocks several courses, including refund and cancellation handling. Only needed if the bundle is its own Shopify product. | 1.1 | 8–12 h |
| N5 | Organizations: model, linking orders to an organization, org-manager portal (seat balance, invite by email, reassign seats), invitation email, admin organization view | 2.1, 2.3, 2.4, 5.1 | 40–60 h (lighter version, admin-side "assign and invite" plus a per-order seat summary: 8–12 h) |
| N6 | Orders and reconciliation view: per order, show number, payment status, line items, SKU, quantity, keys, learners, remaining seats and a link to Shopify. Builds on B4. | 2.6, 7.3, 7.4 | 10–16 h |
| N7 | "Re-sync order from Shopify" using the Admin API, to recover without relying on webhook re-delivery | 3.3, 7.4 | 6–10 h |
| N8 | Correct the email on an order's keys and resend, keeping the order link, with an audit log entry | 7.2 | 3–5 h |
| N9 | Duplicate-purchase notice when the order arrives: the webhook detects the buyer already holds the course and sends a "you already have access" email | 1.5 | 3–5 h (blocking at checkout: 12–20 h plus Shopify theme/app work) |
| N10 | Chargeback and dispute handling (Shopify `disputes/create`) | 7.1 | 3–5 h |
| N11 | Capture Storyline quiz scores (score message from the package) | 5.3 | 6–10 h (full SCORM/xAPI tracking: 20–30 h) |
| N12 | *Optional:* attach a purchase automatically to an existing account with the buyer's email, skipping the redeem step | 1.2, 3.1 | 4–6 h |
| | **Subtotal if everything is built** | | **≈ 127–195 h** |

### Config and decisions (no code, but they block testing)

| Ref | Item | Req. |
|---|---|---|
| C1 | Register all three webhooks (`orders/paid`, `refunds/create`, `orders/cancelled`) in Shopify with the JSON format and the correct secret. | 1.3, 3.2, 7.1 |
| C2 | Map each product with variant SKU = course ID, or set its product ID in the course builder. Mark products as non-physical. Decide how the bundle is built. | 1.1, 5.4 |
| C3 | Decide whether the limit is 1 or 2 devices, and whether the device over the limit is blocked or the oldest is signed out. The client document says both. | 4.1 |
| C4 | Decide the MFA scope (admins only, or everyone) and the method (authenticator app or email code). | 6.x |
| C5 | Decide the policies for partial refunds, chargebacks, certificates after a refund, and duplicate purchases. | 1.5, 7.1 |

---

## 4. Device restriction: exact behaviour

- **"Device" has no registry in the code.**
  - Each sign-in creates one `UserSession` row (`auth.server.ts:164-228`).
  - The row carries a `deviceId`: the first 16 hex characters of SHA-256(user agent + "|" + IP) (`auth.server.ts:148-153`).
  - `deviceId` only decides *which* session is evicted first when `TRUST_PROXY=true` (`:203-208`). It is never checked on later requests and doesn't identify a physical device.
- **"Active session"** means a `UserSession` with `isActive = true` and `expiresAt` in the future (`:206`, `:263-264`).
  - `expiresAt` slides 7 days forward with activity, updated at most every 5 minutes (`:282-293`).
  - The JWT and cookie have a hard 30-day cap (`:19-20`, `:95-103`).
- **What is limited:** the number of **concurrent active sessions per user**, not registered devices.
- **Where the limit is set:** per user, in `User.maxDevices`.
  - Database default was **1** (`schema.prisma:62`), with the same fallback in code (`auth.server.ts:192`). **Update (B1, fixed):** both are now 2, and existing accounts on 1 were moved to 2.
  - Admins edit it per user on `/users`: 0 = unlimited, maximum 50 (`users.tsx:199-221`).
  - There's no global or environment setting. Admin accounts are limited too.
- **Enforcement is server-side.**
  - At login, inside a transaction that locks the user row, the code ends the least recently used sessions over the limit, then inserts the new session (`auth.server.ts:188-225`).
  - On every request, `getSessionState` rejects an ended session (`:263`), so an evicted device is signed out on its next click.
- **On exceeding the limit, the new login always wins.** No login is ever refused because of the limit.

| Scenario | What the code does (limit = 2) |
|---|---|
| A, then B sign in | Both active. |
| C signs in | C succeeds. A (the least recently used) is ended and sees "You were signed out on this device…" (`auth.login.tsx:198-209`). |
| Logout on A | A's session ends and the slot is freed (`auth.server.ts:304-314`). |
| Browser restart | The cookie persists (`Max-Age` 30 days), so the learner stays signed in on the same session. |
| Private window | It's a new session that takes a slot. Closing the window doesn't free the slot until 7 days of inactivity or eviction. With `TRUST_PROXY=true`, a session with the same user agent and IP is evicted first. |
| Different browser, same machine | A different user agent means a different `deviceId`, so it's treated as another device and can evict the learner's other real device. |
| Network change | The existing session keeps working because the IP is not checked. A new login from the new IP gets a different `deviceId`. |

Note for N3: under a *blocking* policy, sessions abandoned in private windows would cause real lockouts. That design needs a self-service release on the login screen or a short idle timeout.

---

## 5. Security findings that could cause financial exposure or unauthorized access

Ordered by severity.

| # | Severity | Finding | Evidence | Impact |
|---|---|---|---|---|
| S1 | **High** | **No MFA for anyone, including admins.** Admin access depends on a password (8 characters minimum) or control of the admin's email inbox, through the reset flow. Login throttling is in memory only. | `auth.login.tsx:34-98`; `auth.reset-password.tsx:29-69`; `rate-limit.server.ts:24` | A compromised admin can generate up to 200 keys per action (`licenses.tsx:658`), grant any course, and restore refunded keys. That's direct revenue loss. |
| S2 | **Medium** | **Shopify test orders are treated as paid.** Nothing checks `order.test`. | `shopify.webhook.tsx:108-121` | If test payments (the Bogus Gateway or Shopify Payments test mode) are left on after acceptance testing, anyone can get real course access for free. Testing against the production LMS also issues real keys. **Update: fixed (B2).** |
| S3 | **Medium** | **Refund revocation depends on Shopify configuration and has deliberate gaps.** It only works if `refunds/create` and `orders/cancelled` are registered; they were added in 2026-11, after `orders/paid` (`PLESK_DEPLOYMENT.md:209`). Chargebacks never revoke. Partial-amount and money-only refunds keep access by design. A refunded key can be restored with one confirmation. | `shopify.webhook.tsx:22`, `:314-366`; `licenses.tsx:261-270` | Refunded customers keep access if the webhooks are missing, or after a chargeback. |
| S4 | **Medium** | **The device limit doesn't stop account sharing.** Every login succeeds by evicting another session, so two people can share an account indefinitely, each login signing the other out. | `auth.server.ts:203-218` | Lost revenue from shared accounts, rather than a break-in. |
| S5 | Low | **The webhook topic header is not covered by the HMAC.** A legitimately signed `orders/paid` body, replayed with `X-Shopify-Topic: orders/cancelled`, would revoke that order's keys: the cancel handler doesn't check `cancelled_at` in the payload. There's no webhook-ID or timestamp replay check. | `shopify.webhook.tsx:59`, `:463-487` | Requires capturing a signed payload. The result is lost access for a paying customer, not free access. **Update: fixed (B3)** for the cancel topic, the case that could revoke keys. |
| S6 | Low | **Licence keys are bearer codes,** not bound to the buyer's email. This is by design, for gifting and bulk orders. | `redeem.tsx:106-257` | A mis-addressed or forwarded email lets the wrong person redeem. That's misallocation, not extra seats. |
| S7 | Low | **Rate limiting is weak.** It lives in memory and is per process. Per-IP limits are off unless `TRUST_PROXY=true`, which leaves the password-reset and key-lookup endpoints with no limit; their tokens are strong, so the impact is low. The check and the record are separate steps, so concurrent requests can exceed the limit in a burst. | `rate-limit.server.ts:24-40`, `:133-140`, `:169-179` | Faster password guessing than the configured limit suggests. |
| S8 | Low | **Lesson completion is reported by the browser** (`complete_lesson` and "Mark as complete"). A certificate can be earned without doing the lessons. | `student.course.$courseId.tsx:571-597`; `certificate.$courseId.tsx:27-44` | Certificate integrity only, no financial exposure. |
| S9 | Info | `APP_URL` falls back to `http://localhost:5173` without warning. The 8 MB design mockup `public/Student Dashboard.html` is publicly served. | `email.server.ts:39`; `settings.tsx:25` | Broken activation and reset links if `APP_URL` is unset. Minor information exposure from the mockup. **Update:** the `APP_URL` part is fixed (B7). The mockup file is still public. |

**Checked and in good order:**

- Course access is checked on the server from the licence on every course page and action (`access.server.ts:53-63`, `student.course.$courseId.tsx:517-522`).
- The webhook HMAC uses a timing-safe compare.
- Session and reset tokens are stored hashed.
- Login and reset don't reveal whether an account exists.
- Row locks prevent double-spending a key.
- Every admin loader and action calls `requireAdmin`.
- I found no access granted before payment confirmation, apart from the test-order case in S2 (now fixed by B2).

---

## 6. What cannot be determined from the code

These need a manual test or an answer from the client.

**Shopify admin configuration (not in this repository)**

1. Whether all three webhooks are registered, with the JSON format, the correct URL, and the secret that matches `SHOPIFY_WEBHOOK_SECRET`.
2. Each product's SKU or product ID mapping, and whether the products are marked non-physical so checkout skips shipping.
3. How the bundle is built: Shopify's Bundles app, a standalone product, or something else. Whether its order line items are the two courses.
4. Wording in the checkout, order status page and notification templates (shipping and pickup text, the "Unfulfilled" status). Whether automatic fulfilment is turned on.
5. Payment capture mode (automatic or manual), and whether test mode or the Bogus Gateway is on.
6. Whether draft orders use product variants or custom items. For B2B or company orders (Shopify Plus), which email arrives on the order.

**Shopify behaviour to confirm by test**

7. Whether `orders/paid` fires for a $0 (100%-discount) order.
8. Whether Shopify admin can re-send a real order's `orders/paid` webhook. The code's recovery notes assume it can.
9. Shopify's current retry window for failed webhook deliveries.

**Content and email**

10. Whether every Storyline package contains the completion trigger.
11. Whether the quizzes live in the LMS or inside Storyline.
12. How Storyline's own resume behaves across devices.
13. Email deliverability: Resend domain verification and SPF/DKIM.

**Client decisions**

14. The device limit (1 or 2), and blocking the extra device versus signing out the oldest.
15. MFA scope and method.
16. Which organization features they expect.
17. Policies for partial refunds, chargebacks and certificates after a refund.
18. Duplicate-purchase handling.
19. Whether keys should be bound to the buyer's email.

**Your side**

20. The development agreement's wording, which settles bug versus new feature.
21. Production environment values (`APP_URL`, `TRUST_PROXY`, `ADMIN_EMAIL`, …) and whether the app runs as a single process. The rate limits assume it does.

---

## 7. Needed for the manual end-to-end tests but not set up in the repo

There is no seed data, no fixtures, no automated tests and no staging configuration in the repo. Everything below is manual.

1. **A staging LMS with its own database.** Test orders issued real keys at audit time (S2). Since B2 they issue none unless the server sets `SHOPIFY_ALLOW_TEST_ORDERS=true`, so set that on staging only, and still don't point test webhooks at production. Run `npm run doctor`, which is read-only, against it to check migrations and product-ID mapping.
2. **Shopify test payments.** Turn on Shopify Payments test mode or the Bogus Gateway, and plan to switch it off before launch.
3. **Products:** Money ($99), Markets ($249) and the bundle ($295.80), each mapped to its course as in C2 and set as non-physical. Create the courses and lessons in the LMS admin first; there's no seed script for courses.
4. **Webhooks:** register the three topics against the staging URL with the staging secret.
5. **Environment:** `APP_URL`, `RESEND_API_KEY` with a verified sending domain, `EMAIL_FROM`, `ADMIN_EMAIL`, `SUPPORT_EMAIL`, `SHOPIFY_WEBHOOK_SECRET`, `JWT_SECRET`, `TRUST_PROXY=true`, `COOKIE_SECURE=true`.
6. **Admin account:** create it with `scripts/seed-admin.ts` (needs `SEED_ADMIN_*`).
7. **Test mailboxes:** at least four learners (plus-addressing works) and one "organization" buyer.
8. **Device limit:** since B1 the default is 2, so no per-user change is needed. A third device signs out the oldest rather than being blocked; test with that expectation unless N3 is built.
9. **Devices:** three real devices or browsers for the device tests, plus one private window.
10. **Discount codes:** percentage, fixed-amount and 100%-off.
11. **A draft order** using the real product variants, not custom items, with a quantity (e.g. 5) and a bulk price.
12. **Storyline content:** at least one package republished with the completion trigger, and at least one LMS-built quiz.
13. **Order IDs:** note each test order's internal ID, the number in the Shopify admin URL. That's the only order identifier the LMS can search.
14. **Server logs:** you need access to them during testing. They're the only record of unmapped orders and failed emails.
