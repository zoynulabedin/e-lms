import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.server";
import { generateLicenseKey, hashToken, hashPassword } from "./auth.server";
import {
  sendAdminOrderNotification,
  sendAdminRefundNotification,
  sendOrderAccessEmail,
  sendOrgSeatsEmail,
  type EmailResult,
} from "./email.server";
import {
  PLACEHOLDER_EMAIL,
  REVOKE_REASON,
  isMoneyRevocation,
  type RevokeReason,
} from "./license";
import { revokedFields, lockUserAndFindActiveLicense, ensureEnrollment } from "./license.server";
import { shopifyProductIdVariants } from "./shopify-product";

/**
 * Shopify order processing, shared by the webhook (/shopify/webhook) and the
 * admin "Re-sync from Shopify" action (/orders), so a re-pulled order goes
 * through exactly the same rules as a delivered one.
 *
 * Every function is idempotent and serialised per order (ShopifyOrder row
 * lock), and returns { status, body } for the caller to send.
 *
 *   paid       → one key per seat per course (a bundle seat → a key for each of
 *                its courses). A single seat bought with the email of an
 *                existing account is unlocked on that account straight away;
 *                if the account already has the course, the key stays unused
 *                and the buyer is told ("You already have access").
 *                Company / multi-seat orders become an organization seat pool.
 *   refund     → revokes the returned seats.
 *   cancelled  → revokes every key of the order.
 *   dispute    → a chargeback suspends the order's keys; a won dispute restores them.
 */

export type Outcome = { status: number; body: Record<string, unknown> };
export type Source = "webhook" | "resync";
type Tx = Prisma.TransactionClient;

const ok = (body: Record<string, unknown>): Outcome => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string): Outcome => ({ status, body: { error } });

// ─── orders/paid ──────────────────────────────────────────────────────────────

const NO_EMAIL_NOTE =
  "This order has no customer email, so the keys were NOT emailed. Send them to the buyer yourself.";
const LEGACY_NOTE =
  "This order was processed before keys were tracked per line item, so re-sending it creates no keys. " +
  "If an item is missing its key, issue one with Generate Bulk Keys on the License Keys page.";
const TEST_ORDER_NOTE =
  "This is a Shopify test order (test payment, no money taken), so no keys were issued. " +
  "To issue keys for test orders on a staging server, set SHOPIFY_ALLOW_TEST_ORDERS=true there - never in production.";

type CourseRef = { id: string; title: string };

type MappedItem = {
  lineItemId: string;
  courses: CourseRef[];
  /** The payload's line item: its seats are worked out under the order lock. */
  item: any;
  originalQty: number;
  amountPaid: number | null;
};

type NewKey = {
  key: string;
  lineItemId: string;
  courseId: string;
  courseTitle: string;
  amountPaid: number | null;
  isBulk: boolean;
};

type MintResult = {
  outcome: "cancelled" | "legacy" | "minted" | "duplicate";
  created: NewKey[];
  unlocked: NewKey[];
  duplicates: NewKey[];
  org: { id: string; name: string } | null;
  manager: { userId: string; setPasswordToken: string | null } | null;
};

const nothingMinted = (outcome: MintResult["outcome"]): MintResult => ({
  outcome,
  created: [],
  unlocked: [],
  duplicates: [],
  org: null,
  manager: null,
});

