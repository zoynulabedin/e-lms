import { data } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../utils/db.server";
import { verifyShopifyWebhook } from "../utils/shopify.server";
import { generateLicenseKey } from "../utils/auth.server";
import { sendLicenseEmail, sendAdminOrderNotification } from "../utils/email.server";

/**
 * Shopify Webhook Handler
 *
 * Register this endpoint in your Shopify admin:
 *   Settings → Notifications → Webhooks → orders/paid
 *   URL: https://yourapp.com/shopify/webhook
 *
 * Shopify line item's "sku" or "properties" must include the courseId.
 * Convention: set variant SKU = course UUID in Shopify.
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

  // Only orders/paid may mint licenses. Other topics signed with the same
  // secret (orders/create, orders/updated, refunds…) are acknowledged and ignored.
  const topic = request.headers.get("X-Shopify-Topic");
  if (topic && topic !== "orders/paid") {
    return data({ ok: true, ignored: topic });
  }

  let order: any;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return data({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orderId = order?.id != null ? String(order.id) : "";
  if (!orderId) {
    return data({ error: "Order id missing" }, { status: 400 });
  }

  if (order?.financial_status && order.financial_status !== "paid") {
    return data({ ok: true, ignored: `financial_status=${order.financial_status}` });
  }

  const customerEmail = (order?.email || order?.customer?.email || "")
    .trim()
    .toLowerCase();

  if (!customerEmail) {
    console.warn("[shopify webhook] Order has no customer email:", orderId);
    return data({ ok: true }); // Acknowledge but skip
  }

  try {
    // Idempotency: Shopify retries any webhook that doesn't get a 2xx within
    // ~5s (and may deliver twice, even concurrently). The ShopifyOrder row is
    // claimed in the SAME transaction as the licence insert below, so two
    // overlapping deliveries can never both mint keys.
    const already = await prisma.shopifyOrder.findUnique({ where: { orderId } });
    if (already) {
      console.log(`[shopify webhook] Order ${orderId} already processed — skipping`);
      return data({ ok: true, duplicate: true });
    }

    const lineItems: any[] = order?.line_items || [];
    const toCreate: Array<{
      key: string;
      courseId: string;
      courseTitle: string;
      isBulk: boolean;
    }> = [];
    const unmapped: string[] = [];

    for (const item of lineItems) {
      // Map the line item to a course: variant SKU = course id, or the
      // product id entered in the course builder's "Shopify Product ID" field.
      const sku = item?.sku ? String(item.sku).trim() : "";
      const productId = item?.product_id != null ? String(item.product_id) : "";
      const quantity = Math.max(1, Number(item?.quantity) || 1);

      let course = sku
        ? await prisma.course.findUnique({ where: { id: sku }, select: { id: true, title: true } })
        : null;
      if (!course && productId) {
        course = await prisma.course.findFirst({
          where: { shopifyProductId: productId },
          select: { id: true, title: true },
        });
      }
      if (!course) {
        console.warn(`[shopify webhook] No course for SKU "${sku}" / product ${productId}`);
        unmapped.push(`${sku || "(no SKU)"} / product ${productId || "?"} (${item?.title ?? "?"})`);
        continue;
      }
      const courseId = course.id;

      // Generate one license per unit purchased
      for (let i = 0; i < quantity; i++) {
        toCreate.push({
          key: generateLicenseKey(),
          courseId,
          courseTitle: course.title,
          isBulk: quantity > 1,
        });
      }
    }

    // Nothing mapped: acknowledge (so Shopify stops retrying) but do NOT
    // claim the order - once the admin fixes the SKU / product id they can
    // re-send the webhook from Shopify and it will mint normally.
    if (toCreate.length === 0) {
      console.warn(`[shopify webhook] Order ${orderId}: no line item matched a course (${unmapped.join(", ")})`);
      void sendAdminOrderNotification({ orderId, customerEmail, licenses: [], unmapped }).catch(console.error);
      return data({ ok: true, generated: 0, unmapped: unmapped.length });
    }

    // Claim + mint atomically. A concurrent duplicate delivery fails the
    // primary-key insert (P2002) and rolls back without creating anything.
    try {
      await prisma.$transaction([
        prisma.shopifyOrder.create({ data: { orderId } }),
        prisma.license.createMany({
          data: toCreate.map(({ key, courseId, isBulk }) => ({
            key,
            courseId,
            customerEmail,
            status: "PENDING" as const,
            shopifyOrderId: orderId,
            isBulk,
          })),
        }),
      ]);
    } catch (e: any) {
      if (e?.code === "P2002") {
        console.log(`[shopify webhook] Order ${orderId} processed concurrently — skipping`);
        return data({ ok: true, duplicate: true });
      }
      throw e;
    }

    console.log(
      `[shopify webhook] Order ${orderId}: generated ${toCreate.length} license(s) for ${customerEmail}` +
        (unmapped.length ? `; unmapped: ${unmapped.join(", ")}` : ""),
    );

    // Emails go out after the DB commit and are NOT awaited, so Shopify gets
    // its 200 well inside the timeout even for large orders. Failures are
    // logged; the admin can "Resend Email" from /licenses.
    void Promise.allSettled([
      ...toCreate.map(({ key, courseTitle }) =>
        sendLicenseEmail({ to: customerEmail, licenseKey: key, courseTitle }),
      ),
      sendAdminOrderNotification({
        orderId,
        customerEmail,
        licenses: toCreate.map(({ key, courseTitle }) => ({ key, courseTitle })),
        unmapped,
      }),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === "rejected")
          console.error("[shopify webhook] email failed:", r.reason);
      }
    });

    return data(
      { ok: true, generated: toCreate.length, unmapped: unmapped.length },
      { status: 200 },
    );
  } catch (err) {
    // 5xx makes Shopify retry; the idempotency check makes that retry safe.
    console.error(`[shopify webhook] Order ${orderId} failed:`, err);
    return data({ error: "Internal error" }, { status: 500 });
  }
}

// Shopify also sends GET health checks
export async function loader() {
  return data({ status: "Shopify webhook endpoint active" }, { status: 200 });
}
