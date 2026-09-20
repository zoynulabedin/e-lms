import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
