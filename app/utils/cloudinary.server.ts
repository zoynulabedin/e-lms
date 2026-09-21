import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * A URL this server can actually fetch for a stored Cloudinary asset.
 *
 * Accounts can have plain delivery switched off - "restricted media delivery"
 * - and then the secure_url that `upload` hands back answers 401 to everyone,
 * including the server that uploaded it. Signed delivery URLs are refused too.
 * The one form such an account still serves is Cloudinary's authenticated
 * download URL, which carries the API key and an expiring signature.
 *
 * Generating it needs the public_id and resource type, which are not stored
 * anywhere, so they are read back out of the URL:
 *   https://res.cloudinary.com/<cloud>/<type>/upload/v<version>/<public_id>[.<ext>]
 * `raw` keeps the extension inside the public_id (uploadToCloudinary puts it
 * there on purpose); `image` and `video` do not.
 *
 * Returns null for anything that is not one of our Cloudinary uploads, so the
 * caller can fall back to the stored URL unchanged.
 */
export function cloudinaryFetchUrl(storedUrl: string, ttlSeconds = 300): string | null {
  const m = storedUrl.match(
    /^https:\/\/res\.cloudinary\.com\/[^/]+\/(image|raw|video)\/upload\/(?:v\d+\/)?(.+)$/,
  );
  if (!m) return null;
  const resourceType = m[1] as "image" | "raw" | "video";
  const rest = m[2];
  if (rest.includes("..")) return null;

  let publicId = rest;
  let format = "";
  if (resourceType !== "raw") {
    const dot = rest.lastIndexOf(".");
    if (dot > 0) {
      publicId = rest.slice(0, dot);
      format = rest.slice(dot + 1);
    }
  }

  try {
    return cloudinary.utils.private_download_url(publicId, format, {
      resource_type: resourceType,
      type: "upload",
      // Short-lived on purpose: if the link is ever passed on it stops working
      // within minutes, which keeps the licence check meaningful.
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  } catch {
    return null;
  }
}

export type UploadKind = "image" | "raw";

export type UploadResult = {
  url: string;
  publicId: string;
  bytes: number;
  format?: string;
};

/**
 * Uploads a buffer to Cloudinary and returns the delivery URL.
 *
 * `kind: "raw"` is used for documents (PDF, DOCX, ZIP …) — Cloudinary stores
 * those under the `raw` resource type. Images keep `image` so the usual
 * transformations still work.
 *
 * The public_id is always random: deriving it from the user's filename made
 * two uploads called "worksheet.pdf" overwrite each other.
 */
export async function uploadToCloudinary(
  buffer: Buffer,
  filename: string,
  opts: { folder?: string; kind?: UploadKind } = {},
): Promise<UploadResult> {
  const { folder = "instructionalgraphics", kind = "image" } = opts;
  const ext = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  const base =
    filename
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .slice(0, 60) || "upload";
  // Raw files keep their extension in the public_id, otherwise Cloudinary
  // serves them without one and browsers guess the type.
  const publicId = `${base}-${randomUUID().slice(0, 8)}${kind === "raw" && ext ? "." + ext : ""}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, overwrite: false, resource_type: kind },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error("Upload failed"));
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes ?? buffer.byteLength,
          format: result.format,
        });
      },
    );
    stream.end(buffer);
  });
}