export async function processOrderPaid(order: any, source: Source = "webhook"): Promise<Outcome> {
  const orderId = order?.id != null ? String(order.id) : "";
  if (!orderId) return fail(400, "Order id missing");

  const orderName = orderNameOf(order);
  const buyerEmail = String(order?.email || order?.customer?.email || "").trim().toLowerCase();

  if (order?.cancelled_at) return ok({ ignored: "order is cancelled" });
  // partially_refunded still has paid seats; the refunded ones are subtracted per line item.
  const financial = order?.financial_status;
  if (financial && financial !== "paid" && financial !== "partially_refunded") {
    // A re-sync still records where the payment stands, for the Orders page.
    if (source === "resync") await recordSnapshot(orderId, order, orderName, buyerEmail);
    return ok({ ignored: `financial_status=${financial}` });
  }

  // A missing email must not cost the buyer their keys: they are minted against
  // the placeholder (which "Resend Email" refuses) and the admin delivers them.
  const customerEmail = buyerEmail || PLACEHOLDER_EMAIL;

  // Shopify test orders (Bogus Gateway / Shopify Payments test mode) take no
  // money. Issuing real keys for them would hand out courses free whenever test
  // payments are switched on, so they are ignored unless this server is a
  // staging copy that opts in with SHOPIFY_ALLOW_TEST_ORDERS=true.
  if (order?.test === true && process.env.SHOPIFY_ALLOW_TEST_ORDERS !== "true") {
    console.warn(`[shopify] Order ${orderId} is a Shopify test order - no keys issued`);
    sendInBackground(orderId, [
      sendAdminOrderNotification({ orderId, orderName, customerEmail: buyerEmail, licenses: [], note: TEST_ORDER_NOTE }),
    ]);
    return ok({ ignored: "test order" });
  }

  const notes: string[] = [];
  if (!buyerEmail) {
    console.warn(`[shopify] Order ${orderId} has no customer email - keys go to the admin to deliver`);
    notes.push(NO_EMAIL_NOTE);
  }

  try {
    const mapped: MappedItem[] = [];
    const unmapped: string[] = [];
    const lineSummary: LineSummary[] = [];
    // This payload's own refunds (same partial-amount rule as processRefund)
    // skip lines refunded in full here; refunds already processed are added
    // under the order lock below.
    const payloadRefunded = refundedByLineItem(order?.refunds, []);

    for (const item of asArray(order?.line_items)) {
      const summary: LineSummary = {
        lineItemId: item?.id != null ? String(item.id) : "",
        title: String(item?.title ?? ""),
        sku: item?.sku ? String(item.sku).trim() : null,
        productId: item?.product_id != null ? String(item.product_id) : null,
        quantity: Number(item?.quantity) || 1,
        courseIds: [],
      };
      lineSummary.push(summary);
      if (item?.id == null) {
        unmapped.push(`${describeItem(item)}: line item has no id`);
        continue;
      }
      const lineItemId = String(item.id);
      const match = await findCoursesFor(prisma, item);
      if ("courses" in match) summary.courseIds = match.courses.map((c) => c.id);

      const { originalQty, targetQty } = seatsWanted(item, payloadRefunded.get(lineItemId) ?? 0);
      if (targetQty <= 0) continue; // every unit refunded or removed - nothing to issue

      if ("reason" in match) {
        unmapped.push(`${describeItem(item)}: ${match.reason}`);
        continue;
      }
      mapped.push({ lineItemId, courses: match.courses, item, originalQty, amountPaid: amountPaidPerUnit(item, originalQty) });
    }

    if (unmapped.length) {
      console.warn(`[shopify] Order ${orderId}: unmapped line item(s): ${unmapped.join("; ")}`);
    }

    // Company name on the order, or several seats of one item: an organization
    // seat pool, managed by the buyer at /org.
    const company = companyOf(order);
    const isOrgOrder = !!company || mapped.some((m) => m.originalQty > 1);
    const details: OrderDetails = {
      orderName,
      buyerEmail,
      unmapped,
      financialStatus: typeof financial === "string" ? financial : null,
      totalPrice: order?.total_price != null ? String(order.total_price) : null,
      currency: typeof order?.currency === "string" ? order.currency : null,
      lineItems: lineSummary,
      synced: source === "resync",
    };

    // Nothing mapped: no keys to issue. The paid-but-unissued items are kept on
    // the order, so the License Keys page lists it until it is resolved.
    if (mapped.length === 0) {
      if (unmapped.length || source === "resync") {
        await prisma.$transaction(
          async (tx) => {
            const { cancelledAt } = await lockOrder(tx, orderId);
            await recordOrderDetails(tx, orderId, !!cancelledAt, details, null);
          },
          { timeout: 15000 },
        );
      }
      if (unmapped.length) {
        sendInBackground(orderId, [
          sendAdminOrderNotification({
            orderId,
            orderName,
            customerEmail: buyerEmail,
            licenses: [],
            unmapped,
            note: joinNotes(notes),
          }),
        ]);
      }
      return ok({ generated: 0, unmapped: unmapped.length });
    }

    // Per line item and course: every seat is topped up to what it should hold.
    // A duplicate delivery finds nothing missing; a re-send after the admin
    // fixed a SKU or deleted a key mints only the missing seats.
    const result = await prisma.$transaction(
      async (tx): Promise<MintResult> => {
        // Shopify cancellations are final, and Shopify doesn't guarantee
        // delivery order: an orders/paid processed after the cancel must mint
        // nothing, even when no key existed yet for the cancel to revoke.
        const { cancelledAt, organizationId: knownOrgId } = await lockOrder(tx, orderId);
        const org =
          isOrgOrder && !cancelledAt
            ? await findOrCreateOrganization(tx, order, company, buyerEmail, knownOrgId)
            : null;
        await recordOrderDetails(tx, orderId, !!cancelledAt, details, org?.id ?? null);
        if (cancelledAt) return nothingMinted("cancelled");

        const existing = await tx.license.findMany({
          where: { shopifyOrderId: orderId },
          select: { shopifyLineItemId: true, courseId: true, status: true, revokedReason: true },
        });
        // Minted before keys were tracked per line item: there is no telling
        // which seats are missing, so keep the old "already processed" rule.
        if (existing.some((l) => l.shopifyLineItemId === null)) {
          return nothingMinted("legacy");
        }
        if (existing.some((l) => l.status === "REVOKED" && l.revokedReason === REVOKE_REASON.CANCELLED)) {
          return nothingMinted("cancelled");
        }

        // Read under the lock: a refund handled before this delivery, or one
        // this (stale) payload predates, still takes its seats out.
        const storedRefunds = await tx.shopifyRefund.findMany({
          where: { orderId },
          select: { refundId: true, lineItems: true },
        });
        const refunded = refundedByLineItem(order?.refunds, storedRefunds);

        const created: NewKey[] = [];
        for (const item of mapped) {
          const { targetQty } = seatsWanted(item.item, refunded.get(item.lineItemId) ?? 0);
          for (const course of item.courses) {
            const keysOnLine = existing.filter(
              (l) => l.shopifyLineItemId === item.lineItemId && l.courseId === course.id,
            );
            const missing = seatsMissing({ originalQty: item.originalQty, targetQty }, keysOnLine);
            for (let i = 0; i < missing; i++) {
              created.push({
                key: generateLicenseKey(),
                lineItemId: item.lineItemId,
                courseId: course.id,
                courseTitle: course.title,
                // A bundle seat's price is split evenly over its courses.
                amountPaid: item.amountPaid == null ? null : item.amountPaid / item.courses.length,
                isBulk: item.originalQty > 1 || !!org,
              });
            }
          }
        }

        // A P2002 here can only be a key collision: it rolls everything back
        // and the 500 makes Shopify retry with fresh keys.
        if (created.length) {
          await tx.license.createMany({
            data: created.map((k) => ({
              key: k.key,
              courseId: k.courseId,
              customerEmail,
              status: "PENDING" as const,
              shopifyOrderId: orderId,
              shopifyOrderName: orderName,
              shopifyLineItemId: k.lineItemId,
              amountPaid: k.amountPaid,
              isBulk: k.isBulk,
              organizationId: org?.id ?? null,
            })),
          });
        }

        // A personal purchase by someone who already has an account: unlock it
        // on that account now (no key to type). If the account already holds
        // the course, the key stays unused and the buyer is told so.
        const unlocked: NewKey[] = [];
        const duplicates: NewKey[] = [];
        if (!org && buyerEmail && created.length) {
          const user = await tx.user.findUnique({
            where: { email: buyerEmail },
            select: { id: true, isBanned: true, isSuspended: true },
          });
          if (user && !user.isBanned && !user.isSuspended) {
            for (const k of created.filter((c) => !c.isBulk)) {
              if (await lockUserAndFindActiveLicense(tx, user.id, k.courseId)) {
                duplicates.push(k);
                continue;
              }
              await tx.license.updateMany({
                where: { key: k.key, status: "PENDING" },
                data: { status: "ACTIVE", userId: user.id, redeemedAt: new Date() },
              });
              await ensureEnrollment(tx, user.id, k.courseId);
              unlocked.push(k);
            }
          }
        }

        // The buyer manages the seat pool: link (or create) their account.
        const manager = org && buyerEmail ? await ensureOrgManager(tx, org.id, buyerEmail, order, company) : null;

        return {
          outcome: created.length ? "minted" : "duplicate",
          created,
          unlocked,
          duplicates,
          org,
          manager,
        };
      },
      { timeout: 20000 },
    );

    const { outcome, created, unlocked, duplicates, org, manager } = result;
    if (outcome === "cancelled") {
      console.warn(`[shopify] Order ${orderId} was already cancelled - late orders/paid ignored`);
      return ok({ ignored: "order was cancelled" });
    }
    if (outcome === "legacy") {
      console.log(`[shopify] Order ${orderId} predates per-line-item tracking - nothing minted`);
      notes.push(LEGACY_NOTE);
    } else {
      console.log(
        `[shopify] Order ${orderId}: generated ${created.length} license(s) for ${customerEmail}` +
          (outcome === "duplicate" ? " (every seat already had a key)" : ""),
      );
    }

    if (duplicates.length) {
      notes.push(
        `${buyerEmail} already had access to ${unique(duplicates.map((d) => d.courseTitle)).join(", ")}: ` +
          "the new key was left unused and the buyer was told. Refund it in Shopify if they ask.",
      );
    }
    if (org) notes.push(`Seats were added to the organization "${org.name}".`);

    const emails: Array<Promise<EmailResult>> = [];
    if (created.length && buyerEmail) {
      if (org) {
        emails.push(
          sendOrgSeatsEmail({
            to: buyerEmail,
            orgName: org.name,
            seats: countByCourse(created),
            keys: created.map(({ key, courseTitle }) => ({ key, courseTitle })),
            setPasswordToken: manager?.setPasswordToken ?? null,
          }),
        );
      } else {
        const unlockedKeys = new Set(unlocked.map((u) => u.key));
        const duplicateKeys = new Set(duplicates.map((d) => d.key));
        emails.push(
          sendOrderAccessEmail({
            to: buyerEmail,
            unlocked: unique(unlocked.map((u) => u.courseTitle)),
            keys: created
              .filter((k) => !unlockedKeys.has(k.key) && !duplicateKeys.has(k.key))
              .map(({ key, courseTitle }) => ({ key, courseTitle })),
            duplicates: duplicates.map(({ key, courseTitle }) => ({ key, courseTitle })),
          }),
        );
      }
    }
    if (created.length || unmapped.length || outcome === "legacy") {
      emails.push(
        sendAdminOrderNotification({
          orderId,
          orderName,
          customerEmail: buyerEmail,
          licenses: created.map(({ key, courseTitle }) => ({ key, courseTitle })),
          unmapped,
          note: joinNotes(notes),
        }),
      );
    }
    sendInBackground(orderId, emails);

    return ok({
      generated: created.length,
      unmapped: unmapped.length,
      ...(unlocked.length ? { unlocked: unlocked.length } : {}),
      ...(duplicates.length ? { alreadyOwned: duplicates.length } : {}),
      ...(org ? { organization: org.name } : {}),
      ...(outcome === "duplicate" ? { duplicate: true } : {}),
      ...(outcome === "legacy" ? { legacy: true } : {}),
    });
  } catch (err) {
    // 5xx makes Shopify retry; the per-line-item top-up makes that retry safe.
    console.error(`[shopify] Order ${orderId} failed:`, err);
    return fail(500, "Internal error");
  }
}

