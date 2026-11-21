/**
 * Upload size limits, shared by the /upload route and the admin forms that
 * call it, so the browser can refuse an oversized file before sending it.
 *
 * These must not be larger than what the Cloudinary plan accepts, or the file
 * passes our check and Cloudinary then rejects it. The Free plan's limits
 * (from `cloudinary.api.usage().media_limits`) are 10 MB for images and 10 MB
 * for raw files (PDF, Office, ZIP). After a plan upgrade, raise these to match.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export function formatLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
