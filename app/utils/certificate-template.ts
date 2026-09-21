/**
 * The certificate template — ONE renderer, used in three places.
 *
 * This module is deliberately isomorphic: no `.server` suffix, no `prisma`
 * import, no `node:` import, no environment access. That is load-bearing.
 * It is imported by
 *   • app/routes/certificate.$courseId.tsx      (the learner's real certificate)
 *   • app/routes/certificate-design.preview.tsx (admin "open as learner")
 *   • app/routes/certificate-design.tsx         (the admin editor's live preview,
 *                                                rendered in the BROWSER)
 * so the template cannot exist in two places and drift apart. If you add a
 * server-only import here, the admin editor stops building.
 *
 * Everything the admin can change is plain data validated by normalizeConfig().
 * There is no rich text, no custom HTML and no custom CSS field, by design:
 * this output is assembled as a raw HTML string, so admin-authored markup would
 * be stored XSS in every learner's browser.
 */

// ─── Branded config ───────────────────────────────────────────────────────────
// `SafeConfig` can only be produced by normalizeConfig(). renderCertificateHtml
// accepts nothing else, so a raw Prisma row — or a row someone edited directly
// in psql — cannot reach the renderer without being validated first. This is a
// compile-time guarantee rather than a convention someone has to remember.
declare const SAFE: unique symbol;

export type CertificateConfig = {
  orgName: string;
  logoUrl: string | null;
  accentColor: string;
  secondaryColor: string;
  borderStyle: BorderStyle;
  fontPair: FontPairKey;
  headline: string;
  introLine: string;
  midLine: string;
  dateLabel: string;
  footerNote: string | null;
  signatureImageUrl: string | null;
  signatureName: string | null;
  signatureTitle: string | null;
  showSeal: boolean;
  sealText: string;
  sealStarColor: string;
  showCourseSummary: boolean;
  verifyUrl: string | null;
  paperSize: PaperSize;
  orientation: Orientation;
  dateFormat: DateFormat;
  showCertificateId: boolean;
  showInstructor: boolean;
  certificateIdPrefix: string;
};

export type SafeConfig = CertificateConfig & { readonly [SAFE]: true };

export type CertificateData = {
  learnerName: string;
  courseTitle: string;
  /** Course.summary - the one-liner printed under the course title. */
  courseSummary?: string | null;
  completedAt: string | Date;
  instructor?: string | null;
  certificateId?: string | null;
};

export type BorderStyle =
  | "NONE"
  | "SOLID"
  | "DASHED"
  | "DOTTED"
  | "DOUBLE"
  | "TWIN"
  | "THICK"
  | "CORNERS"
  | "CORNERS_LINE"
  | "ORNATE"
  | "GRADIENT"
  | "HATCH"
  | "HATCH_RULE"
  | "LAYERED";

/** Every style, in the order the admin picker shows them. */
export const BORDER_STYLES: readonly BorderStyle[] = [
  "NONE", "SOLID", "DASHED", "DOTTED", "DOUBLE", "TWIN", "THICK",
  "CORNERS", "CORNERS_LINE", "ORNATE", "GRADIENT", "HATCH", "HATCH_RULE", "LAYERED",
];
export type PaperSize = "AUTO" | "A4" | "LETTER";
export type Orientation = "PORTRAIT" | "LANDSCAPE";
export type DateFormat = "MONTH_DAY_YEAR" | "DAY_MONTH_YEAR" | "ISO";
export type FontPairKey = "CLASSIC" | "EDITORIAL" | "MODERN" | "FRIENDLY" | "PLAIN";

// ─── Choices ──────────────────────────────────────────────────────────────────

/**
 * Fonts ship as curated PAIRS rather than two free dropdowns. A non-designer
 * picking a heading and a body face independently can produce 20 combinations,
 * most of them bad; five pairs that are known to work is the kinder control.
 */
export const FONT_PAIRS: Record<
  FontPairKey,
  { label: string; heading: string; body: string; google: string }