// ─── refunds/create ───────────────────────────────────────────────────────────

const MONEY_ONLY_NOTE =
  "Money-only refund (no items returned) - no keys were revoked. Revoke manually if access should end.";
const PARTIAL_AMOUNT_NOTE =
  "Partial refund: course items were ticked, but less money was returned than they cost (e.g. a goodwill refund), " +
  "so no keys were revoked and the learners keep access. Revoke the key on the License Keys page if access should end.";

export async function processRefund(refund: any): Promise<Outcome> {
  const refundId = refund?.id != null ? String(refund.id) : "";
  const orderId = refund?.order_id != null ? String(refund.order_id) : "";
  if (!refundId || !orderId) return fail(400, "Refund id or order id missing");

  const ticked = asArray(refund?.refund_line_items).filter((rli) => (Number(rli?.quantity) || 0) > 0);
  // A partial-amount refund revokes nothing and is stored with no returned
  // items, so a later orders/paid doesn't treat those seats as refunded either.
  const partialAmount = ticked.length > 0 && isPartialAmountRefund(refund, ticked);
  const returned = partialAmount ? [] : ticked;
  const lineItems = returned
    .map((rli) => ({ lineItemId: refundLineItemId(rli), quantity: Number(rli.quantity) }))
    .filter((l) => l.lineItemId);

  try {
    let result: { revoked: RevokedKey[]; missed: string[] };
    try {
      result = await prisma.$transaction(
        async (tx) => {
          // Claimed first: a re-delivered refund fails this primary key (P2002)
          // and rolls back before it can revoke a second batch of keys.
          await tx.shopifyRefund.create({ data: { refundId, orderId, lineItems } });
          await lockOrder(tx, orderId);
          await lockOrderKeys(tx, orderId);

          const revoked: RevokedKey[] = [];
          const missed: string[] = [];
          let legacy: boolean | null = null;

          for (const rli of returned) {
            const qty = Number(rli.quantity);
            const lineItemId = refundLineItemId(rli);
            let candidates: KeyRow[] = lineItemId
              ? await tx.license.findMany({
                  where: { shopifyOrderId: orderId, shopifyLineItemId: lineItemId, status: { not: "REVOKED" } },
                  select: KEY_SELECT,
                  orderBy: { createdAt: "asc" },
                })
              : [];

            // Keys minted before per-line-item tracking carry no line item id:
            // match those by course instead.
            if (candidates.length === 0) {
              if (legacy === null) {
                legacy = (await tx.license.count({ where: { shopifyOrderId: orderId, shopifyLineItemId: null } })) > 0;
              }
              if (legacy) {
                const match = await findCoursesFor(tx, rli?.line_item);
                if ("courses" in match) {
                  candidates = await tx.license.findMany({
                    where: {
                      shopifyOrderId: orderId,
                      courseId: { in: match.courses.map((c) => c.id) },
                      shopifyLineItemId: null,
                      status: { not: "REVOKED" },
                    },
                    select: KEY_SELECT,
                    orderBy: { createdAt: "asc" },
                  });
                }
              }
            }

            // One returned unit of a bundle line = one key of EACH of its courses.
            const byCourse = new Map<string, KeyRow[]>();
            for (const k of candidates) byCourse.set(k.courseId, [...(byCourse.get(k.courseId) ?? []), k]);
            let shortest = byCourse.size ? Infinity : 0;
            for (const group of byCourse.values()) {
              const chosen = refundOrder(group).slice(0, qty);
              revoked.push(...(await revokeKeys(tx, chosen, REVOKE_REASON.REFUND)));
              shortest = Math.min(shortest, chosen.length);
            }
            if (shortest < qty) {
              missed.push(`${qty - shortest} x ${rli?.line_item?.title ?? `line item ${lineItemId || "?"}`}`);
            }
          }
          return { revoked, missed };
        },
        { timeout: 15000 },
      );
    } catch (e: any) {
      if (e?.code === "P2002") {
        console.log(`[shopify] Refund ${refundId} (order ${orderId}) already processed - skipping`);
        return ok({ duplicate: true });
      }
      throw e;
    }

    const notes: string[] = [];
    if (partialAmount) notes.push(PARTIAL_AMOUNT_NOTE);
    else if (returned.length === 0) notes.push(MONEY_ONLY_NOTE);
    if (result.missed.length) {
      notes.push(
        `No key was left to revoke for ${result.missed.join(", ")} (never issued, deleted, or already revoked) - check this order on the License Keys page.`,
      );
    }

    console.log(`[shopify] Refund ${refundId} on order ${orderId}: revoked ${result.revoked.length} key(s)`);
    const orderName = await storedOrderName(orderId);
    sendInBackground(orderId, [
      sendAdminRefundNotification({ orderId, orderName, kind: "refund", revoked: result.revoked, note: joinNotes(notes) }),
    ]);
    return ok({ revoked: result.revoked.length });
  } catch (err) {
    console.error(`[shopify] Refund ${refundId} on order ${orderId} failed:`, err);
    return fail(500, "Internal error");
  }
}

