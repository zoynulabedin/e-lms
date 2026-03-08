import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || "noreply@instructionalgraphics.com";
const APP_URL = process.env.APP_URL || "http://localhost:5173";

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
  const redeemUrl = `${APP_URL}/redeem?key=${licenseKey}`;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `🎓 Your course access is ready — ${courseTitle}`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Header -->
        <tr><td style="background:#008060;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
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
            <p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#111827;">${courseTitle}</p>
          </div>

          <!-- License key -->
          <p style="margin:0 0 10px;font-size:14px;font-weight:600;color:#374151;">Your License Key</p>
          <div style="background:#f9fafb;border:2px dashed #d1fae5;border-radius:8px;padding:20px;text-align:center;margin-bottom:28px;">
            <code style="font-size:24px;font-weight:700;letter-spacing:.2em;color:#008060;">${licenseKey}</code>
          </div>

          <!-- Steps -->
          <p style="margin:0 0 14px;font-size:14px;font-weight:600;color:#374151;">How to get started:</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#008060;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">1</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Click the button below to go to <strong>${APP_URL}</strong>
              </td>
            </tr>
            <tr><td colspan="2" style="height:10px;"></td></tr>
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#008060;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">2</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Enter your license key and create your account
              </td>
            </tr>
            <tr><td colspan="2" style="height:10px;"></td></tr>
            <tr>
              <td style="width:28px;vertical-align:top;padding-top:2px;">
                <div style="width:22px;height:22px;background:#008060;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#fff;">3</div>
              </td>
              <td style="padding-left:10px;font-size:14px;color:#374151;line-height:1.5;">
                Start learning immediately!
              </td>
            </tr>
          </table>

          <!-- CTA button -->
          <div style="text-align:center;margin-bottom:28px;">
            <a href="${redeemUrl}" style="display:inline-block;background:#008060;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:16px;">
              Activate Your Course →
            </a>
          </div>

          <!-- Fallback link -->
          <div style="background:#f9fafb;border-radius:6px;padding:14px 16px;margin-bottom:8px;">
            <p style="margin:0 0 4px;font-size:12px;color:#6b7280;">Or copy and paste this link into your browser:</p>
            <a href="${redeemUrl}" style="font-size:13px;color:#008060;word-break:break-all;">${redeemUrl}</a>
          </div>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">
            Questions? Reply to this email or visit <a href="${APP_URL}" style="color:#008060;">${APP_URL}</a>
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
  } catch (err) {
    // Log but don't throw — email failure shouldn't break the purchase flow
    console.error("[email] Failed to send license email:", err);
  }
}

// ─── Admin order notification email ──────────────────────────────────────────

export async function sendAdminOrderNotification({
  orderId,
  customerEmail,
  licenses,
}: {
  orderId: string;
  customerEmail: string;
  licenses: Array<{ key: string; courseTitle: string }>;
}) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return; // Skip if not configured

  const licenseRows = licenses
    .map(
      (l) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${l.courseTitle}</td><td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#008060;">${l.key}</td></tr>`,
    )
    .join("");

  try {
    await resend.emails.send({
      from: FROM,
      to: adminEmail,
      subject: `New order: ${licenses.length} license(s) generated — Order #${orderId}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h1 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">🛒 New Shopify Order</h1>
          <p style="color:#6b7280;margin-bottom:20px;">Order <strong>#${orderId}</strong> from <strong>${customerEmail}</strong></p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Course</th>
                <th style="text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">License Key</th>
              </tr>
            </thead>
            <tbody>${licenseRows}</tbody>
          </table>
          <a href="${APP_URL}/licenses" style="display:inline-block;background:#008060;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">View in Dashboard →</a>
        </div>
      `,
    });
  } catch (err) {
    console.error("[email] Failed to send admin notification:", err);
  }
}

// ─── Password reset email ─────────────────────────────────────────────────────

export async function sendPasswordResetEmail({
  to,
  token,
}: {
  to: string;
  token: string;
}) {
  const resetUrl = `${APP_URL}/auth/reset-password?token=${token}`;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "Reset your password",
      html: `
        <div style="font-family:Inter,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px;">🔐 Password Reset</h1>
          <p style="color:#6b7280;margin-bottom:24px;">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#008060;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px;">Reset Password →</a>
          <p style="color:#9ca3af;font-size:13px;">Or paste this link in your browser:<br/><a href="${resetUrl}" style="color:#008060;">${resetUrl}</a></p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
          <p style="color:#9ca3af;font-size:12px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[email] Failed to send reset email:", err);
  }
}
