import { Resend } from "resend";

/**
 * Lazily constructed: `new Resend(undefined)` throws, and this module is
 * imported by /licenses, the Shopify webhook and forgot-password - a missing
 * RESEND_API_KEY must degrade to "email not configured", not take those
 * routes down at import time.
 */
let _resend: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return (_resend ??= new Resend(key));
}

export type EmailResult = { ok: true; id?: string } | { ok: false; error: string };

async function send(label: string, payload: Parameters<Resend["emails"]["send"]>[0]): Promise<EmailResult> {
  const client = getResend();
  if (!client) {
    console.error(`[email] ${label}: RESEND_API_KEY is not set - email not sent`);
    return { ok: false, error: "Email is not configured (RESEND_API_KEY missing)." };
  }
  try {
    const { data, error } = await client.emails.send(payload);
    if (error) {
      console.error(`[email] ${label} failed:`, error);
      return { ok: false, error: error.message ?? String(error) };
    }
    console.log(`[email] ${label} sent:`, data?.id);
    return { ok: true, id: data?.id };
  } catch (e: any) {
    console.error(`[email] ${label} threw:`, e);
    return { ok: false, error: e?.message ?? "Unknown email error" };
  }
}

const FROM = process.env.EMAIL_FROM || "noreply@instructionalgraphics.org";

/**
 * Base URL of every link in a customer email (activation, password reset).
 * In production it must be set: the old silent fallback sent buyers
 * http://localhost links that open nothing. Like JWT_SECRET, a missing or
 * malformed value stops the server from starting instead.
 */
const APP_URL = (() => {
  const raw = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s/]+/i.test(raw)) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `APP_URL must be set in production to the site's public address, e.g. https://lms.instructionalgraphics.org ` +
        `(got ${raw ? JSON.stringify(raw) : "nothing"}). Activation and password-reset emails link to it.`,
    );
  }
  if (raw) console.warn(`[email] APP_URL ${JSON.stringify(raw)} is not an http(s) URL - using http://localhost:5173`);
  return "http://localhost:5173";
})();

/** "#1001 (Shopify id 5551234567890)" when the order number is known, else "#5551234567890". */
function orderLabel(orderId: string, orderName?: string | null): string {
  return orderName ? `${orderName} (Shopify id ${orderId})` : `#${orderId}`;
}

// FROM is a no-reply address, so mail that invites a reply sets Reply-To to a
// mailbox someone reads: the support address /student/help shows. A bare
// address only. A malformed one can make Resend refuse the whole email, so it
// falls back to the default rather than risk licence keys not going out.
const DEFAULT_SUPPORT_EMAIL = "info@instructionalgraphics.org";
const REPLY_TO = (() => {
  const configured = process.env.SUPPORT_EMAIL?.trim();
  if (!configured) return DEFAULT_SUPPORT_EMAIL;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured)) return configured;
  console.warn(
    `[email] SUPPORT_EMAIL ${JSON.stringify(configured)} is not a plain email address - using ${DEFAULT_SUPPORT_EMAIL}`,
  );
  return DEFAULT_SUPPORT_EMAIL;
})();

/** The support address learners see (/student/help) - the same one emails use as Reply-To. */
export const SUPPORT_EMAIL_ADDRESS = REPLY_TO;