// ─── orders/cancelled ─────────────────────────────────────────────────────────

const CANCELLED_BEFORE_KEYS_NOTE =
  "The order was cancelled before any key was issued - no keys will be issued for it.";

export async function processOrderCancelled(order: any): Promise<Outcome> {
  const orderId = order?.id != null ? String(order.id) : "";
  if (!orderId) return fail(400, "Order id missing");
  // A genuine orders/cancelled payload carries cancelled_at. Shopify signs the
  // body but not the X-Shopify-Topic header, so without this check a captured,
  // validly signed orders/paid body re-sent with the "orders/cancelled" topic
  // would revoke a paying customer's keys.
  if (!order?.cancelled_at) {
    console.warn(`[shopify] orders/cancelled for order ${orderId} has no cancelled_at - ignored`);
    return ok({ ignored: "order is not cancelled" });
  }
  const orderName = orderNameOf(order);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const { cancelledAt } = await lockOrder(tx, orderId);
        // A re-delivery: the first one already revoked everything, and doing it
        // again would undo a key an admin has restored since.
        if (cancelledAt) return null;
        // Recorded on the order, so orders/paid mints nothing for it later.
        // A cancelled order no longer needs attention for unissued items.
        await tx.shopifyOrder.update({
          where: { orderId },
          data: {
            cancelledAt: new Date(),
            ...(orderName ? { orderName } : {}),
            ...(typeof order?.financial_status === "string" ? { financialStatus: order.financial_status } : {}),
            unmappedItems: Prisma.DbNull,
            unmappedAt: null,
          },
        });
        const keys = await lockOrderKeys(tx, orderId);
        const live = await tx.license.findMany({
          where: { shopifyOrderId: orderId, status: { not: "REVOKED" } },
          select: KEY_SELECT,
        });
        return { revoked: await revokeKeys(tx, live, REVOKE_REASON.CANCELLED), hadKeys: keys.length > 0 };
      },
      { timeout: 15000 },
    );

    if (!result) {
      console.log(`[shopify] Order ${orderId} cancellation already processed - skipping`);
      return ok({ duplicate: true });
    }
    const { revoked, hadKeys } = result;
    console.log(`[shopify] Order ${orderId} cancelled: revoked ${revoked.length} key(s)`);
    if (revoked.length || !hadKeys) {
      sendInBackground(orderId, [
        sendAdminRefundNotification({
          orderId,
          orderName,
          kind: "cancel",
          revoked,
          note: hadKeys ? undefined : CANCELLED_BEFORE_KEYS_NOTE,
        }),
      ]);
    }
    return ok({ revoked: revoked.length });
  } catch (err) {
    console.error(`[shopify] Cancellation of order ${orderId} failed:`, err);
    return fail(500, "Internal error");
  }
}

