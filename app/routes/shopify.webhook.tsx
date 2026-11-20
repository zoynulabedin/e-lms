import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db.server";
import { verifyShopifyWebhook } from "../utils/shopify.server";
import { generateLicenseKey } from "../utils/auth.server";
import {
  sendLicenseBundleEmail,
  sendAdminOrderNotification,
  sendAdminRefundNotification,
  type EmailResult,
} from "../utils/email.server";
import {
  PLACEHOLDER_EMAIL,
  REVOKE_REASON,
  isMoneyRevocation,
  type RevokeReason,
} from "../utils/license";
import { revokedFields } from "../utils/license.server";
import { shopifyProductIdVariants } from "../utils/shopify-product";

const HANDLED_TOPICS = new Set(["orders/paid", "refunds/create", "orders/cancelled"]);

/**
 * Shopify Webhook Handler
 *
 * Register this ONE URL in your Shopify admin three times, once per event
 * (Settings → Notifications → Webhooks, format JSON):
 *   orders/paid       → mints one licence key per seat and emails them to the buyer
 *   refunds/create    → revokes the keys of the refunded seats
 *   orders/cancelled  → revokes every key of the order
 *   URL: https://yourapp.com/shopify/webhook
 *
 * A line item maps to a course by its variant SKU (= course id) or, failing
 * that, by the "Shopify Product ID" entered in the course builder.
 *
 * Shopify test orders (test payments) issue no keys unless
 * SHOPIFY_ALLOW_TEST_ORDERS=true, which is for a staging server only.
 *
 * Shopify retries anything that doesn't get a 2xx within ~5s and may deliver
 * an event twice, even concurrently, so every handler is idempotent and only
 * unexpected errors return 5xx.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Only accept POST
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const rawBody = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");

  // Verify authenticity
  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.warn("[shopify webhook] Invalid HMAC — rejecting request");
    return data({ error: "Unauthorized" }, { status: 401 });
  }

  // No topic header is treated as orders/paid, as this endpoint always has.
  // Other topics signed with the same secret (orders/create, orders/updated…)
  // are acknowledged and ignored without parsing, as before.
  const topic = request.headers.get("X-Shopify-Topic") || "orders/paid";
  if (!HANDLED_TOPICS.has(topic)) {
    return data({ ok: true, ignored: topic });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return data({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (topic === "refunds/create") return handleRefund(payload);
  if (topic === "orders/cancelled") return handleOrderCancelled(payload);
  return handleOrderPaid(payload);
}

// Shopify also sends GET health checks
export async function loader() {
  return data({ status: "Shopify webhook endpoint active" }, { status: 200 });
}

// ─── orders/paid: mint the keys ───────────────────────────────────────────────

const NO_EMAIL_NOTE =
  "This order has no customer email, so the keys were NOT emailed. Send them to the buyer yourself.";
const LEGACY_NOTE =
  "This order was processed before keys were tracked per line item, so re-sending it creates no keys. " +
  "If an item is missing its key, issue one with Generate Bulk Keys on the License Keys page.";
const TEST_ORDER_NOTE =
  "This is a Shopify test order (test payment, no money taken), so no keys were issued. " +
  "To issue keys for test orders on a staging server, set SHOPIFY_ALLOW_TEST_ORDERS=true there - never in production.";

type MappedItem = {
  lineItemId: string;
  courseId: string;
  courseTitle: string;
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

async function handleOrderPaid(order: any) {
  const orderId = order?.id != null ? String(order.id) : "";
  if (!orderId) {
    return data({ error: "Order id missing" }, { status: 400 });
  }

  if (order?.cancelled_at) {
    return data({ ok: true, ignored: "order is cancelled" });
  }
  // partially_refunded still has paid seats; the refunded ones are subtracted per line item.
  const financial = order?.financial_status;
  if (financial && financial !== "paid" && financial !== "partially_refunded") {
    return data({ ok: true, ignored: `financial_status=${financial}` });
  }

  // A missing email must not cost the buyer their keys: they are minted against
  // the placeholder (which "Resend Email" refuses) and the admin delivers them.
  const buyerEmail = String(order?.email || order?.customer?.email || "")
    .trim()
    .toLowerCase();
  const customerEmail = buyerEmail || PLACEHOLDER_EMAIL;
  // "#1001": the number staff and customers see (order.id is Shopify's internal id).
  const orderName = typeof order?.name === "string" && order.name.trim() ? order.name.trim().slice(0, 64) : null;

  // Shopify test orders (Bogus Gateway / Shopify Payments test mode) take no
  // money. Issuing real keys for them would hand out courses free whenever
  // test payments are switched on, so they are ignored unless this server is a
  // staging copy that opts in with SHOPIFY_ALLOW_TEST_ORDERS=true.
  if (order?.test === true && process.env.SHOPIFY_ALLOW_TEST_ORDERS !== "true") {
    console.warn(`[shopify webhook] Order ${orderId} is a Shopify test order - no keys issued`);
    sendInBackground(orderId, [
      sendAdminOrderNotification({
        orderId,
        orderName,
        customerEmail: buyerEmail,
        licenses: [],
        note: TEST_ORDER_NOTE,
      }),
    ]);
    return data({ ok: true, ignored: "test order" });
  }

  const notes: string[] = [];
  if (!buyerEmail) {
    console.warn(`[shopify webhook] Order ${orderId} has no customer email - keys go to the admin to deliver`);
    notes.push(NO_EMAIL_NOTE);
  }

  try {
    const mapped: MappedItem[] = [];
    const unmapped: string[] = [];
    // This payload's own refunds (same partial-amount rule as handleRefund)
    // skip lines refunded in full here; refunds already processed are added
    // under the order lock below.
    const payloadRefunded = refundedByLineItem(order?.refunds, []);

    for (const item of asArray(order?.line_items)) {
      if (item?.id == null) {
        unmapped.push(`${describeItem(item)}: line item has no id`);
        continue;
      }
      const lineItemId = String(item.id);
      const { originalQty, targetQty } = seatsWanted(item, payloadRefunded.get(lineItemId) ?? 0);
      if (targetQty <= 0) continue; // every unit refunded or removed - nothing to issue

      const match = await findCourseFor(prisma, item);
      if ("reason" in match) {
        unmapped.push(`${describeItem(item)}: ${match.reason}`);
        continue;
      }
      mapped.push({
        lineItemId,
        courseId: match.course.id,
        courseTitle: match.course.title,
        item,
        originalQty,
        amountPaid: amountPaidPerUnit(item, originalQty),
      });
    }

    if (unmapped.length) {
      console.warn(`[shopify webhook] Order ${orderId}: unmapped line item(s): ${unmapped.join("; ")}`);
    }

    // Nothing mapped: no keys to issue. The paid-but-unissued items are kept on
    // the order (not only in an email), so the License Keys page lists the
    // order until it is resolved. Once the admin fixes the SKU / product id, a
    // re-delivery of the webhook mints normally and clears the flag.
    if (mapped.length === 0) {
      if (unmapped.length) {
        await prisma.$transaction(
          async (tx) => {
            const { cancelledAt } = await lockOrder(tx, orderId);
            await recordOrderDetails(tx, orderId, !!cancelledAt, { orderName, buyerEmail, unmapped });
          },
          { timeout: 15000 },
        );
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
      return data({ ok: true, generated: 0, unmapped: unmapped.length });
    }

    // Per-line-item idempotency: every line item is topped up to the seats it
    // should hold. A duplicate delivery finds nothing missing; a re-send after
    // the admin fixed a SKU or deleted a key mints only the missing seats.
    const { outcome, created } = await prisma.$transaction(
      async (tx) => {
        // Shopify cancellations are final, and Shopify doesn't guarantee
        // delivery order: an orders/paid processed after the cancel (late, or a
        // retry whose payload predates it) must mint nothing, even when no key
        // existed yet for the cancel to revoke.
        const { cancelledAt } = await lockOrder(tx, orderId);
        await recordOrderDetails(tx, orderId, !!cancelledAt, { orderName, buyerEmail, unmapped });
        if (cancelledAt) {
          return { outcome: "cancelled" as const, created: [] as NewKey[] };
        }
        const existing = await tx.license.findMany({
          where: { shopifyOrderId: orderId },
          select: { shopifyLineItemId: true, status: true, revokedReason: true },
        });

        // Minted before keys were tracked per line item: there is no telling
        // which seats are missing, so keep the old "already processed" rule.
        if (existing.some((l) => l.shopifyLineItemId === null)) {
          return { outcome: "legacy" as const, created: [] as NewKey[] };
        }
        // Same rule, read from the keys a cancellation revoked.
        if (existing.some((l) => l.status === "REVOKED" && l.revokedReason === REVOKE_REASON.CANCELLED)) {
          return { outcome: "cancelled" as const, created: [] as NewKey[] };
        }

        // Read under the lock: a refund handled before this delivery, or one
        // this (stale) payload predates, still takes its seats out - also after
        // the refunded key itself has been deleted.
        const storedRefunds = await tx.shopifyRefund.findMany({
          where: { orderId },
          select: { refundId: true, lineItems: true },
        });
        const refunded = refundedByLineItem(order?.refunds, storedRefunds);

        const created: NewKey[] = [];
        for (const item of mapped) {
          const { targetQty } = seatsWanted(item.item, refunded.get(item.lineItemId) ?? 0);
          const keysOnLine = existing.filter((l) => l.shopifyLineItemId === item.lineItemId);
          const missing = seatsMissing({ originalQty: item.originalQty, targetQty }, keysOnLine);
          for (let i = 0; i < missing; i++) {
            created.push({
              key: generateLicenseKey(),
              lineItemId: item.lineItemId,
              courseId: item.courseId,
              courseTitle: item.courseTitle,
              amountPaid: item.amountPaid,
              isBulk: item.originalQty > 1,
            });
          }
        }

        // A P2002 here can only be a key collision: it rolls everything back
        // and the 500 below makes Shopify retry with fresh keys.
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
            })),
          });
        }
        return { outcome: created.length ? ("minted" as const) : ("duplicate" as const), created };
      },
      { timeout: 15000 },
    );

    if (outcome === "cancelled") {
      console.warn(`[shopify webhook] Order ${orderId} was already cancelled - late orders/paid ignored`);
      return data({ ok: true, ignored: "order was cancelled" });
    }
    if (outcome === "legacy") {
      // Only a deliberate re-send reaches this, so tell the admin why it did nothing.
      console.log(`[shopify webhook] Order ${orderId} predates per-line-item tracking - nothing minted`);
      notes.push(LEGACY_NOTE);
    } else {
      console.log(
        `[shopify webhook] Order ${orderId}: generated ${created.length} license(s) for ${customerEmail}` +
          (outcome === "duplicate" ? " (every seat already had a key)" : ""),
      );
    }

    // One email for the whole order, however many seats it has.
    const licenses = created.map(({ key, courseTitle }) => ({ key, courseTitle }));
    const emails: Array<Promise<EmailResult>> = [];
    if (licenses.length && buyerEmail) {
      emails.push(sendLicenseBundleEmail({ to: buyerEmail, licenses }));
    }
    if (licenses.length || unmapped.length || outcome === "legacy") {
      emails.push(
        sendAdminOrderNotification({
          orderId,
          orderName,
          customerEmail: buyerEmail,
          licenses,
          unmapped,
          note: joinNotes(notes),
        }),
      );
    }
    sendInBackground(orderId, emails);

    return data({
      ok: true,
      generated: created.length,
      unmapped: unmapped.length,
      ...(outcome === "duplicate" ? { duplicate: true } : {}),
      ...(outcome === "legacy" ? { legacy: true } : {}),
    });
  } catch (err) {
    // 5xx makes Shopify retry; the per-line-item top-up makes that retry safe.
    console.error(`[shopify webhook] Order ${orderId} failed:`, err);
    return data({ error: "Internal error" }, { status: 500 });
  }
}

// ─── refunds/create: revoke the refunded seats ────────────────────────────────

const MONEY_ONLY_NOTE =
  "Money-only refund (no items returned) - no keys were revoked. Revoke manually if access should end.";
const PARTIAL_AMOUNT_NOTE =
  "Partial refund: course items were ticked, but less money was returned than they cost (e.g. a goodwill refund), " +
  "so no keys were revoked and the learners keep access. Revoke the key on the License Keys page if access should end.";

/**
 * Items ticked on the refund, but less money returned than those items cost -
 * typically a goodwill refund with the course line selected. That is not a
 * returned seat, so a paying learner must not be locked out automatically.
 * Compared in presentment money, the currency the refund transactions use.
 * Without transactions to compare, Shopify's own "refund_discrepancy"
 * adjustment (calculated vs actual refund) is the signal.
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

async function handleRefund(refund: any) {
  const refundId = refund?.id != null ? String(refund.id) : "";
  const orderId = refund?.order_id != null ? String(refund.order_id) : "";
  if (!refundId || !orderId) {
    return data({ error: "Refund id or order id missing" }, { status: 400 });
  }

  const ticked = asArray(refund?.refund_line_items).filter((rli) => (Number(rli?.quantity) || 0) > 0);
  // A partial-amount refund revokes nothing and is stored with no returned
  // items, so a later orders/paid doesn't treat those seats as refunded either.
  const partialAmount = ticked.length > 0 && isPartialAmountRefund(refund, ticked);
  const returned = partialAmount ? [] : ticked;
  // Kept on the claim ([] for a money-only refund). orders/paid adds these to
  // its own payload's refunds, so seats refunded before their keys were minted,
  // or whose keys were deleted since, are never minted.
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
          let legacy: boolean | null = null; // looked up only if a line item has no keys

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
                legacy =
                  (await tx.license.count({ where: { shopifyOrderId: orderId, shopifyLineItemId: null } })) > 0;
              }
              if (legacy) {
                const match = await findCourseFor(tx, rli?.line_item);
                if ("course" in match) {
                  candidates = await tx.license.findMany({
                    where: {
                      shopifyOrderId: orderId,
                      courseId: match.course.id,
                      shopifyLineItemId: null,
                      status: { not: "REVOKED" },
                    },
                    select: KEY_SELECT,
                    orderBy: { createdAt: "asc" },
                  });
                }
              }
            }

            const chosen = refundOrder(candidates).slice(0, qty);
            revoked.push(...(await revokeKeys(tx, chosen, REVOKE_REASON.REFUND)));
            if (chosen.length < qty) {
              missed.push(`${qty - chosen.length} x ${rli?.line_item?.title ?? `line item ${lineItemId || "?"}`}`);
            }
          }
          return { revoked, missed };
        },
        { timeout: 15000 },
      );
    } catch (e: any) {
      // The only insert in that transaction is the ShopifyRefund claim.
      if (e?.code === "P2002") {
        console.log(`[shopify webhook] Refund ${refundId} (order ${orderId}) already processed - skipping`);
        return data({ ok: true, duplicate: true });
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

    console.log(`[shopify webhook] Refund ${refundId} on order ${orderId}: revoked ${result.revoked.length} key(s)`);
    // A refund payload has no order number; use the one recorded when the
    // order was paid. Best effort: the refund itself is already committed.
    const orderName = await prisma.shopifyOrder
      .findUnique({ where: { orderId }, select: { orderName: true } })
      .then((o) => o?.orderName ?? null)
      .catch(() => null);
    sendInBackground(orderId, [
      sendAdminRefundNotification({ orderId, orderName, kind: "refund", revoked: result.revoked, note: joinNotes(notes) }),
    ]);

    return data({ ok: true, revoked: result.revoked.length });
  } catch (err) {
    console.error(`[shopify webhook] Refund ${refundId} on order ${orderId} failed:`, err);
    return data({ error: "Internal error" }, { status: 500 });
  }
}

// ─── orders/cancelled: revoke the whole order ─────────────────────────────────

const CANCELLED_BEFORE_KEYS_NOTE =
  "The order was cancelled before any key was issued - no keys will be issued for it.";

async function handleOrderCancelled(order: any) {
  const orderId = order?.id != null ? String(order.id) : "";
  if (!orderId) {
    return data({ error: "Order id missing" }, { status: 400 });
  }
  // A genuine orders/cancelled payload carries cancelled_at. Shopify signs the
  // body but not the X-Shopify-Topic header, so without this check a captured,
  // validly signed orders/paid body re-sent with the "orders/cancelled" topic
  // would revoke a paying customer's keys.
  if (!order?.cancelled_at) {
    console.warn(`[shopify webhook] orders/cancelled for order ${orderId} has no cancelled_at - ignored`);
    return data({ ok: true, ignored: "order is not cancelled" });
  }
  const orderName = typeof order?.name === "string" && order.name.trim() ? order.name.trim().slice(0, 64) : null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const { cancelledAt } = await lockOrder(tx, orderId);
        // A re-delivery: the first one already revoked everything, and doing
        // it again would undo a key an admin has restored since.
        if (cancelledAt) return null;
        // Recorded on the order, so orders/paid mints nothing for it later -
        // also when no key exists yet (Shopify doesn't guarantee delivery order).
        // A cancelled order no longer needs attention for unissued items.
        await tx.shopifyOrder.update({
          where: { orderId },
          data: {
            cancelledAt: new Date(),
            ...(orderName ? { orderName } : {}),
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
      console.log(`[shopify webhook] Order ${orderId} cancellation already processed - skipping`);
      return data({ ok: true, duplicate: true });
    }
    const { revoked, hadKeys } = result;

    console.log(`[shopify webhook] Order ${orderId} cancelled: revoked ${revoked.length} key(s)`);
    // When something changed, or when no key existed yet (the admin should
    // know none will come). An order whose keys were all revoked already, by
    // refunds or by hand, needs no email.
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

    return data({ ok: true, revoked: revoked.length });
  } catch (err) {
    console.error(`[shopify webhook] Cancellation of order ${orderId} failed:`, err);
    return data({ error: "Internal error" }, { status: 500 });
  }
}

// ─── Database helpers ─────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

/** What a refund / cancellation needs to know about a key: to pick it, and for the admin email. */
const KEY_SELECT = {
  id: true,
  key: true,
  status: true,
  redeemedAt: true,
  course: { select: { title: true } },
  user: { select: { email: true } },
} satisfies Prisma.LicenseSelect;

