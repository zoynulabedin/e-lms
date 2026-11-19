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
const APP_URL = process.env.APP_URL || "http://localhost:5173";

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
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a7f3d0;">Order Confirmed</p>
          <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;">Your Course Access is Ready</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px 40px;">

          <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
            Thank you for your purchase! You now have access to:
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
                Enter your license key and create your account
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
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#a7f3d0;">Order Confirmed</p>
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
            then create an account or sign in. Each key can be used once.
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
  customerEmail,
  licenses,
  unmapped = [],
  note,
}: {
  orderId: string;
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
    subject: `New order: ${licenses.length} license(s) generated — Order #${orderId}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">New Shopify Order</h1>
        <p style="color:#6b7280;margin-bottom:20px;">Order <strong>#${esc(orderId)}</strong> from <strong>${esc(customerEmail || "(no email on the order)")}</strong></p>
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
  kind,
  revoked,
  note,
}: {
  orderId: string;
  kind: "refund" | "cancel";
  /** Keys this event revoked. `holderEmail` is set when a learner had already redeemed it. */
  revoked: Array<{ key: string; courseTitle: string; wasActive: boolean; holderEmail?: string | null }>;
  /** Shown above the table, e.g. "money-only refund — no keys were revoked". */
  note?: string;
}): Promise<EmailResult> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const what = kind === "refund" ? "Refund" : "Cancellation";
  if (!adminEmail) {
    console.warn(
      `[email] ADMIN_EMAIL not set — ${what.toLowerCase()} on order ${orderId}: ` +
        `${revoked.length} key(s) revoked${note ? `; ${note}` : ""}`,
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
    subject: `${what}: ${revoked.length} license(s) revoked — Order #${orderId}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:640px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
        <h1 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">Shopify ${what}</h1>
        <p style="color:#6b7280;margin-bottom:20px;">Order <strong>#${esc(orderId)}</strong> — ${revoked.length} key(s) revoked automatically.</p>
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