> = {
  CLASSIC: {
    label: "Classic — Playfair Display & Inter",
    heading: "'Playfair Display', Georgia, serif",
    body: "'Inter', system-ui, sans-serif",
    google: "family=Inter:wght@400;600;700&family=Playfair+Display:wght@700",
  },
  EDITORIAL: {
    label: "Editorial — Lora & Source Sans 3",
    heading: "'Lora', Georgia, serif",
    body: "'Source Sans 3', system-ui, sans-serif",
    google: "family=Lora:wght@700&family=Source+Sans+3:wght@400;600;700",
  },
  MODERN: {
    label: "Modern — Montserrat & Inter",
    heading: "'Montserrat', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    google: "family=Inter:wght@400;600;700&family=Montserrat:wght@700",
  },
  FRIENDLY: {
    label: "Friendly — Merriweather & Lato",
    heading: "'Merriweather', Georgia, serif",
    body: "'Lato', system-ui, sans-serif",
    google: "family=Lato:wght@400;700&family=Merriweather:wght@700",
  },
  PLAIN: {
    label: "Plain — Inter only",
    heading: "'Inter', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    google: "family=Inter:wght@400;600;700;900",
  },
};

/**
 * Paper sizes in CSS px at 96dpi as well as the physical units used by @page.
 * The admin editor sizes its preview canvas from the SAME map that builds the
 * @page rule, so the preview cannot disagree with what actually prints.
 *
 * AUTO emits NO @page rule — byte-identical to how this certificate printed
 * before it became configurable. That keeps deploy day a no-op, at the cost of
 * leaving the browser's own URL/date header on the page; the editor says so
 * next to the control rather than hiding it.
 */
export const PAPER: Record<Exclude<PaperSize, "AUTO">, { css: string; w: number; h: number }> = {
  A4: { css: "210mm 297mm", w: 794, h: 1123 },
  LETTER: { css: "8.5in 11in", w: 816, h: 1056 },
};

/** Preview canvas size in CSS px for a given paper + orientation. */
export function paperPixels(paperSize: PaperSize, orientation: Orientation) {
  const base = paperSize === "AUTO" ? PAPER.A4 : PAPER[paperSize];
  return orientation === "LANDSCAPE"
    ? { w: base.h, h: base.w }
    : { w: base.w, h: base.h };
}

export const BORDER_LABELS: Record<BorderStyle, string> = {
  NONE: "None",
  SOLID: "Simple line",
  DASHED: "Dashed",
  DOTTED: "Dotted",
  DOUBLE: "Double line",
  TWIN: "Twin rules",
  THICK: "Bold band",
  CORNERS: "Corner brackets",
  CORNERS_LINE: "Line with corners",
  ORNATE: "Ornate",
  GRADIENT: "Gradient band",
  HATCH: "Diagonal hatch",
  HATCH_RULE: "Hatch with inner rule",
  LAYERED: "Layered rules",
};

/**
 * The inner frame, as CSS.
 *
 * Returned as a rule block rather than a `border:` value because several of
 * these need two pseudo-elements or a stack of gradients. The admin picker
 * calls the SAME function with its own selector and a smaller scale, so each
 * swatch is drawn by the code that draws the certificate - a swatch cannot
 * promise a border the page then renders differently.
 *
 * Everything is plain CSS backgrounds, borders and box-shadows: no masks, no
 * SVG, no external assets, so it all survives printing (the template already
 * sets print-color-adjust: exact).
 */