// ─── disputes/create, disputes/update (chargebacks) ───────────────────────────

/**
 * A chargeback pulls the money back while it is open, so the order's keys are
 * suspended (revokedReason DISPUTE, restorable by an admin). If the shop wins,
 * exactly those keys come back. Inquiries (no money moved yet) change nothing.
 * Lost / accepted disputes stay suspended. Idempotent per dispute id + status.
 */
export async function processDispute(dispute: any): Promise<Outcome> {
  const disputeId = dispute?.id != null ? String(dispute.id) : "";
  const orderId = dispute?.order_id != null ? String(dispute.order_id) : "";
  if (!disputeId || !orderId) return fail(400, "Dispute id or order id missing");
  const kind = typeof dispute?.type === "string" ? dispute.type : null;
  const status = typeof dispute?.status === "string" ? dispute.status : null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        await lockOrder(tx, orderId);
        const prev = await tx.shopifyDispute.findUnique({ where: { disputeId }, select: { status: true, kind: true } });
        await tx.shopifyDispute.upsert({
          where: { disputeId },
          create: { disputeId, orderId, kind, status },
          update: { kind, status },
        });
        if (kind !== "chargeback") return { action: "none" as const, keys: [] as RevokedKey[] };

        // Won: restore the keys this dispute suspended (once).
        if (status === "won") {
          if (prev?.status === "won") return { action: "none" as const, keys: [] as RevokedKey[] };
          await lockOrderKeys(tx, orderId);
          const suspended = await tx.license.findMany({
            where: { shopifyOrderId: orderId, status: "REVOKED", revokedReason: REVOKE_REASON.DISPUTE },
            select: { id: true, key: true, userId: true, course: { select: { title: true } }, user: { select: { email: true } } },
          });
          for (const k of suspended) {
            await tx.license.update({
              where: { id: k.id },
              data: { status: k.userId ? "ACTIVE" : "PENDING", revokedAt: null, revokedReason: null },
            });
          }
          return {
            action: "restored" as const,
            keys: suspended.map((k) => ({ key: k.key, courseTitle: k.course.title, wasActive: !!k.userId, holderEmail: k.user?.email ?? null })),
          };
        }

        // Open (or lost / accepted): suspend once - the first time this dispute
        // is a chargeback (an inquiry that escalates counts), or again if a won
        // dispute is reopened.
        const alreadySuspended = prev?.kind === "chargeback" && prev.status !== "won";
        if (alreadySuspended) return { action: "none" as const, keys: [] as RevokedKey[] };
        await lockOrderKeys(tx, orderId);
        const live = await tx.license.findMany({
          where: { shopifyOrderId: orderId, status: { not: "REVOKED" } },
          select: KEY_SELECT,
        });
        return { action: "suspended" as const, keys: await revokeKeys(tx, live, REVOKE_REASON.DISPUTE) };
      },
      { timeout: 15000 },
    );

    if (result.action !== "none") {
      console.log(`[shopify] Dispute ${disputeId} on order ${orderId} (${status}): ${result.action} ${result.keys.length} key(s)`);
      const orderName = await storedOrderName(orderId);
      sendInBackground(orderId, [
        sendAdminRefundNotification({
          orderId,
          orderName,
          kind: result.action === "restored" ? "dispute_won" : "dispute",
          revoked: result.keys,
          note:
            result.action === "restored"
              ? "The chargeback was decided in your favour: the keys it suspended are active again."
              : `Chargeback opened (status: ${status ?? "unknown"}). The order's keys are suspended until it is decided; they come back automatically if you win it.`,
        }),
      ]);
    }
    return ok({ dispute: status, action: result.action, keys: result.keys.length });
  } catch (err) {
    console.error(`[shopify] Dispute ${disputeId} on order ${orderId} failed:`, err);
    return fail(500, "Internal error");
  }
}

// ─── Re-sync (admin) ──────────────────────────────────────────────────────────

/**
 * Brings the LMS in line with an order as Shopify has it now: a cancellation,
 * any refunds the LMS never heard of, and missing keys. Used when a webhook
 * delivery was lost (Shopify gave up retrying) or an item was mapped late.
 */
export async function resyncOrder(order: any): Promise<{ summary: string; failed: boolean }> {
  const parts: string[] = [];
  let failed = false;
  const note = (label: string, o: Outcome) => {
    if (o.status >= 400) failed = true;
    parts.push(`${label}: ${describeOutcome(o)}`);
  };
  if (order?.cancelled_at) {
    note("cancellation", await processOrderCancelled(order));
  } else {
    note("keys", await processOrderPaid(order, "resync"));
    for (const refund of asArray(order?.refunds)) {
      note(`refund ${refund?.id ?? "?"}`, await processRefund({ ...refund, order_id: refund?.order_id ?? order?.id }));
    }
  }
  await prisma.shopifyOrder
    .updateMany({ where: { orderId: String(order?.id ?? "") }, data: { lastSyncedAt: new Date() } })
    .catch(() => {});
  return { summary: parts.join("; "), failed };
}

