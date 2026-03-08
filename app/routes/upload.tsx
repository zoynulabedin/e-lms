import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { requireAdmin } from "../utils/auth.server";
import { uploadToCloudinary } from "../utils/cloudinary.server";

export async function action({ request }: ActionFunctionArgs) {
  await requireAdmin(request);

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) {
    return data({ error: "No file provided." }, { status: 400 });
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
  if (!allowedTypes.includes(file.type)) {
    return data({ error: "Invalid file type. Only JPEG, PNG, GIF, WebP, and AVIF are allowed." }, { status: 400 });
  }

  const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_SIZE) {
    return data({ error: "File too large. Maximum size is 10 MB." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const url = await uploadToCloudinary(buffer, file.name);

  return data({ url });
}
