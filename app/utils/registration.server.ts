import crypto from "crypto";
import { promises as dns } from "dns";
import { parse, serialize } from "cookie";
import { deriveSecret } from "./auth.server";
import { clientIp } from "./rate-limit.server";
import { HONEYPOT_FIELD, NAME_MAX, PASSWORD_MAX, PASSWORD_MIN, REGISTRATION_CODE_MINUTES } from "./registration";

export { HONEYPOT_FIELD, PASSWORD_MIN, REGISTRATION_CODE_MINUTES };

/**
 * Sign-up protection for /auth/register (validators are shared with /redeem):
 *
 *  - Real details: a first + last name made of letters, a well-formed email on
 *    a domain that receives mail (DNS MX), not a throwaway inbox, and a password
 *    that isn't trivially guessable.
 *  - Proof of the inbox: no account exists until the 6-digit code emailed to
 *    the address is entered. Until then the sign-up lives only in an encrypted,
 *    15-minute cookie in the visitor's browser (no half-made rows in the DB).
 *  - Bots: a hidden honeypot field, a signed "form shown at" token (a POST that
 *    never loaded the form, or came back within 2 seconds, is refused), the
 *    per-IP / per-email rate limits, and Cloudflare Turnstile when its keys are
 *    set (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY).
 */

// ─── Name ────────────────────────────────────────────────────────────────────

export function normalizeName(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/** Error text for an unusable full name, or null. The name is printed on certificates. */
export function nameError(name: string): string | null {
  if (!name) return "Please enter your full name.";
  if (name.length > NAME_MAX) return `Your name can be at most ${NAME_MAX} characters.`;
  // Letters (any script) and the marks / separators real names use. No digits,
  // "@", "/", ":" or "<" - which also keeps URLs and spam text out.
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name)) {
    return "Your name can only contain letters, spaces, hyphens (-), apostrophes (') and full stops.";
  }
  const words = name.split(" ").filter((w) => /\p{L}/u.test(w));
  if (words.length < 2) return "Please enter your first and last name (it is printed on your certificates).";
  if (/(\p{L})\1{3,}/u.test(name)) return "Please enter your real name.";
  return null;
}

// ─── Email ───────────────────────────────────────────────────────────────────

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/** Throwaway-inbox providers. A sub-domain of one (x.mailinator.com) counts too. */
const DISPOSABLE = new Set([
  "10minutemail.com", "10minutemail.net", "10minutemail.co.uk", "10minemail.com", "20minutemail.com",
  "33mail.com", "anonaddy.me", "armyspy.com", "binkmail.com", "bobmail.info", "burnermail.io",
  "chammy.info", "cuvox.de", "dayrep.com", "deadaddress.com", "discard.email", "discardmail.com",
  "dispostable.com", "drdrb.net", "dropmail.me", "einrot.com", "emailondeck.com", "emailfake.com",
  "emailtemporanea.com", "emltmp.com", "fakeinbox.com", "fakemail.net", "fakemailgenerator.com",
  "fleckens.hu", "getairmail.com", "getnada.com", "gishpuppy.com", "guerrillamail.biz",
  "guerrillamail.com", "guerrillamail.de", "guerrillamail.info", "guerrillamail.net",
  "guerrillamail.org", "guerrillamailblock.com", "grr.la", "gustr.com", "harakirimail.com",
  "inboxbear.com", "inboxkitten.com", "incognitomail.org", "jetable.org", "jourrapide.com",
  "kasmail.com", "linshiyouxiang.net", "mail.tm", "mail-temp.com", "mailcatch.com", "maildrop.cc",
  "mailinator.com", "mailinator.net", "mailinator2.com", "mailnesia.com", "mailnull.com",
  "mailpoof.com", "mailsac.com", "mailtemp.info", "mailtothis.com", "meltmail.com", "mintemail.com",
  "mohmal.com", "moakt.com", "mt2015.com", "mvrht.com", "my10minutemail.com", "mytemp.email",
  "mytrashmail.com", "nada.email", "nwytg.net", "onetimemail.org", "owlymail.com", "pokemail.net",
  "rhyta.com", "sharklasers.com", "smashmail.de", "spam4.me", "spambog.com", "spambox.us",
  "spamgourmet.com", "spamex.com", "spamfree24.org", "superrito.com", "teleworm.us", "temp-mail.io",
  "temp-mail.org", "tempail.com", "tempinbox.com", "tempmail.com", "tempmail.dev", "tempmail.net",
  "tempmail.plus", "tempmailo.com", "tempmailaddress.com", "tempr.email", "temporarymail.com",
  "throwam.com", "throwawaymail.com", "tmail.ws", "tmailor.com", "tmpmail.net", "tmpmail.org",
  "trash-mail.com", "trashmail.com", "trashmail.de", "trashmail.io", "trashmail.me", "trashmail.net",
  "trbvm.com", "wegwerfmail.de", "wegwerfmail.net", "yopmail.com", "yopmail.fr", "yopmail.net",
  "zetmail.com", "1secmail.com", "1secmail.net", "1secmail.org", "fexpost.com", "fexbox.org",
  "mailbox.in.ua", "rover.info", "byom.de", "spamdecoy.net", "luxusmail.org", "tempmailbox.com",
]);