export function borderFrameCss(
  style: BorderStyle,
  accent: string,
  second: string,
  opts: { selector?: string; scale?: number } = {},
): string {
  const sel = opts.selector ?? ".cert";
  const k = opts.scale ?? 1;
  const px = (n: number) => `${Math.max(1, Math.round(n * k))}px`;
  const before = `${sel}::before`;
  const after = `${sel}::after`;
  const base = "content:''; position:absolute; pointer-events:none;";
  // A flat colour expressed as a gradient, so it can be used as a background
  // layer with its own size and position.
  const bar = (c: string) => `linear-gradient(${c},${c})`;

  // Eight background layers: two short bars meeting at each corner.
  const corners = (c: string, len: number, w: number) =>
    [
      [`left top`, `${px(len)} ${px(w)}`],
      [`left top`, `${px(w)} ${px(len)}`],
      [`right top`, `${px(len)} ${px(w)}`],
      [`right top`, `${px(w)} ${px(len)}`],
      [`left bottom`, `${px(len)} ${px(w)}`],
      [`left bottom`, `${px(w)} ${px(len)}`],
      [`right bottom`, `${px(len)} ${px(w)}`],
      [`right bottom`, `${px(w)} ${px(len)}`],
    ]
      .map(([pos, size]) => `${bar(c)} ${pos}/${size} no-repeat`)
      .join(", ");

  switch (style) {
    case "NONE":
      return "";
    case "SOLID":
      return `${before} { ${base} inset:${px(12)}; border:1.5px solid ${second}; border-radius:${px(10)}; }`;
    case "DASHED":
      return `${before} { ${base} inset:${px(12)}; border:1.5px dashed ${second}; border-radius:${px(10)}; }`;
    case "DOTTED":
      return `${before} { ${base} inset:${px(12)}; border:2px dotted ${second}; border-radius:${px(10)}; }`;
    case "DOUBLE":
      return `${before} { ${base} inset:${px(12)}; border:4px double ${second}; border-radius:${px(10)}; }`;
    case "TWIN":
      return (
        `${before} { ${base} inset:${px(10)}; border:1px solid ${second}; border-radius:${px(10)}; }` +
        `${after} { ${base} inset:${px(18)}; border:1px solid ${second}; border-radius:${px(6)}; }`
      );
    case "THICK":
      return `${before} { ${base} inset:${px(12)}; border:${px(6)} solid ${second}; border-radius:${px(10)}; }`;
    case "CORNERS":
      return `${before} { ${base} inset:${px(14)}; background:${corners(second, 56, 2)}; }`;
    case "CORNERS_LINE":
      return (
        `${before} { ${base} inset:${px(12)}; border:1px solid ${second}; border-radius:${px(4)}; }` +
        `${after} { ${base} inset:${px(12)}; background:${corners(accent, 40, 3)}; }`
      );
    case "ORNATE":
      return (
        `${before} { ${base} inset:${px(12)}; border:3px double ${second}; border-radius:${px(6)}; }` +
        `${after} { ${base} inset:${px(20)}; background:${corners(accent, 30, 2)}; }`
      );
    case "GRADIENT":
      // border-image drops border-radius; a square frame is the intended look.
      return `${before} { ${base} inset:${px(12)}; border:4px solid transparent; border-image:linear-gradient(135deg, ${accent}, ${second}) 1; }`;
    case "HATCH":
      return `${before} { ${base} inset:${px(12)}; border:8px solid transparent; border-image:repeating-linear-gradient(45deg, ${second} 0 4px, transparent 4px 9px) 8; }`;
    case "HATCH_RULE":
      // The formal look: a hatched band at the edge with a hairline rule set
      // in from it, which is what reads as "certificate" rather than "poster".
      return (
        `${before} { ${base} inset:${px(22)}; border:9px solid transparent; border-image:repeating-linear-gradient(45deg, ${second} 0 4px, transparent 4px 9px) 9; }` +
        `${after} { ${base} inset:${px(42)}; border:1px solid ${accent}; }`
      );
    case "LAYERED":
      // Inset shadows paint outside-in, earlier layers on top: this reads as
      // line / gap / line / gap / line. The gaps are the card's own white.
      return (
        `${before} { ${base} inset:${px(10)}; border-radius:${px(8)};` +
        ` box-shadow: inset 0 0 0 1px ${second}, inset 0 0 0 4px #fff,` +
        ` inset 0 0 0 5px ${second}, inset 0 0 0 8px #fff, inset 0 0 0 9px ${second}; }`
      );
  }
}

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  MONTH_DAY_YEAR: "September 21, 2026",
  DAY_MONTH_YEAR: "21 September 2026",
  ISO: "2026-09-21",
};

// ─── Defaults ─────────────────────────────────────────────────────────────────
// Every value here is what was hardcoded in certificate.$courseId.tsx before
// this feature existed. The table starts empty and resolution falls through to
// this object, so certificates render identically until an admin saves.
export const DEFAULT_CONFIG: CertificateConfig = {
  orgName: "Instructional Graphics Academy",
  logoUrl: null,
  accentColor: "#1D375F",
  secondaryColor: "#C69445",
  borderStyle: "HATCH_RULE",
  fontPair: "CLASSIC",
  headline: "Certificate of Completion",
  introLine: "This certifies that",
  midLine: "has successfully completed",
  dateLabel: "Date of completion",
  footerNote:
    "This certificate records completion of an educational course. It is not a financial " +
    "credential or a license to give financial advice.",
  signatureImageUrl: null,
  signatureName: null,
  signatureTitle: "Course Director",
  showSeal: true,
  sealText: "Course Complete",
  sealStarColor: "#2C795A",
  showCourseSummary: true,
  verifyUrl: null,
  paperSize: "LETTER",
  orientation: "LANDSCAPE",
  dateFormat: "MONTH_DAY_YEAR",
  showCertificateId: true,
  showInstructor: false,
  certificateIdPrefix: "IG",
};