function describeOutcome(o: Outcome): string {
  const b = o.body as Record<string, any>;
  if (o.status >= 400) return `failed (${b.error})`;
  if (b.ignored) return `nothing to do (${b.ignored})`;
  if (b.duplicate && !b.generated) return "already up to date";
  const bits: string[] = [];
  if (typeof b.generated === "number") bits.push(`${b.generated} new key(s)`);
  if (b.unlocked) bits.push(`${b.unlocked} unlocked on the buyer's account`);
  if (b.unmapped) bits.push(`${b.unmapped} item(s) match no course`);
  if (typeof b.revoked === "number") bits.push(`${b.revoked} key(s) revoked`);
  return bits.join(", ") || "done";
}

// ─── Database helpers ─────────────────────────────────────────────────────────

/** What a refund / cancellation needs to know about a key: to pick it, and for the admin email. */
const KEY_SELECT = {
  id: true,
  key: true,
  status: true,
  courseId: true,
  redeemedAt: true,
  course: { select: { title: true } },
  user: { select: { email: true } },
} satisfies Prisma.LicenseSelect;

type KeyRow = Prisma.LicenseGetPayload<{ select: typeof KEY_SELECT }>;
type RevokedKey = { key: string; courseTitle: string; wasActive: boolean; holderEmail: string | null };

type LineSummary = {
  lineItemId: string;
  title: string;
  sku: string | null;
  productId: string | null;
  quantity: number;
  courseIds: string[];
};

type OrderDetails = {
  orderName: string | null;
  buyerEmail: string;
  unmapped: string[];
  financialStatus: string | null;
  totalPrice: string | null;
  currency: string | null;
  lineItems: LineSummary[];
  synced: boolean;
};

/**
 * Serialises everything that touches one order (duplicate orders/paid, a refund
 * racing a mint, two refunds, a cancel, a dispute): the ShopifyOrder row is
 * created if needed, then held locked until the transaction ends.
 */
async function lockOrder(tx: Tx, orderId: string): Promise<{ cancelledAt: Date | null; organizationId: string | null }> {
  await tx.$executeRaw`
    INSERT INTO "ShopifyOrder" ("orderId") VALUES (${orderId}) ON CONFLICT ("orderId") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ cancelledAt: Date | null; organizationId: string | null }>>`
    SELECT "cancelledAt", "organizationId" FROM "ShopifyOrder" WHERE "orderId" = ${orderId} FOR UPDATE
  `;
  return { cancelledAt: rows[0]?.cancelledAt ?? null, organizationId: rows[0]?.organizationId ?? null };
}

/**
 * Keeps the order number, buyer, payment state, line items and any
 * paid-but-unissued items on the (locked) order row. Unmapped items on a
 * cancelled order are not flagged; a delivery that maps everything clears it.
 */
async function recordOrderDetails(
  tx: Tx,
  orderId: string,
  cancelled: boolean,
  d: OrderDetails,
  organizationId: string | null,
): Promise<void> {
  const flag = d.unmapped.length > 0 && !cancelled;
  await tx.shopifyOrder.update({
    where: { orderId },
    data: {
      ...(d.orderName ? { orderName: d.orderName } : {}),
      ...(d.buyerEmail ? { customerEmail: d.buyerEmail } : {}),
      ...(d.financialStatus ? { financialStatus: d.financialStatus } : {}),
      ...(d.totalPrice ? { totalPrice: d.totalPrice } : {}),
      ...(d.currency ? { currency: d.currency } : {}),
      ...(d.lineItems.length ? { lineItems: d.lineItems } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(d.synced ? { lastSyncedAt: new Date() } : {}),
      unmappedItems: flag ? d.unmapped : Prisma.DbNull,
      unmappedAt: flag ? new Date() : null,
    },
  });
}

/** Order details only (no keys), for a re-synced order that is not paid. */
async function recordSnapshot(orderId: string, order: any, orderName: string | null, buyerEmail: string) {
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    await tx.shopifyOrder.update({
      where: { orderId },
      data: {
        ...(orderName ? { orderName } : {}),
        ...(buyerEmail ? { customerEmail: buyerEmail } : {}),
        ...(typeof order?.financial_status === "string" ? { financialStatus: order.financial_status } : {}),
        ...(order?.total_price != null ? { totalPrice: String(order.total_price) } : {}),
        ...(typeof order?.currency === "string" ? { currency: order.currency } : {}),
        lastSyncedAt: new Date(),
      },
    });
  });
}

async function storedOrderName(orderId: string): Promise<string | null> {
  return prisma.shopifyOrder
    .findUnique({ where: { orderId }, select: { orderName: true } })
    .then((o) => o?.orderName ?? null)
    .catch(() => null);
}

/** Holds the order's keys still while we choose which to revoke. */
async function lockOrderKeys(tx: Tx, orderId: string) {
  return tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "License" WHERE "shopifyOrderId" = ${orderId} FOR UPDATE
  `;
}

/** Revokes the keys and returns them as rows for the admin email. */
async function revokeKeys(tx: Tx, keys: KeyRow[], reason: RevokeReason): Promise<RevokedKey[]> {
  if (keys.length === 0) return [];
  // userId is kept: who held the key matters, and REVOKED already removes access.
  await tx.license.updateMany({
    where: { id: { in: keys.map((k) => k.id) }, status: { not: "REVOKED" } },
    data: revokedFields(reason),
  });
  return keys.map((k) => ({
    key: k.key,
    courseTitle: k.course.title,
    wasActive: k.status === "ACTIVE",
    holderEmail: k.user?.email ?? null,
  }));
}

