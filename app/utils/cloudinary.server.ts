import { v2 as cloudinary } from "cloudinary";
import { randomUUID } from "crypto";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function uploadToCloudinary(
  buffer: Buffer,
  filename: string,
  folder = "instructionalgraphics"
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never derive public_id from the user's filename: two uploads called
    // "thumbnail.png" would silently replace each other in Cloudinary.
    const base = filename
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .slice(0, 60) || "upload";
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: `${base}-${randomUUID().slice(0, 8)}`, overwrite: false, resource_type: "image" },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error("Upload failed"));
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}