/**
 * Course titles, Shopify item titles and email addresses are interpolated into
 * HTML; escape them so a stray "<" or "&" can't break (or inject into) the mail.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function redeemUrlFor(licenseKey: string): string {
  return `${APP_URL}/redeem?key=${encodeURIComponent(licenseKey)}`;
}

// ─── License delivery email ───────────────────────────────────────────────────

export async function sendLicenseEmail({
  to,
  licenseKey,
  courseTitle,
}: {
  to: string;
  licenseKey: string;
  courseTitle: string;
}) {
  const redeemUrl = redeemUrlFor(licenseKey);

  return send("license email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO, // the footer says "Reply to this email"
    subject: `Your course access is ready — ${courseTitle}`,
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Header -->
        <tr><td style="background:#1D375F;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a7f3d0;">Course Access</p>
          <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;">Your Course Access is Ready</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px 40px;">

          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
            Thank you for your purchase! Your license key below unlocks:
          </p>

          <!-- Course name -->
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
            <p style="margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#059669;">Course</p>
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#111827;">${esc(courseTitle)}</p>
          </div>

          <!-- License key -->
          <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#374151;">Your License Key</p>
          <div style="background:#f9fafb;border:2px dashed #d1fae5;border-radius:8px;padding:20px;text-align:center;margin-bottom:28px;">
            <code style="font-size:24px;font-weight:700;letter-spacing:.2em;color:#1D375F;">${esc(licenseKey)}</code>
          </div>

          <!-- Steps -->
          <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#374151;">How to get started:</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#1D375F;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">1</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Click the button below to go to <strong>${esc(APP_URL)}</strong>
              </td>
            </tr>
            <tr><td colspan="2" style="height:10px;"></td></tr>
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#1D375F;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">2</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Your key is filled in for you. Create your account &mdash; or, if you already
                have one, sign in with it so all your courses stay in one place
              </td>
            </tr>
            <tr><td colspan="2" style="height:10px;"></td></tr>
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#1D375F;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">3</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Start learning immediately!
              </td>
            </tr>
          </table>

          <!-- CTA button -->
          <div style="text-align:center;margin-bottom:28px;">
            <a href="${esc(redeemUrl)}" style="display:inline-block;background:#1D375F;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:16px;">
              Activate Your Course &rarr;
            </a>
          </div>

          <!-- Fallback link -->
          <div style="background:#f9fafb;border-radius:6px;padding:14px 16px;margin-bottom:8px;">
            <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">Or copy and paste this link into your browser:</p>
            <a href="${esc(redeemUrl)}" style="font-size:13px;color:#1D375F;word-break:break-all;">${esc(redeemUrl)}</a>
          </div>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">
            Questions? Reply to this email or visit <a href="${esc(APP_URL)}" style="color:#1D375F;">${esc(APP_URL)}</a>
          </p>
          <p style="margin:0;font-size:12px;color:#d1d5db;">
            If you did not purchase this course, please ignore this email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
    `,
  });

}

// ─── Several keys in one email (multi-seat / multi-course orders) ─────────────

/**
 * One email for a whole order instead of one per key: a school buying 30 seats
 * used to receive 30 near-identical emails. Each key keeps its own one-click
 * activation link, so seats can still be handed out individually. A single key
 * falls back to the classic single-key email.
 */