function isDisposable(domain: string): boolean {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/** Common slips of the big providers' domains: "Did you mean …@gmail.com?" */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com",
  "gmaill.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmail.cm": "gmail.com",
  "gmail.om": "gmail.com", "gmal.com": "gmail.com", "gmali.com": "gmail.com", "gmil.com": "gmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yahoo.con": "yahoo.com", "yahoo.co": "yahoo.com",
  "yhoo.com": "yahoo.com", "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com",
  "hotmail.con": "hotmail.com", "hotmail.co": "hotmail.com", "hotmil.com": "hotmail.com",
  "outlok.com": "outlook.com", "outlook.con": "outlook.com", "outlook.co": "outlook.com",
  "iclod.com": "icloud.com", "icloud.con": "icloud.com", "icoud.com": "icloud.com",
  "aol.con": "aol.com",
};

/** Error text for an address that is malformed, a throwaway inbox or a likely typo; null when fine. */
export function emailFormatError(email: string): string | null {
  if (!email) return "Please enter your email address.";
  const invalid = "Please enter a valid email address, e.g. name@example.com.";
  if (email.length > 254) return invalid;
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at) return invalid;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return invalid;
  if (isDisposable(domain)) {
    return "Temporary or disposable email addresses can't be used. Please use your own email address.";
  }
  const fix = DOMAIN_TYPOS[domain];
  if (fix) return `Did you mean ${local}@${fix}? Please check your email address.`;
  return null;
}

const DNS_TIMEOUT_MS = 4000;
const NO_MAIL = "This email address can't receive email (its domain has no mail server). Please check it.";
/** Definite answers: the domain doesn't exist, or publishes no MX. Anything else is a resolver problem. */
const NO_SUCH_MX = new Set(["ENOTFOUND", "ENODATA"]);

// Used only when the server's own resolver fails (down, misconfigured, refusing),
// so a broken local DNS doesn't silently switch the check off.
const publicResolver = new dns.Resolver({ timeout: 2000, tries: 1 });
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function resolveMxWithFallback(domain: string) {
  try {
    return await dns.resolveMx(domain);
  } catch (e: any) {
    if (NO_SUCH_MX.has(e?.code)) throw e;
    return publicResolver.resolveMx(domain);
  }
}

/**
 * Null when the domain publishes a mail server (MX). A domain that doesn't
 * exist, or has no MX / a "null MX" (RFC 7505), can't receive the verification
 * code, so the visitor is told right away. When no resolver answers in time the
 * check doesn't block: the emailed code still proves the inbox.
 */
export async function emailDomainError(email: string): Promise<string | null> {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolveMxWithFallback(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), DNS_TIMEOUT_MS);
      }),
    ]);
    // A null MX comes back as exchange "" (or ".").
    return records.some((r) => r.exchange && r.exchange !== ".") ? null : NO_MAIL;
  } catch (e: any) {
    if (NO_SUCH_MX.has(e?.code)) return NO_MAIL;
    console.warn(`[register] MX lookup for ${domain} failed (${e?.code ?? e}) - not blocking`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Password ────────────────────────────────────────────────────────────────


const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd",
  "p@ssword", "12345678", "123456789", "1234567890", "12345678910", "87654321", "11111111",
  "00000000", "qwerty12", "qwerty123", "qwerty1234", "qwertyuiop", "1q2w3e4r", "1q2w3e4r5t",
  "1qaz2wsx", "zaq12wsx", "abc12345", "abcd1234", "abc123456", "a1b2c3d4", "aa123456",
  "iloveyou", "iloveyou1", "iloveyou2", "letmein1", "letmein123", "welcome1", "welcome123",
  "welcome2024", "welcome2025", "welcome2026", "admin123", "admin1234", "administrator",
  "changeme", "changeme1", "sunshine1", "princess1", "football1", "baseball1", "monkey123",
  "dragon123", "master123", "superman1", "batman123", "trustno1", "starwars1", "computer1",
  "michael1", "jennifer1", "jordan23", "shadow123", "hello123", "freedom1", "whatever1",
  "summer2024", "summer2025", "summer2026", "winter2024", "winter2025", "winter2026",
  "spring2025", "spring2026", "autumn2025", "test1234", "testing123", "student1", "student123",
  "teacher1", "teacher123", "school123", "course123", "learning1", "instructional1",
]);