/** Server-side write limits, mirrored in the editor's maxLength attributes. */
export const LIMITS = {
  orgName: 120,
  headline: 120,
  introLine: 240,
  midLine: 240,
  dateLabel: 60,
  footerNote: 300,
  signatureName: 80,
  signatureTitle: 80,
  sealText: 28,
  verifyUrl: 90,
  certificateIdPrefix: 6,
} as const;

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Uploaded images only, pinned to the shape /upload actually returns.
 *
 * A free-text image URL would be an SSRF and tracking vector, and `javascript:`
 * / `data:` URIs would be script execution. The cloud-name class allows upper
 * case because Cloudinary permits it and a validator that silently rejects
 * every real URL is how a team ends up loosening it in a panic.
 *
 * The `/v<digits>/` version segment is required and `,` and `:` are NOT in the
 * path class. Those two characters are how Cloudinary expresses transformation
 * components, including the remote-fetch overlay that can pull in an image we
 * never uploaded. Every secure_url uploadToCloudinary returns is plain
 * `/image/upload/v<version>/<folder>/<name>.<ext>`, so nothing legitimate needs
 * them. A file extension is required and a query string is not allowed, so
 * nothing can be smuggled after the path either.
 */
const CLOUDINARY_IMAGE =
  /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/v\d+\/[A-Za-z0-9._/-]+\.(png|jpe?g|gif|webp|avif)$/;

export function safeImageUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 500) return null;
  // Reject traversal before the shape test; "/../" would still match the
  // character class above.
  if (s.includes("..")) return null;
  return CLOUDINARY_IMAGE.test(s) ? s : null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function safeColor(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v.trim()) ? v.trim() : fallback;
}

/**
 * Plain text only: control characters (including the line separators that
 * could break out of a CSS comment or confuse a log line) are stripped, then
 * the value is capped. Escaping happens at render time, not here, so the
 * stored value stays human-readable in the editor.
 */
function safeText(v: unknown, max: number, fallback: string): string {
  if (typeof v !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim().slice(0, max);
  return s || fallback;
}

function safeOptionalText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").trim().slice(0, max);
  return s || null;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

/**
 * The ONLY way to produce a SafeConfig.
 *
 * Runs on READ as well as on write. Validating on write alone would trust the
 * table; a row edited directly in psql, or written by an older version of the
 * save path, must still be unable to inject. Treating our own table as
 * untrusted input is cheap here and is the whole security story for a renderer
 * that emits raw HTML.
 */
export function normalizeConfig(raw: unknown): SafeConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG;

  const cfg: CertificateConfig = {
    orgName: safeText(r.orgName, LIMITS.orgName, d.orgName),
    logoUrl: safeImageUrl(r.logoUrl),
    accentColor: safeColor(r.accentColor, d.accentColor),
    secondaryColor: safeColor(r.secondaryColor, d.secondaryColor),
    borderStyle: pick(r.borderStyle, BORDER_STYLES, d.borderStyle),
    fontPair: pick(
      r.fontPair,
      ["CLASSIC", "EDITORIAL", "MODERN", "FRIENDLY", "PLAIN"] as const,
      d.fontPair,
    ),
    headline: safeText(r.headline, LIMITS.headline, d.headline),
    introLine: safeText(r.introLine, LIMITS.introLine, d.introLine),
    midLine: safeText(r.midLine, LIMITS.midLine, d.midLine),
    dateLabel: safeText(r.dateLabel, LIMITS.dateLabel, d.dateLabel),
    footerNote: safeOptionalText(r.footerNote, LIMITS.footerNote),
    signatureImageUrl: safeImageUrl(r.signatureImageUrl),
    signatureName: safeOptionalText(r.signatureName, LIMITS.signatureName),
    signatureTitle: safeOptionalText(r.signatureTitle, LIMITS.signatureTitle),
    showSeal: r.showSeal !== false,
    sealText: safeText(r.sealText, LIMITS.sealText, d.sealText),
    sealStarColor: safeColor(r.sealStarColor, d.sealStarColor),
    showCourseSummary: r.showCourseSummary !== false,
    // Printed as text, never as a link: a certificate is a paper document and
    // an <a> here would only invite an admin to point it somewhere hostile.
    verifyUrl: safeOptionalText(r.verifyUrl, LIMITS.verifyUrl),
    paperSize: pick(r.paperSize, ["AUTO", "A4", "LETTER"] as const, d.paperSize),
    orientation: pick(r.orientation, ["PORTRAIT", "LANDSCAPE"] as const, d.orientation),
    dateFormat: pick(
      r.dateFormat,
      ["MONTH_DAY_YEAR", "DAY_MONTH_YEAR", "ISO"] as const,
      d.dateFormat,
    ),
    showCertificateId: r.showCertificateId === true,
    showInstructor: r.showInstructor === true,
    certificateIdPrefix:
      safeText(r.certificateIdPrefix, LIMITS.certificateIdPrefix, d.certificateIdPrefix)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "") || d.certificateIdPrefix,
  };

  return cfg as SafeConfig;
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