export async function sendLicenseBundleEmail({
  to,
  licenses,
}: {
  to: string;
  licenses: Array<{ key: string; courseTitle: string }>;
}): Promise<EmailResult> {
  if (licenses.length === 0) return { ok: false, error: "No licence keys to send." };
  if (licenses.length === 1) {
    return sendLicenseEmail({ to, licenseKey: licenses[0].key, courseTitle: licenses[0].courseTitle });
  }

  // Group by course so "3 x Course A, 1 x Course B" reads naturally.
  const byCourse = new Map<string, string[]>();
  for (const l of licenses) {
    const list = byCourse.get(l.courseTitle) ?? [];
    list.push(l.key);
    byCourse.set(l.courseTitle, list);
  }
  const courseTitles = Array.from(byCourse.keys());
  const subject =
    courseTitles.length === 1
      ? `Your ${licenses.length} course access keys are ready — ${courseTitles[0]}`
      : `Your ${licenses.length} course access keys are ready`;

  const sections = Array.from(byCourse.entries())
    .map(([courseTitle, keys]) => {
      const rows = keys
        .map((key) => {
          const url = redeemUrlFor(key);
          return `
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.08em;color:#1D375F;">${esc(key)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">
                <a href="${esc(url)}" style="display:inline-block;background:#1D375F;color:#ffffff;text-decoration:none;padding:7px 14px;border-radius:6px;font-weight:600;font-size:13px;">Activate &rarr;</a>
              </td>
            </tr>`;
        })
        .join("");
      return `
          <div style="margin-bottom:24px;">
            <p style="margin:0 0 8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#059669;">Course · ${keys.length} key${keys.length > 1 ? "s" : ""}</p>
            <p style="margin:0 0 10px;font-size:17px;font-weight:700;color:#111827;">${esc(courseTitle)}</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;">
              ${rows}
            </table>
          </div>`;
    })
    .join("");

  return send("license bundle email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO, // the footer says "Reply to this email"
    subject,
    html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="background:#1D375F;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a7f3d0;">Course Access</p>
          <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;">Your ${licenses.length} License Keys</h1>
        </td></tr>
        <tr><td style="background:#ffffff;padding:36px 40px;">
          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
            Thank you for your purchase! Each key below unlocks the course for <strong>one learner</strong>.
            Use one yourself, or forward a key to each person who should take the course.
          </p>
          ${sections}
          <p style="margin:8px 0 0;font-size:13px;color:#6b7280;line-height:1.6;">
            To activate a key: open its link (or go to <a href="${esc(`${APP_URL}/redeem`)}" style="color:#1D375F;">${esc(`${APP_URL}/redeem`)}</a> and type it in),
            then create an account, or sign in if you already have one. Each key can be used once.
          </p>
        </td></tr>
        <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">
            Questions? Reply to this email or visit <a href="${esc(APP_URL)}" style="color:#1D375F;">${esc(APP_URL)}</a>
          </p>
          <p style="margin:0;font-size:12px;color:#d1d5db;">
            If you did not purchase these courses, please ignore this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
    `,
  });
}

// ─── Admin order notification email ──────────────────────────────────────────

export async function sendAdminOrderNotification({
  orderId,
  orderName,
  customerEmail,
  licenses,
  unmapped = [],
  note,
}: {
  orderId: string;
  /** Shopify order number ("#1001"), when the payload had one. */
  orderName?: string | null;
  customerEmail: string;
  licenses: Array<{ key: string; courseTitle: string }>;
  /** Line items whose SKU did not match a course — the buyer paid but got nothing. */
  unmapped?: string[];
  /** Extra warning shown at the top, e.g. "this order has no customer email". */
  note?: string;
}) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    if (unmapped.length || note)
      console.warn(
        `[email] ADMIN_EMAIL not set — order ${orderId} needs attention: ` +
          [note, unmapped.length ? `unmapped SKUs: ${unmapped.join(", ")}` : ""].filter(Boolean).join("; "),
      );
    return { ok: false, error: "ADMIN_EMAIL not set" } as EmailResult;
  }

  const noteBlock = note
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:13px;">
        <strong>⚠ ${esc(note)}</strong>
      </div>`
    : "";

  const unmappedBlock = unmapped.length
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;color:#991b1b;font-size:13px;">
        <strong>⚠ ${unmapped.length} line item(s) did not match a course</strong> — the customer paid but received no key:<br/>
        ${unmapped.map((u) => `<code>${esc(u)}</code>`).join("<br/>")}
      </div>`
    : "";

  const licenseRows = licenses
    .map(
      (l) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${esc(l.courseTitle)}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#1D375F;">${esc(l.key)}</td></tr>`,
    )
    .join("");

  return send("admin order notification", {
    from: FROM,
    to: [adminEmail],
    subject: `New order: ${licenses.length} license(s) generated — Order ${orderName || `#${orderId}`}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">New Shopify Order</h1>
        <p style="color:#6b7280;margin-bottom:20px;">Order <strong>${esc(orderLabel(orderId, orderName))}</strong> from <strong>${esc(customerEmail || "(no email on the order)")}</strong></p>
        ${noteBlock}
        ${unmappedBlock}
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Course</th>
              <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">License Key</th>
            </tr>
          </thead>
          <tbody>${licenseRows}</tbody>
        </table>
        <a href="${esc(`${APP_URL}/licenses`)}" style="display:inline-block;background:#1D375F;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">View in Dashboard &rarr;</a>
      </div>
    `,
  });

}

// ─── Admin refund / cancellation notification ────────────────────────────────

export async function sendAdminRefundNotification({
  orderId,
  orderName,
  kind,
  revoked,
  note,
}: {
  orderId: string;
  /** Shopify order number ("#1001"), when known. */
  orderName?: string | null;
  /** dispute = chargeback opened (keys suspended); dispute_won = keys restored. */
  kind: "refund" | "cancel" | "dispute" | "dispute_won";
  /** Keys this event revoked. `holderEmail` is set when a learner had already redeemed it. */
  revoked: Array<{ key: string; courseTitle: string; wasActive: boolean; holderEmail?: string | null }>;
  /** Shown above the table, e.g. "money-only refund — no keys were revoked". */
  note?: string;
}): Promise<EmailResult> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const what =
    kind === "refund" ? "Refund" : kind === "cancel" ? "Cancellation" : kind === "dispute" ? "Chargeback" : "Chargeback won";
  // A won dispute gives keys back; an open one suspends them.
  const verb = kind === "dispute_won" ? "restored" : kind === "dispute" ? "suspended" : "revoked";
  if (!adminEmail) {
    console.warn(
      `[email] ADMIN_EMAIL not set — ${what.toLowerCase()} on order ${orderId}: ` +
        `${revoked.length} key(s) ${kind === "dispute_won" ? "restored" : kind === "dispute" ? "suspended" : "revoked"}${note ? `; ${note}` : ""}`,
    );
    return { ok: false, error: "ADMIN_EMAIL not set" };
  }

  const noteBlock = note
    ? `<div style="margin:0 0 20px;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:13px;">
        <strong>${esc(note)}</strong>
      </div>`
    : "";

  const rows = revoked
    .map(
      (r) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${esc(r.courseTitle)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#1D375F;">${esc(r.key)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#374151;">${
            r.wasActive ? `Redeemed by ${esc(r.holderEmail || "a learner")} — access removed` : "Not redeemed yet"
          }</td>
        </tr>`,
    )
    .join("");

  const table = revoked.length
    ? `<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Course</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">License Key</th>
            <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Status before</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : "";

  return send("admin refund notification", {
    from: FROM,
    to: [adminEmail],
    subject: `${what}: ${revoked.length} license(s) ${verb} — Order ${orderName || `#${orderId}`}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">Shopify ${what}</h1>
        <p style="color:#6b7280;margin-bottom:20px;">Order <strong>${esc(orderLabel(orderId, orderName))}</strong> — ${revoked.length} key(s) ${verb} automatically.</p>
        ${noteBlock}
        ${table}
        <p style="color:#6b7280;font-size:13px;margin-bottom:20px;">A revoked key can be restored from the License Keys page if this was a mistake.</p>
        <a href="${esc(`${APP_URL}/licenses?status=REVOKED`)}" style="display:inline-block;background:#1D375F;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">View revoked keys &rarr;</a>
      </div>
    `,
  });
}

// ─── Account email changed ────────────────────────────────────────────────────

/**
 * Sent to the OLD address when an account's email changes, so a hijacked
 * session can't quietly move the account (and its recovery channel) away
 * from its owner.
 */
export async function sendEmailChangedNotice({
  to,
  newEmail,
}: {
  to: string;
  newEmail: string;
}): Promise<EmailResult> {
  return send("email changed notice", {
    from: FROM,
    to: [to],
    // The owner's only way back in once resets go to the new address.
    replyTo: REPLY_TO,
    subject: "Your account email was changed",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px;">Your email address was changed</h1>
        <p style="color:#374151;margin-bottom:16px;line-height:1.6;">
          The email on your learning account was just changed from <strong>${esc(to)}</strong>
          to <strong>${esc(newEmail)}</strong>. From now on, sign-in and password resets use the new address.
        </p>
        <p style="color:#374151;margin-bottom:24px;line-height:1.6;">
          If you made this change, you don't need to do anything.
          <strong>If you did not</strong>, reply to this email or contact support at
          <a href="mailto:${esc(REPLY_TO)}" style="color:#1D375F;">${esc(REPLY_TO)}</a>
          straight away so we can secure your account.
        </p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;">${esc(APP_URL)}</p>
      </div>
    `,
  });
}

