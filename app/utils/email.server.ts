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
      subject: `Your license key for: ${courseTitle}`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px;">🎓 Course Access Ready</h1>
          <p style="color:#6b7280;margin-bottom:24px;">You have been granted access to <strong style="color:#111827;">${courseTitle}</strong>. Use the license key below to activate your account.</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:18px 24px;text-align:center;margin-bottom:24px;">
            <p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin:0 0 6px;">Your License Key</p>
            <code style="font-size:22px;font-weight:700;letter-spacing:.15em;color:#008060;">${licenseKey}</code>
          </div>
          <a href="${redeemUrl}" style="display:inline-block;background:#008060;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;margin-bottom:24px;">Activate Your Course →</a>
          <p style="color:#9ca3af;font-size:13px;">Or paste this link in your browser:<br/><a href="${redeemUrl}" style="color:#008060;">${redeemUrl}</a></p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
          <p style="color:#9ca3af;font-size:12px;">If you did not purchase this course, you can safely ignore this email.</p>
        </div>
      `,
    });
  } catch (err) {
    // Log but don't throw — email failure shouldn't break the purchase flow
    console.error("[email] Failed to send license email:", err);
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
