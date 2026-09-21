import { data } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Award,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  ExternalLink,
  Monitor,
  Printer,
  Upload,
  X,
} from "lucide-react";
import { prisma } from "../utils/db.server";
import { requireAdmin } from "../utils/auth.server";
import { resolveCertificateConfig, GLOBAL_TEMPLATE_ID } from "../utils/certificate.server";
import {
  BORDER_LABELS,
  BORDER_STYLES,
  borderFrameCss,
  DATE_FORMAT_LABELS,
  DEFAULT_CONFIG,
  FONT_PAIRS,
  LIMITS,
  certificateSerial,
  normalizeConfig,
  paperPixels,
  renderCertificateHtml,
  safeImageUrl,
  type BorderStyle,
  type CertificateConfig,
  type SafeConfig,
  type DateFormat,
  type FontPairKey,
  type Orientation,
  type PaperSize,
} from "../utils/certificate-template";

/**
 * /certificate-design — the admin editor for the completion certificate.
 *
 * The preview on the right is rendered by the SAME function that produces the
 * learner's real page (utils/certificate-template.ts), executed in the admin's
 * browser. There is no second template to drift, and no server round-trip per
 * keystroke.
 */

// The 20 editable columns, in one place so the read, the write and the form
// cannot disagree about what a template is made of.
const FIELDS = [
  "orgName", "logoUrl", "accentColor", "secondaryColor", "borderStyle",
  "fontPair", "headline", "introLine", "midLine", "dateLabel", "footerNote",
  "signatureImageUrl", "signatureName", "signatureTitle",
  "showSeal", "sealText", "sealStarColor", "showCourseSummary", "verifyUrl",
  "paperSize", "orientation", "dateFormat",
  "showCertificateId", "showInstructor", "certificateIdPrefix",
] as const;