type CourseMatch = { courses: CourseRef[] } | { reason: string };

/**
 * Variant SKU = course id first, then the course builder's "Shopify Product
 * ID", then bundles (a product id listed under "Bundle product IDs" on each
 * course it unlocks). Two courses carrying one single-course product id is a
 * setup mistake: reported instead of guessing.
 */
export async function findCoursesFor(db: Pick<Tx, "course">, item: any): Promise<CourseMatch> {
  const sku = item?.sku ? String(item.sku).trim() : "";
  const productId = item?.product_id != null ? String(item.product_id) : "";
  if (sku) {
    const course = await db.course.findUnique({ where: { id: sku }, select: { id: true, title: true } });
    if (course) return { courses: [course] };
  }
  if (productId) {
    const variants = shopifyProductIdVariants(productId);
    const single = await db.course.findMany({
      where: { shopifyProductId: { in: variants } },
      take: 2,
      select: { id: true, title: true },
    });
    if (single.length === 1) return { courses: single };
    if (single.length > 1) {
      return { reason: `product id ${productId} is set on more than one course - fix it in the course builder` };
    }
    const bundle = await db.course.findMany({
      where: { shopifyBundleProductIds: { hasSome: variants } },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    });
    if (bundle.length) return { courses: bundle };
  }
  return { reason: "no course has this SKU or Shopify product id" };
}

/**
 * The organization an order's seats belong to: the one already on the order,
 * else the Shopify customer's, else one with this name and contact email,
 * else a new one.
 */
async function findOrCreateOrganization(
  tx: Tx,
  order: any,
  company: string | null,
  buyerEmail: string,
  knownOrgId: string | null,
): Promise<{ id: string; name: string }> {
  if (knownOrgId) {
    const known = await tx.organization.findUnique({ where: { id: knownOrgId }, select: { id: true, name: true } });
    if (known) return known;
  }
  const customerId = order?.customer?.id != null ? String(order.customer.id) : null;
  const personName = [order?.customer?.first_name, order?.customer?.last_name].filter(Boolean).join(" ").trim();
  const name = (company || personName || buyerEmail || "Organization").slice(0, 120);
  if (customerId) {
    return tx.organization.upsert({
      where: { shopifyCustomerId: customerId },
      create: { name, shopifyCustomerId: customerId, contactEmail: buyerEmail || null },
      update: {},
      select: { id: true, name: true },
    });
  }
  const byName = await tx.organization.findFirst({
    where: { name, contactEmail: buyerEmail || null },
    select: { id: true, name: true },
  });
  return byName ?? tx.organization.create({ data: { name, contactEmail: buyerEmail || null }, select: { id: true, name: true } });
}

/**
 * The buyer of an organization order manages its seats. An existing account is
 * linked (unless it already manages another organization); otherwise an
 * account is created with no usable password and a 7-day "set your password"
 * link that goes out in the seats email.
 */
async function ensureOrgManager(
  tx: Tx,
  organizationId: string,
  email: string,
  order: any,
  company: string | null,
): Promise<{ userId: string; setPasswordToken: string | null }> {
  const existing = await tx.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
  if (existing) {
    if (!existing.organizationId) {
      await tx.user.update({ where: { id: existing.id }, data: { organizationId } });
    }
    return { userId: existing.id, setPasswordToken: null };
  }
  const name =
    [order?.customer?.first_name, order?.customer?.last_name].filter(Boolean).join(" ").trim() || company || email;
  const user = await tx.user.create({
    data: {
      email,
      name,
      role: "CORPORATE",
      organizationId,
      // Random and never shown: the account is opened with the emailed link.
      passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")),
    },
    select: { id: true },
  });
  const token = crypto.randomBytes(32).toString("hex");
  await tx.passwordReset.create({
    data: { userId: user.id, token: hashToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  });
  return { userId: user.id, setPasswordToken: token };
}

/**
 * Emails go out after the commit and are NOT awaited, so Shopify gets its 200
 * well inside its timeout. The email helpers never throw; a failure is logged.
 */
function sendInBackground(orderId: string, emails: Array<Promise<EmailResult>>) {
  void Promise.allSettled(emails).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") console.error(`[shopify] Order ${orderId}: email threw:`, r.reason);
      else if (!r.value.ok) console.error(`[shopify] Order ${orderId}: email not sent - ${r.value.error}`);
    }
  });
}

// ─── Pure helpers (Shopify payload maths) ─────────────────────────────────────

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const unique = (xs: string[]) => Array.from(new Set(xs));

function joinNotes(notes: string[]): string | undefined {
  return notes.length ? notes.join(" ") : undefined;
}

/** "#1001": the number staff and customers see (order.id is Shopify's internal id). */
export function orderNameOf(order: any): string | null {
  return typeof order?.name === "string" && order.name.trim() ? order.name.trim().slice(0, 64) : null;
}

/** The company on the order (B2B company, billing/shipping address or customer address), if any. */
function companyOf(order: any): string | null {
  const candidates = [
    order?.company?.name,
    order?.billing_address?.company,
    order?.shipping_address?.company,
    order?.customer?.default_address?.company,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 120);
  }
  return null;
}

function countByCourse(keys: Array<{ courseTitle: string }>): Array<{ courseTitle: string; count: number }> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k.courseTitle, (m.get(k.courseTitle) ?? 0) + 1);
  return Array.from(m, ([courseTitle, count]) => ({ courseTitle, count }));
}

function describeItem(item: any): string {
  const sku = item?.sku ? String(item.sku).trim() : "";
  const productId = item?.product_id != null ? String(item.product_id) : "";
  return `${sku || "(no SKU)"} / product ${productId || "?"} (${item?.title ?? "?"})`;
}