/** Error text for a weak password, or null. */
export function passwordError(password: string, ctx: { email: string; name: string }): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for your password.`;
  if (password.length > PASSWORD_MAX) return `Your password can be at most ${PASSWORD_MAX} characters.`;
  if (!/\p{L}/u.test(password) || !/[\p{N}\p{P}\p{S}]/u.test(password)) {
    return "Use both letters and numbers (or symbols) in your password.";
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return "This password is too common and easy to guess. Please choose another one.";
  }
  const local = ctx.email.split("@")[0] ?? "";
  if (local.length >= 4 && lower.includes(local)) return "Your password must not contain your email address.";
  for (const part of ctx.name.toLowerCase().split(" ")) {
    if (part.length >= 4 && lower.includes(part)) return "Your password must not contain your name.";
  }
  return null;
}

// ─── Bot traps ───────────────────────────────────────────────────────────────


const MIN_FILL_MS = 2000;
const MAX_FORM_AGE_MS = 3 * 60 * 60 * 1000;
const formKey = () => deriveSecret("register-form");

/** A signed "this form was shown at" token for the sign-up form. */
export function issueFormToken(now = Date.now()): string {
  const t = now.toString(36);
  const sig = crypto.createHmac("sha256", formKey()).update(t).digest("base64url").slice(0, 32);
  return `${t}.${sig}`;
}

/** "invalid" (missing / forged), "fast" (under 2 s), "stale" (over 3 h) or null when fine. */
export function formTokenProblem(token: string, now = Date.now()): "invalid" | "fast" | "stale" | null {
  const [t, sig] = token.split(".");
  if (!t || !sig) return "invalid";
  const expected = crypto.createHmac("sha256", formKey()).update(t).digest("base64url").slice(0, 32);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return "invalid";
  const shownAt = Number.parseInt(t, 36);
  if (!Number.isFinite(shownAt)) return "invalid";
  const age = now - shownAt;
  if (age < MIN_FILL_MS) return "fast";
  if (age > MAX_FORM_AGE_MS) return "stale";
  return null;
}

// ─── Cloudflare Turnstile (optional) ─────────────────────────────────────────

/** The public site key when Turnstile is fully configured (both keys), else null. */
export function turnstileSiteKey(): string | null {
  const site = process.env.TURNSTILE_SITE_KEY?.trim();
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  return site && secret ? site : null;
}

/** True when Turnstile is off, or when Cloudflare confirms the token. Fails closed when on. */
export async function verifyTurnstile(token: string, request: Request): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!turnstileSiteKey() || !secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  const ip = clientIp(request);
  if (ip !== "unknown") body.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!json.success) console.warn(`[register] Turnstile refused: ${(json["error-codes"] ?? []).join(", ")}`);
    return json.success === true;
  } catch (e) {
    console.error("[register] Turnstile verification failed:", e);
    return false;
  }
}

// ─── Pending sign-up (until the emailed code is entered) ─────────────────────

const PENDING_COOKIE = "lms_signup";
const pendingKey = () => deriveSecret("pending-registration"); // 32 bytes
const codeKey = () => deriveSecret("registration-code");

const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";

export type PendingRegistration = {
  name: string;
  email: string;
  passwordHash: string;
  codeHash: string;
  /** Expiry, ms since epoch. */
  exp: number;
};

const codeHashFor = (email: string, code: string) =>
  crypto.createHmac("sha256", codeKey()).update(`${email}:${code}`).digest("hex");

/** A fresh 6-digit code and the hash the pending cookie keeps. */
export function newRegistrationCode(email: string): { code: string; codeHash: string } {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, codeHash: codeHashFor(email, code) };
}

export function registrationCodeMatches(p: PendingRegistration, code: string): boolean {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  return crypto.timingSafeEqual(Buffer.from(codeHashFor(p.email, clean)), Buffer.from(p.codeHash));
}

/** AES-256-GCM, so the name, email and password hash aren't readable in the browser. */
function seal(value: object): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", pendingKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

function unseal(raw: string): unknown {
  try {
    const [iv, tag, enc] = raw.split(".").map((s) => Buffer.from(s, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", pendingKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

export function createPendingRegistrationCookie(p: Omit<PendingRegistration, "exp">): string {
  const exp = Date.now() + REGISTRATION_CODE_MINUTES * 60 * 1000;
  return serialize(PENDING_COOKIE, seal({ ...p, exp }), {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: REGISTRATION_CODE_MINUTES * 60,
  });
}

export function clearPendingRegistrationCookie(): string {
  return serialize(PENDING_COOKIE, "", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/", maxAge: 0 });
}

export function readPendingRegistration(request: Request): PendingRegistration | null {
  const raw = parse(request.headers.get("Cookie") || "")[PENDING_COOKIE];
  if (!raw) return null;
  const p = unseal(raw) as Partial<PendingRegistration> | null;
  if (
    !p ||
    typeof p.name !== "string" ||
    typeof p.email !== "string" ||
    typeof p.passwordHash !== "string" ||
    typeof p.codeHash !== "string" ||
    typeof p.exp !== "number" ||
    p.exp < Date.now()
  ) {
    return null;
  }
  return p as PendingRegistration;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
}