/**
 * HTML entity escaping for every dynamic value. The learner's name and the
 * course title come from free-text inputs and this response is raw HTML, so a
 * name like `<img onerror=...>` would otherwise execute in every viewer's
 * browser. Do not remove this when editing the template.
 */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Formatted by hand rather than with toLocaleDateString: this module runs on
 * the server AND in the admin's browser, and ICU data differs between the two,
 * so a locale-based format could make the preview disagree with the real page.
 *
 * Read in UTC for the same reason. completedAt is stored as a UTC instant; with
 * local-time getters a completion at 23:30 UTC would print as the 14th for a
 * server in UTC and the 15th for an admin previewing from UTC+6. One completion
 * has one date, and everybody should see it.
 */
export function formatCertDate(input: string | Date, format: DateFormat): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (format === "ISO") {
    return `${year}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (format === "DAY_MONTH_YEAR") return `${day} ${month} ${year}`;
  return `${month} ${day}, ${year}`;
}

/**
 * A human-readable credential number derived from data that is immutable by
 * construction: the Progress row's id and the completion date. Nothing is
 * stored and nothing is written on the hot path, and the same completion always
 * yields the same serial.
 *
 * Display only. 32 bits is plenty to print on a page nobody looks up, and far
 * too little for an unauthenticated /verify endpoint — if one is ever built it
 * must issue a crypto.randomInt serial instead (see generateLicenseKey in
 * app/utils/auth.server.ts for the pattern).
 */
export function certificateSerial(
  progressId: string,
  courseTitle: string,
  prefix: string,
): string {
  // Up to three word-initials from the course, so the serial says which course
  // it belongs to at a glance.
  const code =
    courseTitle
      .split(" ")
      .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
      .filter(Boolean)
      .slice(0, 3)
      .map((w) => w[0].toUpperCase())
      .join("") || "GEN";

  // Base36 rather than raw hex, so the tail uses the whole alphabet and reads
  // like a reference number instead of a fragment of a uuid.
  let n = 0n;
  for (const ch of progressId.replace(/-/g, "").slice(0, 12)) {
    const v = parseInt(ch, 16);
    if (!Number.isNaN(v)) n = n * 16n + BigInt(v);
  }
  const tail = n.toString(36).toUpperCase().padStart(6, "0").slice(-6);

  return `${prefix}-${code}-${tail}`;
}

const STAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

// ─── The template ─────────────────────────────────────────────────────────────

export type RenderOptions = {
  /**
   * When set, a "Download / Print" button and a nonce'd listener script are
   * emitted. The learner route passes a per-response nonce; the admin editor
   * passes nothing, because its preview iframe is sandboxed WITHOUT
   * allow-scripts and must contain no script at all.
   */
  printNonce?: string;
  /**
   * Emit the print rules unwrapped, so the screen shows exactly what paper
   * will. Drives the editor's Screen/Print toggle from the same rule set — a
   * second stylesheet would be a second thing to drift.
   */
  forcePrint?: boolean;
};

export function renderCertificateHtml(
  cfg: SafeConfig,
  data: CertificateData,
  opts: RenderOptions = {},
): string {
  const fonts = FONT_PAIRS[cfg.fontPair];
  const accent = cfg.accentColor;
  const second = cfg.secondaryColor;
  const frameCss = borderFrameCss(cfg.borderStyle, accent, second);

  // AUTO + PORTRAIT emits nothing at all, which is byte-identical to how this
  // certificate printed before it became configurable (see the PAPER comment).
  // AUTO + LANDSCAPE still has to turn the sheet, or the editor would promise a
  // rotation the printed page never performs; `size: landscape` does exactly
  // that without pinning dimensions or touching the browser's own margins.
  const pageRule =
    cfg.paperSize === "AUTO"
      ? cfg.orientation === "LANDSCAPE"
        ? "@page { size: landscape; }"
        : ""
      : `@page { size: ${
          cfg.orientation === "LANDSCAPE"
            ? PAPER[cfg.paperSize].css.split(" ").reverse().join(" ")
            : PAPER[cfg.paperSize].css
        }; margin: 0; }`;

  // Without print-color-adjust the navy and mustard print as grey on most
  // browsers' default "simplify page" behaviour.
  const printCss = `
    body { background: #fff; padding: 0; min-height: auto; }
    .page { box-shadow: none; }
    .no-print { display: none !important; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }`;

  const dateText = formatCertDate(data.completedAt, cfg.dateFormat);

  // The masthead is the uploaded mark when there is one; until then the
  // organisation's name is typeset as a stand-in.
  const masthead = cfg.logoUrl
    ? `<img class="logo" src="${esc(cfg.logoUrl)}" alt="${esc(cfg.orgName)}"/>`
    : `<p class="org">${esc(cfg.orgName)}</p>`;

  const summary =
    cfg.showCourseSummary && data.courseSummary
      ? `<p class="summary">${esc(data.courseSummary)}</p>`
      : "";

  const instructorLine =
    cfg.showInstructor && data.instructor
      ? `<p class="summary">Instructor: ${esc(data.instructor)}</p>`
      : "";

  // Left column. The signature image replaces the typeset name above the rule
  // when one has been uploaded.
  const sigMark = cfg.signatureImageUrl
    ? `<img class="sig-img" src="${esc(cfg.signatureImageUrl)}" alt=""/>`
    : cfg.signatureName
      ? `<p class="sig-mark">${esc(cfg.signatureName)}</p>`
      : `<span class="sig-gap"></span>`;

  const signatureCol =
    cfg.signatureImageUrl || cfg.signatureName || cfg.signatureTitle
      ? `<div class="col">
      ${sigMark}
      <div class="rule"></div>
      ${cfg.signatureName ? `<p class="col-name">${esc(cfg.signatureName)}</p>` : ""}
      ${cfg.signatureTitle ? `<p class="col-label">${esc(cfg.signatureTitle)}</p>` : ""}
    </div>`
      : `<div class="col"></div>`;

  const seal = cfg.showSeal
    ? `<div class="seal"><div class="seal-in">
      <svg class="seal-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
      <span class="seal-text">${esc(cfg.sealText)}</span>
    </div></div>`
    : "";

  const idBlock =
    (cfg.showCertificateId && data.certificateId) || cfg.verifyUrl
      ? `<div class="foot-id">
      ${cfg.showCertificateId && data.certificateId ? `<p class="cert-id">${esc(data.certificateId)}</p>` : ""}
      ${cfg.verifyUrl ? `<p class="verify">${esc(cfg.verifyUrl)}</p>` : ""}
    </div>`
      : "";

  const footer =
    cfg.footerNote || idBlock
      ? `<div class="foot">
      <p class="foot-note">${cfg.footerNote ? esc(cfg.footerNote) : ""}</p>
      ${idBlock}
    </div>`
      : "";

  const printButton = opts.printNonce
    ? `
    <div class="no-print" style="text-align:center;padding:0 0 32px;">
      <button id="cert-print" type="button">Download / Print Certificate</button>
    </div>
    <script nonce="${esc(opts.printNonce)}">
      document.getElementById('cert-print').addEventListener('click', function () { window.print(); });
    </script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Certificate &ndash; ${esc(data.courseTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts.google}&display=swap"/>
<style>
  ${pageRule}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ${fonts.body}; background: #fff; min-height: 100vh; display: flex; flex-direction: column; }
  .page { position: relative; flex: 1; display: flex; flex-direction: column; background: #fff; overflow: hidden; }
  ${frameCss}
  .cert { position: relative; z-index: 1; flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 82px 104px 60px; }

  .logo { max-height: 76px; max-width: 260px; object-fit: contain; margin-bottom: 18px; }
  .org { font-size: 13px; font-weight: 600; letter-spacing: .2em; text-transform: uppercase; color: ${accent}; opacity: .8; }
  h1 { font-family: ${fonts.heading}; font-size: 46px; color: ${accent}; margin-top: 14px; line-height: 1.1; }
  .divider { width: 96px; height: 2px; background: ${accent}; margin: 18px auto 22px; }
  .sub { font-size: 14px; color: ${accent}; opacity: .75; }
  .name { font-size: 34px; font-weight: 700; color: ${accent}; margin-top: 10px; line-height: 1.15; }
  .name-rule { width: 100%; max-width: 520px; height: 1px; background: ${accent}; opacity: .35; margin: 14px auto 16px; }
  .course { font-size: 20px; font-weight: 700; color: #111827; max-width: 640px; line-height: 1.35; margin-top: 12px; }
  .summary { font-size: 14px; color: ${accent}; opacity: .75; max-width: 660px; line-height: 1.5; margin-top: 8px; }

  .cols { margin-top: auto; padding-top: 40px; width: 100%; display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
  .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; }
  .col-mid { flex: 0 0 auto; }
  .rule { width: 100%; height: 1px; background: ${accent}; opacity: .55; margin-bottom: 8px; }
  .col-name { font-size: 12px; font-weight: 700; color: #111827; }
  .col-label { font-size: 11px; color: ${accent}; opacity: .7; margin-top: 2px; }
  .sig-mark { font-family: ${fonts.heading}; font-size: 22px; color: ${accent}; padding-bottom: 8px; }
  .sig-img { max-height: 46px; max-width: 200px; object-fit: contain; margin-bottom: 6px; }
  .sig-gap { display: block; height: 30px; }
  .date-value { font-family: ${fonts.heading}; font-size: 21px; color: ${accent}; padding-bottom: 8px; }

  .seal { width: 100px; height: 100px; border-radius: 50%; border: 3px solid ${second}; padding: 5px; }
  .seal-in { width: 100%; height: 100%; border-radius: 50%; background: ${accent}; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; }
  .seal-star { width: 22px; height: 22px; fill: ${cfg.sealStarColor}; }
  .seal-text { font-size: 8px; font-weight: 700; letter-spacing: .1em; line-height: 1.25; text-transform: uppercase; max-width: 62px; }

  .foot { margin-top: 26px; padding-top: 14px; border-top: 1px solid ${accent}33; width: 100%; display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; text-align: left; }
  .foot-note { font-size: 10px; line-height: 1.5; color: ${accent}; opacity: .65; max-width: 58%; }
  .foot-id { text-align: right; margin-left: auto; }
  .cert-id { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: ${accent}; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .verify { font-size: 11px; font-weight: 700; color: ${second}; margin-top: 2px; }

  #cert-print { background: ${accent}; color: #fff; border: none; padding: 10px 28px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: ${fonts.body}; }
  ${opts.forcePrint ? printCss : `@media print {${printCss}}`}
</style>
</head>
<body>
  <div class="page">
    <div class="cert">
      ${masthead}
      <h1>${esc(cfg.headline)}</h1>
      <div class="divider"></div>
      <p class="sub">${esc(cfg.introLine)}</p>
      <p class="name">${esc(data.learnerName)}</p>
      <div class="name-rule"></div>
      <p class="sub">${esc(cfg.midLine)}</p>
      <p class="course">${esc(data.courseTitle)}</p>
      ${summary}
      ${instructorLine}

      <div class="cols">
        ${signatureCol}
        <div class="col col-mid">${seal}</div>
        <div class="col">
          <p class="date-value">${esc(dateText)}</p>
          <div class="rule"></div>
          <p class="col-label">${esc(cfg.dateLabel)}</p>
        </div>
      </div>

      ${footer}
    </div>
  </div>
  ${printButton}
</body>
</html>`;
}