/** A number Shopify sent, or null when it is absent or not a number (Number(null) would be 0). */
function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The order line item a refund line belongs to ("" if Shopify sent neither field). */
function refundLineItemId(rli: any): string {
  return String(rli?.line_item_id ?? rli?.line_item?.id ?? "");
}

/**
 * Items ticked on the refund, but less money returned than those items cost -
 * typically a goodwill refund with the course line selected. That is not a
 * returned seat, so a paying learner must not be locked out automatically.
 */
function isPartialAmountRefund(refund: any, returned: any[]): boolean {
  const amount = (set: any, fallback: unknown) => {
    const v = Number(set?.presentment_money?.amount ?? fallback);
    return Number.isFinite(v) ? v : 0;
  };
  const itemsValue = returned.reduce(
    (sum, rli) => sum + amount(rli?.subtotal_set, rli?.subtotal) + amount(rli?.total_tax_set, rli?.total_tax),
    0,
  );
  const refunds = asArray(refund?.transactions).filter((t) => t?.kind === "refund" && t?.status === "success");
  if (refunds.length > 0 && itemsValue > 0) {
    const paidBack = refunds.reduce((sum, t) => sum + (Number(t?.amount) || 0), 0);
    return paidBack + 0.01 < itemsValue;
  }
  return asArray(refund?.order_adjustments).some(
    (a) =>
      a?.kind === "refund_discrepancy" &&
      Math.abs(Number(a?.amount_set?.shop_money?.amount ?? a?.amount) || 0) >= 0.005,
  );
}

/**
 * Units returned per line item: the refunds already processed (ShopifyRefund
 * rows) plus the payload's `refunds`, each refund id counted once. The stored
 * row wins for an id in both - it records what the refund handler decided.
 */
function refundedByLineItem(
  payloadRefunds: unknown,
  stored: Array<{ refundId: string; lineItems: unknown }>,
): Map<string, number> {
  const byRefund = new Map<string, Array<{ lineItemId: string; quantity: number }>>();
  for (const row of stored) {
    byRefund.set(
      row.refundId,
      asArray(row.lineItems).map((l) => ({ lineItemId: String(l?.lineItemId ?? ""), quantity: Number(l?.quantity) || 0 })),
    );
  }
  asArray(payloadRefunds).forEach((refund, i) => {
    const id = refund?.id != null ? String(refund.id) : `payload#${i}`;
    if (byRefund.has(id)) return;
    const ticked = asArray(refund?.refund_line_items).filter((rli) => (Number(rli?.quantity) || 0) > 0);
    byRefund.set(
      id,
      isPartialAmountRefund(refund, ticked)
        ? []
        : ticked.map((rli) => ({ lineItemId: refundLineItemId(rli), quantity: Number(rli?.quantity) || 0 })),
    );
  });
  const refunded = new Map<string, number>();
  for (const lines of byRefund.values()) {
    for (const { lineItemId, quantity } of lines) {
      if (lineItemId && quantity > 0) refunded.set(lineItemId, (refunded.get(lineItemId) ?? 0) + quantity);
    }
  }
  return refunded;
}

/** How many seats of a line item should hold a key (min() is right whether or not current_quantity excludes refunds). */
function seatsWanted(item: any, refundedQty: number): { originalQty: number; targetQty: number } {
  const originalQty = Number(item?.quantity) || 1;
  const current = finiteOrNull(item?.current_quantity);
  return { originalQty, targetQty: Math.min(current ?? originalQty, originalQty - refundedQty) };
}

/** Per-unit amount actually paid (shop currency, after discounts), or null if Shopify's numbers don't add up. */
function amountPaidPerUnit(item: any, originalQty: number): number | null {
  const unit = Number(item?.price_set?.shop_money?.amount ?? item?.price);
  const discount = Array.isArray(item?.discount_allocations)
    ? item.discount_allocations.reduce(
        (sum: number, d: any) => sum + Number(d?.amount_set?.shop_money?.amount ?? d?.amount),
        0,
      )
    : Number(item?.total_discount) || 0;
  const perUnit = (unit * originalQty - discount) / originalQty;
  return Number.isFinite(perUnit) ? Math.max(0, perUnit) : null;
}

/**
 * Keys a line item (per course) still needs. Admin-revoked and dispute-
 * suspended seats count as issued; refunded / cancelled ones don't. Seats
 * already revoked for a refund stay refunded even when the payload is older.
 */
function seatsMissing(
  item: { originalQty: number; targetQty: number },
  keysOnLine: Array<{ status: string; revokedReason: string | null }>,
): number {
  const moneyRevoked = (k: { status: string; revokedReason: string | null }) =>
    k.status === "REVOKED" && isMoneyRevocation(k.revokedReason);
  const have = keysOnLine.filter((k) => !moneyRevoked(k)).length;
  const refundedHere = keysOnLine.filter((k) => k.status === "REVOKED" && k.revokedReason === REVOKE_REASON.REFUND).length;
  const target = Math.min(item.targetQty, item.originalQty - refundedHere);
  return Math.max(0, target - have);
}

/** Which keys a refund takes back first: unredeemed ones, then the most recently redeemed (the least used). */
function refundOrder<T extends { status: string; redeemedAt: Date | null }>(keys: T[]): T[] {
  const redeemedMs = (k: T) => (k.redeemedAt ? new Date(k.redeemedAt).getTime() : 0);
  return [...keys].sort((a, b) => {
    const pa = a.status === "PENDING" ? 0 : 1;
    const pb = b.status === "PENDING" ? 0 : 1;
    return pa !== pb ? pa - pb : redeemedMs(b) - redeemedMs(a);
  });
}