// ─── Password reset email ─────────────────────────────────────────────────────

export async function sendPasswordResetEmail({
  to,
  token,
}: {
  to: string;
  token: string;
}) {
  const resetUrl = `${APP_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;

  return send("password reset email", {
    from: FROM,
    to: [to],
    subject: "Reset your password",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px;">Password Reset</h1>
        <p style="color:#6b7280;margin-bottom:24px;">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
        <a href="${esc(resetUrl)}" style="display:inline-block;background:#1D375F;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px;">Reset Password &rarr;</a>
        <p style="color:#9ca3af;font-size:13px;">Or paste this link in your browser:<br/><a href="${esc(resetUrl)}" style="color:#1D375F;">${esc(resetUrl)}</a></p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;">If you did not request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });

}

// ─── Shared layout for the account / order emails below ──────────────────────

/** A simple branded card. `body` is trusted HTML built with esc() by the caller. */
function card(heading: string, body: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="background:#1D375F;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
          <h1 style="margin:0;font-size:24px;font-weight:700;color:#ffffff;">${esc(heading)}</h1>
        </td></tr>
        <tr><td style="background:#ffffff;padding:32px 40px;font-size:15px;color:#374151;line-height:1.6;">
          ${body}
        </td></tr>
        <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;padding:18px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            Questions? Reply to this email or visit <a href="${esc(APP_URL)}" style="color:#1D375F;">${esc(APP_URL)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<div style="margin:22px 0;"><a href="${esc(href)}" style="display:inline-block;background:#1D375F;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;">${esc(label)} &rarr;</a></div>`;
}

