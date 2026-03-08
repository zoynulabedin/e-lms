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

  let order: any;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return data({ error: "Invalid JSON body" }, { status: 400 });
  }

  const customerEmail = (order?.email || order?.customer?.email || "")
    .trim()
    .toLowerCase();

  if (!customerEmail) {
    console.warn("[shopify webhook] Order has no customer email:", order?.id);
    return data({ ok: true }); // Acknowledge but skip
  }

  const lineItems: any[] = order?.line_items || [];
  const generatedKeys: Array<{
    key: string;
    courseId: string;
    courseTitle: string;
  }> = [];

  for (const item of lineItems) {
    // We map Shopify variant SKU → Course ID
    const courseId = item?.sku || null;
    const quantity = item?.quantity || 1;

    if (!courseId) continue;

    const course = await prisma.course.findUnique({ where: { id: courseId } });
    if (!course) {
      console.warn(`[shopify webhook] No course found for SKU: ${courseId}`);
      continue;
    }

    // Generate one license per unit purchased
    for (let i = 0; i < quantity; i++) {
      const key = generateLicenseKey();
      await prisma.license.create({
        data: {
          key,
          courseId,
          customerEmail,
          status: "PENDING",
          shopifyOrderId: String(order.id),
          isBulk: quantity > 1,
        },
      });
      generatedKeys.push({ key, courseId, courseTitle: course.title });
    }
  }

  // Send license email to customer and notify admin
  for (const { key, courseTitle } of generatedKeys) {
    await sendLicenseEmail({ to: customerEmail, licenseKey: key, courseTitle });
  }

  await sendAdminOrderNotification({
    orderId: String(order.id),
    customerEmail,
    licenses: generatedKeys.map(({ key, courseTitle }) => ({ key, courseTitle })),
  });

  console.log(
    `[shopify webhook] Order ${order.id}: generated ${generatedKeys.length} license(s) for ${customerEmail}`,
  );

  return data({ ok: true, generated: generatedKeys.length }, { status: 200 });
}

// Shopify also sends GET health checks
export async function loader() {
  return data({ status: "Shopify webhook endpoint active" }, { status: 200 });
}
