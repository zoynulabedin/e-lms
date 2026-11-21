import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import { uploadToCloudinary, type UploadKind } from "../utils/cloudinary.server";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES, formatLimit } from "../utils/upload-limits";

/**
 * Admin file upload. Two modes, chosen with the `kind` field:
 *   image (default) — course/lesson thumbnails and answer images
 *   document        — course resources: PDF, Office files, archives
 */

const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
];

const DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
  "application/rtf",
];

// Some browsers send an empty or generic type; fall back to the extension.
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rtf)$/i;

/**
 * Turns a Cloudinary upload error into something the admin can act on.
 * This route is admin-only, so passing Cloudinary's own wording through is
 * safe, and it is far more useful than a generic "check your settings" when
 * the real cause is a plan limit or a file Cloudinary cannot read.
 */
function describeUploadError(e: unknown): { status: number; error: string } {
  const err = e as { message?: string; http_code?: number } | undefined;
  const message = String(err?.message ?? "").trim();
  const code = err?.http_code;

  if (/file size too large/i.test(message)) {
    // e.g. "File size too large. Got 11534345. Maximum is 10485760."
    const max = Number(message.match(/maximum is (\d+)/i)?.[1]);
    const limit = Number.isFinite(max) && max > 0 ? ` (${formatLimit(max)})` : "";
    return {
      status: 413,
      error:
        `File too large for the Cloudinary plan${limit}. ` +
        "Compress it, split it, or add it as an External link.",
    };
  }
  if (
    code === 401 ||
    /api_key|api key|signature|cloud_name|cloud name/i.test(message)
  ) {
    return {
      status: 502,
      error: `Cloudinary rejected the credentials (${message || "unauthorised"}). Check the CLOUDINARY_* settings.`,
    };
  }
  return {
    status: 502,
    error: message ? `Upload failed: ${message}` : "Upload failed. Please try again.",
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const wantsDocument = String(formData.get("kind") || "") === "document";

  if (!file || file.size === 0) {
    return data({ error: "No file provided." }, { status: 400 });
  }

  let kind: UploadKind;
  if (wantsDocument) {
    const allowed =
      DOCUMENT_TYPES.includes(file.type) || DOCUMENT_EXTENSIONS.test(file.name);
    if (!allowed) {
      return data(
        { error: "Unsupported file type. Allowed: PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP." },
        { status: 400 },
      );
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return data(
        { error: `File too large. Maximum size is ${formatLimit(MAX_DOCUMENT_BYTES)}.` },
        { status: 413 },
      );
    }
    kind = "raw";
  } else {
    if (!IMAGE_TYPES.includes(file.type)) {
      return data(
        { error: "Invalid file type. Only JPEG, PNG, GIF, WebP, and AVIF are allowed." },
        { status: 400 },
      );
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return data(
        { error: `File too large. Maximum size is ${formatLimit(MAX_IMAGE_BYTES)}.` },
        { status: 413 },
      );
    }
    kind = "image";
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await uploadToCloudinary(buffer, file.name, {
      kind,
      folder: kind === "raw" ? "instructionalgraphics/resources" : "instructionalgraphics",
    });
    return data({
      url: result.url,
      fileName: file.name,
      fileType: file.type || null,
      fileSize: result.bytes,
    });
  } catch (e) {
    console.error("[upload] Cloudinary upload failed:", e);
    const { status, error } = describeUploadError(e);
    return data({ error }, { status });
  }
}