function keyRows(keys: Array<{ key: string; courseTitle: string }>): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;margin:8px 0 4px;">${keys
    .map(
      (k) => `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;">${esc(k.courseTitle)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:14px;font-weight:700;color:#1D375F;">${esc(k.key)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;"><a href="${esc(redeemUrlFor(k.key))}" style="color:#1D375F;font-weight:600;font-size:13px;">Activate &rarr;</a></td>
      </tr>`,
    )
    .join("")}</table>`;
}

// ─── Order access (retail purchases) ─────────────────────────────────────────

/**
 * One email per paid order, in up to three parts:
 *  - courses already unlocked on the buyer's existing account (no key needed),
 *  - "You already have access": a course the account already held - the new
 *    key was left unused (it can be given away, or refunded),
 *  - keys to activate (new customers).
 * With only keys to activate it is the classic licence email.
 */
export async function sendOrderAccessEmail({
  to,
  unlocked,
  keys,
  duplicates,
}: {
  to: string;
  unlocked: string[];
  keys: Array<{ key: string; courseTitle: string }>;
  duplicates: Array<{ key: string; courseTitle: string }>;
}): Promise<EmailResult> {
  if (!unlocked.length && !duplicates.length) {
    if (!keys.length) return { ok: false, error: "Nothing to send." };
    return sendLicenseBundleEmail({ to, licenses: keys });
  }
  const parts: string[] = ["<p style=\"margin:0 0 16px;\">Thank you for your purchase!</p>"];
  if (unlocked.length) {
    parts.push(`
      <p style="margin:0 0 6px;font-weight:700;color:#111827;">Ready in your account</p>
      <p style="margin:0 0 4px;">You already have an account with this email address, so we added your course${unlocked.length > 1 ? "s" : ""} to it:</p>
      <ul style="margin:6px 0 0;padding-left:20px;">${unlocked.map((t) => `<li><strong>${esc(t)}</strong></li>`).join("")}</ul>
      ${button(`${APP_URL}/student`, "Go to My Dashboard")}`);
  }
  if (duplicates.length) {
    const titles = Array.from(new Set(duplicates.map((d) => d.courseTitle)));
    parts.push(`
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 18px;margin:8px 0 18px;">
        <p style="margin:0 0 6px;font-weight:700;color:#1e3a8a;">You Already Have Access!</p>
        <p style="margin:0 0 8px;">You're already enrolled in <em>${titles.map(esc).join("</em>, <em>")}</em>. Your course is available in your learning dashboard.</p>
        <p style="margin:0 0 4px;font-size:13px;color:#4b5563;">The extra key below was not used. You can give it to someone else, or reply to this email if you bought it by mistake.</p>
        ${keyRows(duplicates)}
        ${unlocked.length ? "" : button(`${APP_URL}/student`, "Go to My Dashboard")}
      </div>`);
  }
  if (keys.length) {
    parts.push(`
      <p style="margin:8px 0 6px;font-weight:700;color:#111827;">Keys to activate</p>
      <p style="margin:0 0 4px;font-size:14px;">Open a key's link, then create an account or sign in. Each key can be used once.</p>
      ${keyRows(keys)}`);
  }
  return send("order access email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: unlocked.length ? "Your course is ready in your account" : "You already have access to this course",
    html: card("Your Course Access", parts.join("")),
  });
}

// ─── Organization seats ──────────────────────────────────────────────────────

/** To the buyer of an organization order: the seats, where to manage them, and (new accounts) a set-password link. */
export async function sendOrgSeatsEmail({
  to,
  orgName,
  seats,
  keys,
  setPasswordToken,
}: {
  to: string;
  orgName: string;
  seats: Array<{ courseTitle: string; count: number }>;
  keys: Array<{ key: string; courseTitle: string }>;
  /** Present when the manager account was just created: a 7-day set-password link. */
  setPasswordToken: string | null;
}): Promise<EmailResult> {
  const setPassword = setPasswordToken
    ? `<p style="margin:0 0 4px;"><strong>Step 1:</strong> set the password for your manager account (link valid for 7 days):</p>
       ${button(`${APP_URL}/auth/reset-password?token=${encodeURIComponent(setPasswordToken)}`, "Set my password")}
       <p style="margin:0 0 4px;"><strong>Step 2:</strong> invite your learners:</p>`
    : `<p style="margin:0 0 4px;">Sign in with this email address to invite your learners and see how many seats are left:</p>`;
  return send("organization seats email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: `Your seats for ${orgName} are ready`,
    html: card(
      "Your Seats Are Ready",
      `<p style="margin:0 0 12px;">Thank you for your order! These seats were added to <strong>${esc(orgName)}</strong>:</p>
       <ul style="margin:0 0 16px;padding-left:20px;">${seats.map((s) => `<li>${s.count} &times; <strong>${esc(s.courseTitle)}</strong></li>`).join("")}</ul>
       ${setPassword}
       ${button(`${APP_URL}/org`, "Manage seats & invite learners")}
       <p style="margin:18px 0 4px;font-size:13px;color:#6b7280;">You can also hand these keys out yourself; each key unlocks the course for one learner:</p>
       ${keyRows(keys)}`,
    ),
  });
}

/** To a learner an organization assigned a seat to. */
export async function sendSeatInvitationEmail({
  to,
  orgName,
  courseTitle,
  licenseKey,
}: {
  to: string;
  orgName: string;
  courseTitle: string;
  licenseKey: string;
}): Promise<EmailResult> {
  return send("seat invitation email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: `${orgName} invited you to ${courseTitle}`,
    html: card(
      "You're Invited",
      `<p style="margin:0 0 12px;"><strong>${esc(orgName)}</strong> has given you a seat in <strong>${esc(courseTitle)}</strong>.</p>
       <p style="margin:0 0 4px;">Accept the invitation to create your account (or sign in, if you already have one) with <strong>${esc(to)}</strong>:</p>
       ${button(redeemUrlFor(licenseKey), "Accept invitation")}
       <p style="margin:0;font-size:13px;color:#6b7280;">Your key: <span style="font-family:monospace;font-weight:700;color:#1D375F;">${esc(licenseKey)}</span>. It only works with the email address this invitation was sent to.</p>`,
    ),
  });
}

// ─── Sign-in security ────────────────────────────────────────────────────────

/** The 6-digit code for signing in on a browser this account hasn't used before. */
export async function sendNewDeviceCodeEmail({ to, code }: { to: string; code: string }): Promise<EmailResult> {
  return send("new device code email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: `Your sign-in code: ${code}`,
    html: card(
      "Confirm It's You",
      `<p style="margin:0 0 12px;">Someone (hopefully you) is signing in to your learning account on a new device or browser. Enter this code to continue:</p>
       <div style="background:#f9fafb;border:2px dashed #d1d5db;border-radius:8px;padding:18px;text-align:center;margin:0 0 16px;">
         <span style="font-family:monospace;font-size:30px;font-weight:700;letter-spacing:.3em;color:#1D375F;">${esc(code)}</span>
       </div>
       <p style="margin:0;font-size:13px;color:#6b7280;">The code expires in 10 minutes and works once. If this wasn't you, don't share it - change your password instead.</p>`,
    ),
  });
}

/** The 6-digit code that confirms a new account's email address (no account exists until it is entered). */
export async function sendRegistrationCodeEmail({ to, name, code }: { to: string; name: string; code: string }): Promise<EmailResult> {
  return send("registration code email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: `Your verification code: ${code}`,
    html: card(
      "Confirm Your Email",
      `<p style="margin:0 0 12px;">Hi ${esc(name)}, thanks for signing up. Enter this code on the sign-up page to create your learning account:</p>
       <div style="background:#f9fafb;border:2px dashed #d1d5db;border-radius:8px;padding:18px;text-align:center;margin:0 0 16px;">
         <span style="font-family:monospace;font-size:30px;font-weight:700;letter-spacing:.3em;color:#1D375F;">${esc(code)}</span>
       </div>
       <p style="margin:0;font-size:13px;color:#6b7280;">The code expires in 15 minutes. If you didn't sign up, ignore this email - no account is created without the code.</p>`,
    ),
  });
}