type KeyRow = Prisma.LicenseGetPayload<{ select: typeof KEY_SELECT }>;
type RevokedKey = { key: string; courseTitle: string; wasActive: boolean; holderEmail: string | null };

/**
 * Serialises everything that touches one order (duplicate orders/paid, a refund
 * racing a mint, two refunds, a cancel): the ShopifyOrder row is created if
 * needed, then held locked until the transaction ends. Returns its cancel
 * state as of the lock, so a cancel committed while we waited is seen.
 */
async function lockOrder(tx: Tx, orderId: string): Promise<{ cancelledAt: Date | null }> {
  await tx.$executeRaw`
    INSERT INTO "ShopifyOrder" ("orderId") VALUES (${orderId}) ON CONFLICT ("orderId") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ cancelledAt: Date | null }>>`
    SELECT "cancelledAt" FROM "ShopifyOrder" WHERE "orderId" = ${orderId} FOR UPDATE
  `;
  return { cancelledAt: rows[0]?.cancelledAt ?? null };
}

/**
 * Keeps the order number, the buyer and any paid-but-unissued line items on
 * the (locked) order row, so an admin can find the order by its number and
 * see orders that still need a key. Unmapped items on a cancelled order are
 * not flagged. A delivery that maps everything clears the flag.
 */
async function recordOrderDetails(
  tx: Tx,
  orderId: string,
  cancelled: boolean,
  d: { orderName: string | null; buyerEmail: string; unmapped: string[] },
): Promise<void> {
  const flag = d.unmapped.length > 0 && !cancelled;
  await tx.shopifyOrder.update({
    where: { orderId },
    data: {
      ...(d.orderName ? { orderName: d.orderName } : {}),
      ...(d.buyerEmail ? { customerEmail: d.buyerEmail } : {}),
      unmappedItems: flag ? d.unmapped : Prisma.DbNull,
      unmappedAt: flag ? new Date() : null,
    },
  });
}

/** Holds the order's keys still while we choose which to revoke, so one redeemed this second is reported with its real holder. */
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

type CourseMatch = { course: { id: string; title: string } } | { reason: string };

/**
 * Variant SKU = course id first, then the course builder's "Shopify Product ID".
 * Two courses carrying one product id is a setup mistake: report it instead of
 * guessing, or a buyer could be handed the wrong course.
 */
async function findCourseFor(db: Pick<Tx, "course">, item: any): Promise<CourseMatch> {
  const sku = item?.sku ? String(item.sku).trim() : "";
  const productId = item?.product_id != null ? String(item.product_id) : "";
  if (sku) {
    const course = await db.course.findUnique({ where: { id: sku }, select: { id: true, title: true } });
    if (course) return { course };
  }
  if (productId) {
    // Also the GID form, as ids were saved before the builder normalised them.
    const courses = await db.course.findMany({
      where: { shopifyProductId: { in: shopifyProductIdVariants(productId) } },
      take: 2,
      select: { id: true, title: true },
    });
    if (courses.length === 1) return { course: courses[0] };
    if (courses.length > 1) {
      return { reason: `product id ${productId} is set on more than one course - fix it in the course builder` };
    }
  }
  return { reason: "no course has this SKU or Shopify product id" };
}

/**
 * Emails go out after the commit and are NOT awaited, so Shopify gets its 200
 * well inside its timeout. The email helpers never throw; a failure is logged
 * with the order id, and the admin can "Resend Email" from /licenses.
 */
function sendInBackground(orderId: string, emails: Array<Promise<EmailResult>>) {
  void Promise.allSettled(emails).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`[shopify webhook] Order ${orderId}: email threw:`, r.reason);
      } else if (!r.value.ok) {
        console.error(`[shopify webhook] Order ${orderId}: email not sent - ${r.value.error}`);
      }
    }
  });
}

// ─── Pure helpers (Shopify payload maths) ─────────────────────────────────────

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

function joinNotes(notes: string[]): string | undefined {
  return notes.length ? notes.join(" ") : undefined;
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
 * Units returned per line item: the refunds already processed (ShopifyRefund
 * rows) plus the payload's `refunds`, each refund id counted once. The stored
 * row wins for an id in both - it records what the refund handler decided
 * (a partial-amount refund is stored with no returned items). The stored ones
 * also cover a refund handled before this orders/paid and a stale retry whose
 * payload predates the refund. Payload refunds not processed yet are judged by
 * the same partial-amount rule as handleRefund.
 */
function refundedByLineItem(
  payloadRefunds: unknown,
  stored: Array<{ refundId: string; lineItems: unknown }>,
): Map<string, number> {
  const byRefund = new Map<string, Array<{ lineItemId: string; quantity: number }>>();
  for (const row of stored) {
    byRefund.set(
      row.refundId,
      asArray(row.lineItems).map((l) => ({
        lineItemId: String(l?.lineItemId ?? ""),
        quantity: Number(l?.quantity) || 0,
      })),
    );
  }
  asArray(payloadRefunds).forEach((refund, i) => {
    // A refund without an id can't match a stored one, but it still counts.
    const id = refund?.id != null ? String(refund.id) : `payload#${i}`;
    if (byRefund.has(id)) return; // already counted from the stored decision
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

/**
 * How many seats of a line item should hold a key. min() is deliberate: it is
 * right whether or not Shopify's current_quantity already excludes refunds.
 */
function seatsWanted(item: any, refundedQty: number): { originalQty: number; targetQty: number } {
  const originalQty = Number(item?.quantity) || 1;
  const current = finiteOrNull(item?.current_quantity);
  return { originalQty, targetQty: Math.min(current ?? originalQty, originalQty - refundedQty) };
}

/**
 * Per-unit amount actually paid (shop currency, after line and order discounts),
 * or null if Shopify's numbers don't add up. Not rounded per seat, so a line's
 * seats add up to what was paid; the dashboard and the export round for display.
 */
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
 * Keys a line item still needs. Admin-revoked seats count as issued (a replay
 * must not undo an admin's revoke); refunded / cancelled ones don't. Seats
 * already revoked here for a refund stay refunded even when the payload is an
 * older copy that doesn't list that refund yet.
 */
function seatsMissing(
  item: { originalQty: number; targetQty: number },
  keysOnLine: Array<{ status: string; revokedReason: string | null }>,
): number {
  const moneyRevoked = (k: { status: string; revokedReason: string | null }) =>
    k.status === "REVOKED" && isMoneyRevocation(k.revokedReason);
  const have = keysOnLine.filter((k) => !moneyRevoked(k)).length;
  const refundedHere = keysOnLine.filter(
    (k) => k.status === "REVOKED" && k.revokedReason === REVOKE_REASON.REFUND,
  ).length;
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
