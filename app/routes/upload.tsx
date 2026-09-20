import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import { uploadToCloudinary, type UploadKind } from "../utils/cloudinary.server";

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

const MAX_IMAGE = 10 * 1024 * 1024; // 10 MB
const MAX_DOCUMENT = 50 * 1024 * 1024; // 50 MB

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
    if (file.size > MAX_DOCUMENT) {
      return data({ error: "File too large. Maximum size is 50 MB." }, { status: 400 });
    }
    kind = "raw";
  } else {
    if (!IMAGE_TYPES.includes(file.type)) {
      return data(
        { error: "Invalid file type. Only JPEG, PNG, GIF, WebP, and AVIF are allowed." },
        { status: 400 },
      );
    }
    if (file.size > MAX_IMAGE) {
      return data({ error: "File too large. Maximum size is 10 MB." }, { status: 400 });
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
    return data(
      { error: "Upload failed. Check the CLOUDINARY_* settings and try again." },
      { status: 502 },
    );
  }
}