const BOOLEAN_FIELDS = new Set([
  "showCertificateId", "showInstructor", "showSeal", "showCourseSummary",
]);

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const { config, exists, tableReady } = await resolveCertificateConfig();

  // How many learners already hold a certificate. Shown in the editor so a
  // wording change is an informed decision rather than a silent rewrite of
  // documents people have already printed.
  const issuedCount = await prisma.progress
    .count({ where: { completedAt: { not: null } } })
    .catch(() => 0);

  // Real completions to preview against — a genuine 60-character course title
  // should break the layout while the admin is typing, not afterwards.
  const rows = await prisma.progress
    .findMany({
      where: { completedAt: { not: null } },
      select: {
        id: true,
        completedAt: true,
        user: { select: { name: true } },
        course: { select: { title: true, summary: true, instructor: true } },
      },
      orderBy: { completedAt: "desc" },
      take: 25,
    })
    .catch(() => []);

  const samples = rows
    .map((r) => ({
      id: r.id,
      learnerName: r.user?.name ?? "Learner",
      courseTitle: r.course?.title ?? "Untitled course",
      courseSummary: r.course?.summary ?? null,
      completedAt: (r.completedAt ?? new Date()).toISOString(),
      instructor: r.course?.instructor ?? null,
    }))
    // Longest title first: the worst case is the one worth looking at.
    .sort((a, b) => b.courseTitle.length - a.courseTitle.length);

  return { config, exists, tableReady, issuedCount, samples };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  // Raw SQL for the same reason the read uses it: on Plesk, `prisma generate`
  // and `migrate deploy` are separate steps, so the generated client can
  // predate this model. prisma.certificateTemplate would then be undefined and
  // calling .upsert on it throws a synchronous TypeError.
  if (intent === "reset") {
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "CertificateTemplate" WHERE id = $1`,
        GLOBAL_TEMPLATE_ID,
      );
      // Deleting the row is the undo: resolution falls back to DEFAULT_CONFIG,
      // which is the original hardcoded design. No migration, no data loss.
      return data({ success: "Reset to the original design." });
    } catch (err) {
      console.error("[certificate-design] reset failed:", err);
      return data({ error: storageError }, { status: 503 });
    }
  }

  if (intent !== "save") {
    return data({ error: "Unknown action." }, { status: 400 });
  }

  // Everything arrives as strings. normalizeConfig is the ONLY validator: it
  // caps lengths, strips control characters, rejects any colour that is not
  // #rrggbb, pins image URLs to the Cloudinary delivery host and falls back to
  // a known value for every enum. Whatever it returns is safe to store.
  const raw: Record<string, unknown> = {};
  for (const f of FIELDS) {
    raw[f] = BOOLEAN_FIELDS.has(f) ? formData.get(f) === "true" : formData.get(f);
  }
  const cfg = normalizeConfig(raw);

  // Tell the admin when an image was dropped rather than silently saving null:
  // "I uploaded a logo and it vanished" is a bad afternoon.
  if (formData.get("logoUrl") && !cfg.logoUrl) {
    return data(
      { error: "That logo didn't come through. Upload it again, or choose a PNG or JPG." },
      { status: 400 },
    );
  }
  if (formData.get("signatureImageUrl") && !cfg.signatureImageUrl) {
    return data(
      { error: "That signature image didn't come through. Upload it again." },
      { status: 400 },
    );
  }

  const values = FIELDS.map((f) => cfg[f as keyof CertificateConfig]);
  const cols = FIELDS.map((f) => `"${f}"`).join(", ");
  const params = FIELDS.map((_, i) => `$${i + 2}`).join(", ");
  const updates = FIELDS.map((f) => `"${f}" = EXCLUDED."${f}"`).join(", ");

  try {
    await prisma.$executeRawUnsafe(
      // NOW() is timestamptz; these columns are TIMESTAMP(3) without a zone, so
      // it must be converted or the value lands in the session's timezone.
      `INSERT INTO "CertificateTemplate" (id, ${cols}, "createdAt", "updatedAt")
       VALUES ($1, ${params}, (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'))
       ON CONFLICT (id) DO UPDATE SET ${updates}, "updatedAt" = (NOW() AT TIME ZONE 'UTC')`,
      GLOBAL_TEMPLATE_ID,
      ...values,
    );
  } catch (err) {
    console.error("[certificate-design] save failed:", err);
    return data({ error: storageError }, { status: 503 });
  }

  return data({ success: "Saved. Every certificate now uses this design." });
}

const SAMPLE_TITLE = "Money Talks: Teaching Kids About Saving";
const SAMPLE_SUMMARY =
  "An animated course in personal finance, budgeting and smart spending - 3.5 contact hours";

const storageError =
  "Certificate settings could not be saved on this server. Restart the app — it applies " +
  "pending migrations on boot — then try again.";

// ─── Editor ───────────────────────────────────────────────────────────────────

export default function CertificateDesign() {
  const { config, exists, tableReady, issuedCount, samples } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: string; error?: string }>();

  const [cfg, setCfg] = useState<CertificateConfig>(config);
  const [printView, setPrintView] = useState(false);
  const [sampleIdx, setSampleIdx] = useState(0);
  const [adjusted, setAdjusted] = useState<string[]>([]);
  const saving = fetcher.state !== "idle";

  // Adopt the server's copy ONLY after a save actually succeeded.
  //
  // A fetcher action revalidates the loader whether it succeeded or not, so
  // `config` gets a fresh identity on failure too. Resyncing on every identity
  // change threw away the admin's entire draft the moment a save was rejected
  // — and, because the draft then matched the server, the button flipped to
  // "Saved". Gate it on the success payload instead, and keep the draft on
  // failure so they can fix the one bad field and retry.
  const adopted = useRef<unknown>(null);
  useEffect(() => {
    const d = fetcher.data;
    if (fetcher.state !== "idle" || !d?.success || d === adopted.current) return;
    adopted.current = d;
    setCfg(config);
    // normalizeConfig silently replaces anything it does not like. Say which
    // fields that was, rather than reporting a clean save of different values.
    setAdjusted(
      submitted.current
        ? FIELDS.filter((f) => String(submitted.current?.[f] ?? "") !== String(config[f] ?? ""))
        : [],
    );
  }, [fetcher.state, fetcher.data, config]);

  const dirty = useMemo(
    () => FIELDS.some((f) => cfg[f] !== config[f]),
    [cfg, config],
  );

  const set = <K extends keyof CertificateConfig>(k: K, v: CertificateConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));

  const submitted = useRef<Record<string, string> | null>(null);

  function save() {
    const payload: Record<string, string> = { intent: "save" };
    for (const f of FIELDS) {
      const v = cfg[f];
      payload[f] = v === null || v === undefined ? "" : String(v);
    }
    submitted.current = payload;
    setAdjusted([]);
    fetcher.submit(payload, { method: "post" });
  }

  // Everything the preview consumes is memoised and normalised.
  //  • a bare object literal here gave the preview effect a new `data` on every
  //    render, so the iframe was re-parsed on every keystroke anywhere;
  //  • new Date() in the render body made it non-deterministic as well;
  //  • the serial was built from the RAW prefix, so the preview could show
  //    "tmt!!-2026-…" for a value that stores and prints as "TMT-2026-…".
  const previewCfg = useMemo(() => normalizeConfig(cfg), [cfg]);
  const fallbackDate = useMemo(() => new Date().toISOString(), []);
  const sample = samples[sampleIdx];
  const previewData = useMemo(
    () => ({
      learnerName: sample?.learnerName ?? "Jamie Rivera",
      courseTitle: sample?.courseTitle ?? SAMPLE_TITLE,
      courseSummary: sample?.courseSummary ?? SAMPLE_SUMMARY,
      completedAt: sample?.completedAt ?? fallbackDate,
      instructor: sample?.instructor ?? "Denise Carter",
      certificateId: certificateSerial(
        sample?.id ?? "6c1f4a9e-0000-4000-8000-000000000000",
        sample?.courseTitle ?? SAMPLE_TITLE,
        previewCfg.certificateIdPrefix,
      ),
    }),
    [sample, fallbackDate, previewCfg.certificateIdPrefix],
  );

  return (
    <div className="p-6 lg:p-8">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <Award className="text-gray-700" size={22} />
          <h1 className="text-2xl font-semibold text-gray-900">Certificate Design</h1>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          How the completion certificate looks for every learner. The preview on the right is the
          real thing &mdash; it is drawn by the same code the learner&rsquo;s page uses.
        </p>
      </header>

      {!tableReady && (
        <Banner tone="warn">
          <strong>Certificate settings are not set up on this server yet.</strong> Restart the app
          &mdash; it applies pending migrations on boot. Certificates still work in the meantime and
          are using the built-in design.
        </Banner>
      )}
      {fetcher.data?.error && <Banner tone="error">{fetcher.data.error}</Banner>}
      {fetcher.data?.success && <Banner tone="ok">{fetcher.data.success}</Banner>}

      {issuedCount > 0 && (
        <Banner tone="info">
          {issuedCount} learner{issuedCount === 1 ? " has" : "s have"} already earned a certificate.
          Certificates are drawn fresh each time they are opened, so changes here also change how
          those look.
        </Banner>
      )}

      <div className="flex flex-col xl:flex-row gap-6 items-start">
        {/* ── Controls ──────────────────────────────────────────────────── */}
        <div className="w-full xl:w-[440px] xl:shrink-0 space-y-5">
          <Card title="Branding">
            {!exists && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
                Your learners see a <strong>Teach Me Like a Tot</strong> logo, but the certificate
                currently says <strong>InstructionalGraphics Academy</strong>. Set the name you want
                on the certificate before you save.
              </p>
            )}
            <Text
              label="Organisation name"
              value={cfg.orgName}
              onChange={(v) => set("orgName", v)}
              max={LIMITS.orgName}
              def={DEFAULT_CONFIG.orgName}
              onRevert={() => set("orgName", DEFAULT_CONFIG.orgName)}
              hint="Printed in small caps above the title."
            />
            <ImageField
              label="Logo"
              value={cfg.logoUrl}
              onChange={(v) => set("logoUrl", v)}
              hint="Replaces the star badge. A PNG with a transparent background works best."
            />
            <div className="grid grid-cols-2 gap-3">
              <Color label="Main colour" value={cfg.accentColor} onChange={(v) => set("accentColor", v)} def={DEFAULT_CONFIG.accentColor} onRevert={() => set("accentColor", DEFAULT_CONFIG.accentColor)} />
              <Color label="Second colour" value={cfg.secondaryColor} onChange={(v) => set("secondaryColor", v)} def={DEFAULT_CONFIG.secondaryColor} onRevert={() => set("secondaryColor", DEFAULT_CONFIG.secondaryColor)} />
            </div>
            {/* Normalised colours: these go into a real <style> element in
                this page, not into the sandboxed preview, so a half-typed or
                junk hex must never reach the stylesheet. */}
            <BorderPicker
              value={cfg.borderStyle}
              onChange={(v) => set("borderStyle", v)}
              accent={previewCfg.accentColor}
              second={previewCfg.secondaryColor}
            />
            <Select
              label="Fonts"
              value={cfg.fontPair}
              onChange={(v) => set("fontPair", v as FontPairKey)}
              options={Object.entries(FONT_PAIRS).map(([v, f]) => ({ value: v, label: f.label }))}
            />
          </Card>

          <Card title="Wording">
            <Text label="Title" value={cfg.headline} onChange={(v) => set("headline", v)} max={LIMITS.headline} def={DEFAULT_CONFIG.headline} onRevert={() => set("headline", DEFAULT_CONFIG.headline)} />
            <Text label="Line above the name" value={cfg.introLine} onChange={(v) => set("introLine", v)} max={LIMITS.introLine} def={DEFAULT_CONFIG.introLine} onRevert={() => set("introLine", DEFAULT_CONFIG.introLine)} />
            <Text label="Line above the course" value={cfg.midLine} onChange={(v) => set("midLine", v)} max={LIMITS.midLine} def={DEFAULT_CONFIG.midLine} onRevert={() => set("midLine", DEFAULT_CONFIG.midLine)} />
            <Text label="Date label" value={cfg.dateLabel} onChange={(v) => set("dateLabel", v)} max={LIMITS.dateLabel} def={DEFAULT_CONFIG.dateLabel} onRevert={() => set("dateLabel", DEFAULT_CONFIG.dateLabel)} />
            <Text
              label="Small print (optional)"
              value={cfg.footerNote ?? ""}
              onChange={(v) => set("footerNote", v || null)}
              max={LIMITS.footerNote}
              textarea
              hint="Plain text only. Anything that looks like HTML is printed literally, not run."
            />
          </Card>

          <Card title="Signature">
            <p className="text-xs text-gray-500 -mt-1 mb-3">
              Leave all three empty and the signature block is hidden entirely.
            </p>
            <ImageField
              label="Signature image"
              value={cfg.signatureImageUrl}
              onChange={(v) => set("signatureImageUrl", v)}
              hint="A scanned signature on a transparent or white background."
            />
            <Text label="Name" value={cfg.signatureName ?? ""} onChange={(v) => set("signatureName", v || null)} max={LIMITS.signatureName} />
            <Text label="Title" value={cfg.signatureTitle ?? ""} onChange={(v) => set("signatureTitle", v || null)} max={LIMITS.signatureTitle} hint="For example: Course Director" />
          </Card>

          <Card title="Seal">
            <Check
              label="Show the seal"
              checked={cfg.showSeal}
              onChange={(v) => set("showSeal", v)}
              hint="The medallion between the signature and the date."
            />
            {cfg.showSeal && (
              <>
                <Text
                  label="Seal wording"
                  value={cfg.sealText}
                  onChange={(v) => set("sealText", v)}
                  max={LIMITS.sealText}
                  def={DEFAULT_CONFIG.sealText}
                  onRevert={() => set("sealText", DEFAULT_CONFIG.sealText)}
                  hint="Two short words fit best; longer text wraps inside the circle."
                />
                <Color
                  label="Star colour"
                  value={cfg.sealStarColor}
                  onChange={(v) => set("sealStarColor", v)}
                  def={DEFAULT_CONFIG.sealStarColor}
                  onRevert={() => set("sealStarColor", DEFAULT_CONFIG.sealStarColor)}
                />
              </>
            )}
          </Card>

          <Card title="Paper &amp; printing">
            <Select
              label="Paper size"
              value={cfg.paperSize}
              onChange={(v) => set("paperSize", v as PaperSize)}
              options={[
                { value: "AUTO", label: "Automatic (browser decides)" },
                { value: "A4", label: "A4" },
                { value: "LETTER", label: "US Letter" },
              ]}
              hint={
                cfg.paperSize === "AUTO"
                  ? "On Automatic the browser adds its own web address and date along the top and bottom of the printed page. Choose A4 or US Letter to remove them."
                  : "The browser's own header and footer are removed and the design fills the sheet."
              }
            />
            <Select
              label="Orientation"
              value={cfg.orientation}
              onChange={(v) => set("orientation", v as Orientation)}
              options={[
                { value: "PORTRAIT", label: "Portrait (tall)" },
                { value: "LANDSCAPE", label: "Landscape (wide)" },
              ]}
            />
            <Select
              label="Date style"
              value={cfg.dateFormat}
              onChange={(v) => set("dateFormat", v as DateFormat)}
              options={Object.entries(DATE_FORMAT_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
          </Card>

          <Card title="Extras">
            <Check
              label="Show a certificate number"
              checked={cfg.showCertificateId}
              onChange={(v) => set("showCertificateId", v)}
              hint="A number built from the learner's completion, the same every time."
            />
            {cfg.showCertificateId && (
              <Text
                label="Number prefix"
                value={cfg.certificateIdPrefix}
                onChange={(v) => set("certificateIdPrefix", v.toUpperCase())}
                max={LIMITS.certificateIdPrefix}
                def={DEFAULT_CONFIG.certificateIdPrefix}
                onRevert={() => set("certificateIdPrefix", DEFAULT_CONFIG.certificateIdPrefix)}
                hint="Letters and numbers only."
              />
            )}
            <Check
              label="Show the instructor's name"
              checked={cfg.showInstructor}
              onChange={(v) => set("showInstructor", v)}
              hint="Only appears on courses that have an instructor set."
            />
            <Check
              label="Show the course summary"
              checked={cfg.showCourseSummary}
              onChange={(v) => set("showCourseSummary", v)}
              hint="The one-line description from the course, printed under its title. Courses without a summary simply omit the line."
            />
            <Text
              label="Verification line (optional)"
              value={cfg.verifyUrl ?? ""}
              onChange={(v) => set("verifyUrl", v || null)}
              max={LIMITS.verifyUrl}
              hint="Printed in the bottom corner as plain text, not a link. Only fill this in if that page really exists - a learner handing this to an employer will be taken at their word."
            />
          </Card>

          <div className="flex flex-wrap items-center gap-3 sticky bottom-0 bg-brand-beige/95 backdrop-blur py-3">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {dirty ? "Save changes" : "Saved"}
            </button>

            {/* While there are unsaved edits this is not a link at all. An
                <a> with a preventDefault'd onClick still navigates on
                middle-click and on "open in new tab", and still announces
                itself as a link, so it would show stale saved data without
                warning. */}
            {dirty ? (
              <span
                aria-disabled="true"
                title="Save your changes first"
                className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2.5 rounded-lg border border-gray-200 text-gray-400 cursor-not-allowed select-none"
              >
                <ExternalLink size={14} />
                Open as learner
              </span>
            ) : (
              <a
                href="/certificate-design/preview"
                target="_blank"
                rel="noopener noreferrer"
                title="Opens the saved design in a new tab"
                className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-white transition-colors"
              >
                <ExternalLink size={14} />
                Open as learner
              </a>
            )}

            {exists && (
              <fetcher.Form method="post" className="ml-auto">
                <input type="hidden" name="intent" value="reset" />
                <button
                  type="submit"
                  onClick={(e) => {
                    if (!confirm("Put the certificate back to its original design? Your changes will be lost.")) {
                      e.preventDefault();
                    }
                  }}
                  className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-red-600 px-3 py-2.5 rounded-lg transition-colors"
                >
                  <RotateCcw size={14} />
                  Reset everything
                </button>
              </fetcher.Form>
            )}
          </div>
        </div>

        {/* ── Preview ───────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 w-full xl:sticky xl:top-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
              <ToggleBtn active={!printView} onClick={() => setPrintView(false)} icon={Monitor} label="Screen" />
              <ToggleBtn active={printView} onClick={() => setPrintView(true)} icon={Printer} label="Print" />
            </div>
            {samples.length > 0 && (
              <select
                value={sampleIdx}
                onChange={(e) => setSampleIdx(Number(e.target.value))}
                className="text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white max-w-[280px]"
                title="Preview with a real learner's completion"
              >
                {samples.map((s, i) => (
                  <option key={s.id} value={i}>
                    {s.learnerName} &mdash; {s.courseTitle}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-gray-400 ml-auto hidden sm:block">
              {printView ? "Exactly what comes out of the printer" : "As it looks on screen"}
            </span>
          </div>
          <CertificatePreview cfg={previewCfg} data={previewData} printView={printView} />
        </div>
      </div>
    </div>
  );
}

// ─── Live preview ─────────────────────────────────────────────────────────────

/**
 * Renders the certificate into an about:blank iframe with doc.write.
 *
 * sandbox="allow-same-origin" WITHOUT allow-scripts is load-bearing: the
 * written document is admin-authored config, and granting it scripts would
 * turn a text field into script execution inside the admin's own session on
 * this origin. The renderer is called without a nonce, so it emits no script
 * at all — the sandbox is the second lock, not the only one.
 *
 * doc.write into the live document rather than srcDoc: a srcDoc swap remounts
 * the frame, which re-fetches the web fonts and flashes white on every
 * keystroke.
 */
function CertificatePreview({
  cfg,
  data,
  printView,
}: {
  cfg: SafeConfig;
  data: {
    learnerName: string;
    courseTitle: string;
    courseSummary: string | null;
    completedAt: string;
    instructor: string | null;
    certificateId: string;
  };
  printView: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const page = paperPixels(cfg.paperSize, cfg.orientation);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Fit the page to whatever width the column has, never enlarging past 1:1.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setScale(Math.min(1, el.clientWidth / page.w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [page.w]);

  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    // `cfg` is already normalised by the caller, so the preview shows exactly
    // what WOULD be stored, including any value the validator replaced.
    const html = renderCertificateHtml(cfg as SafeConfig, data, {
      forcePrint: printView,
    });
    doc.open();
    doc.write(html);
    doc.close();
  }, [cfg, data, printView]);

  return (
    <div ref={wrapRef} className="w-full">
      {/* maxWidth pins the box to the column even before the first
          ResizeObserver callback, when scale is still 1. Without it the page
          rendered at full A4 width and forced a horizontal scrollbar. */}
      <div
        className="rounded-xl border border-gray-300 bg-white overflow-hidden shadow-sm mx-auto"
        style={{ width: page.w * scale, height: page.h * scale, maxWidth: "100%" }}
      >
        <iframe
          ref={ref}
          title="Certificate preview"
          sandbox="allow-same-origin"
          className="border-0 origin-top-left"
          style={{ width: page.w, height: page.h, transform: `scale(${scale})` }}
        />
      </div>
      <p className="text-[11px] text-gray-400 text-center mt-2">
        {cfg.paperSize === "AUTO"
          ? "Shown at A4 proportions. On Automatic the real size follows the printer."
          : `${cfg.paperSize === "A4" ? "A4" : "US Letter"}, ${cfg.orientation === "LANDSCAPE" ? "landscape" : "portrait"} · ${Math.round(scale * 100)}%`}
      </p>
    </div>
  );
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

/**
 * Visual picker for the inner frame.
 *
 * Each swatch is drawn by borderFrameCss - the same function the certificate
 * itself uses - against its own class name and at a smaller scale, so a swatch
 * cannot advertise a frame the page then renders differently. The colours come
 * from the live draft, so changing the two colours restyles all 13 swatches.
 */
function BorderPicker({
  value,
  onChange,
  accent,
  second,
}: {
  value: BorderStyle;
  onChange: (v: BorderStyle) => void;
  accent: string;
  second: string;
}) {
  const css = useMemo(
    () =>
      BORDER_STYLES.map((k) =>
        borderFrameCss(k, accent, second, { selector: `.bsw-${k}`, scale: 0.42 }),
      ).join("\n"),
    [accent, second],
  );

  return (
    <div>
      <Label label="Inner frame" />
      <style>{css}</style>
      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
        {BORDER_STYLES.map((k) => {
          const selected = value === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onChange(k)}
              title={BORDER_LABELS[k]}
              aria-pressed={selected}
              className={`rounded-lg border p-1 transition-colors ${
                selected
                  ? "border-blue-500 ring-2 ring-blue-200 bg-blue-50/40"
                  : "border-gray-200 hover:border-gray-400"
              }`}
            >
              <span
                className={`bsw-${k} relative block w-full h-11 rounded bg-white border border-gray-100`}
              />
              <span className="block text-[9px] leading-tight text-gray-500 mt-1 truncate">
                {BORDER_LABELS[k]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "error" | "warn" | "info"; children: React.ReactNode }) {
  const styles = {
    ok: "bg-green-50 border-green-200 text-green-800",
    error: "bg-red-50 border-red-200 text-red-700",
    warn: "bg-amber-50 border-amber-200 text-amber-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  }[tone];
  const Icon = tone === "ok" ? CheckCircle2 : AlertCircle;
  return (
    <div className={`flex items-start gap-2 border rounded-lg px-4 py-2.5 mb-4 text-sm ${styles}`}>
      <Icon size={15} className="shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="font-semibold text-gray-900 mb-4">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Label({
  label,
  def,
  value,
  onRevert,
}: {
  label: string;
  def?: string;
  value?: string;
  onRevert?: () => void;
}) {
  const changed = def !== undefined && value !== undefined && value !== def;
  return (
    <div className="flex items-center justify-between mb-1.5">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {changed && onRevert && (
        <button
          type="button"
          onClick={onRevert}
          title="Put this one back to the original"
          className="text-gray-400 hover:text-gray-700 p-0.5 rounded"
        >
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  );
}

function Text({
  label, value, onChange, max, hint, textarea, def, onRevert,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  hint?: string;
  textarea?: boolean;
  def?: string;
  onRevert?: () => void;
}) {
  const cls =
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500";
  return (
    <div>
      <Label label={label} def={def} value={value} onRevert={onRevert} />
      {textarea ? (
        <textarea value={value} maxLength={max} rows={3} onChange={(e) => onChange(e.target.value)} className={cls} />
      ) : (
        <input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} className={cls} />
      )}
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function Color({
  label, value, onChange, def, onRevert,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  def: string;
  onRevert: () => void;
}) {
  return (
    <div>
      <Label label={label} def={def} value={value} onRevert={onRevert} />
      <div className="flex items-center gap-2">
        {/* <input type="color"> requires a lowercase #rrggbb; handed an
            uppercase value it falls back to #000000 and the swatch goes black
            while the hex field still reads correctly. */}
        <input
          type="color"
          value={value.toLowerCase()}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="w-9 h-9 rounded border border-gray-300 cursor-pointer bg-white p-0.5 shrink-0"
        />
        <input
          value={value}
          maxLength={7}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm font-mono uppercase focus:outline-none focus:border-blue-500"
        />
      </div>
    </div>
  );
}

function Select({
  label, value, onChange, options, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}) {
  return (
    <div>
      <Label label={label} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function Check({
  label, checked, onChange, hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      <span>
        <span className="block text-sm text-gray-800">{label}</span>
        {hint && <span className="block text-[11px] text-gray-400 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * Upload-only image field. There is no "paste a URL" input on purpose: a free
 * text URL would be an SSRF and tracking vector, and the saved value is pinned
 * to the Cloudinary delivery host anyway, so a pasted link would be silently
 * discarded.
 */
function ImageField({
  label, value, onChange, hint,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/upload", { method: "POST", body: fd });
      // A proxy error or a session timeout returns HTML, not JSON; parsing
      // first surfaced a raw SyntaxError to the admin.
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.error) {
        throw new Error(json?.error ?? `Upload failed (${res.status})`);
      }
      if (!safeImageUrl(json.url)) {
        throw new Error("That file uploaded but cannot be used here. Try a PNG or JPG.");
      }
      onChange(json.url);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Upload failed");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  return (
    <div>
      <Label label={label} />
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm border border-gray-300 bg-white hover:bg-gray-50 px-3 py-2 rounded-lg cursor-pointer transition-colors shrink-0">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {busy ? "Uploading…" : value ? "Replace" : "Choose image"}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/avif" className="hidden" onChange={upload} disabled={busy} />
        </label>
        {value && (
          <>
            <img src={value} alt="" className="h-9 max-w-[110px] object-contain rounded border border-gray-200 bg-white" />
            <button
              type="button"
              onClick={() => onChange(null)}
              title="Remove"
              className="text-gray-400 hover:text-red-600 p-1 rounded"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
      {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
      {hint && !err && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function ToggleBtn({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 transition-colors ${
        active ? "bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}