/** A link that signs out every device on the account (when the device limit blocks a sign-in). */
export async function sendReleaseDevicesEmail({ to, token }: { to: string; token: string }): Promise<EmailResult> {
  const url = `${APP_URL}/auth/release-devices?token=${encodeURIComponent(token)}`;
  return send("release devices email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: "Sign out your other devices",
    html: card(
      "Sign Out Your Other Devices",
      `<p style="margin:0 0 12px;">Your account is signed in on the maximum number of devices. Use the button below to sign out of all of them, then sign in on the device you want to use now.</p>
       ${button(url, "Sign out my other devices")}
       <p style="margin:0;font-size:13px;color:#6b7280;">The link expires in 30 minutes and works once. If you didn't ask for it, ignore this email - nothing changes.</p>`,
    ),
  });
}

/** An admin made this person a manager of an organization (new accounts get a 7-day set-password link). */
export async function sendOrgManagerInviteEmail({
  to,
  orgName,
  setPasswordToken,
}: {
  to: string;
  orgName: string;
  setPasswordToken: string | null;
}): Promise<EmailResult> {
  const first = setPasswordToken
    ? `<p style="margin:0 0 4px;">First, set the password for your account (link valid for 7 days):</p>
       ${button(`${APP_URL}/auth/reset-password?token=${encodeURIComponent(setPasswordToken)}`, "Set my password")}`
    : `<p style="margin:0 0 4px;">Sign in with this email address to get started.</p>`;
  return send("organization manager invite email", {
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject: `You can now manage seats for ${orgName}`,
    html: card(
      "Manage Your Organization",
      `<p style="margin:0 0 12px;">You've been made a manager of <strong>${esc(orgName)}</strong>. You can invite learners to its course seats and see how many are left.</p>
       ${first}
       ${button(`${APP_URL}/org`, "Open organization seats")}`,
    ),
  });
}
