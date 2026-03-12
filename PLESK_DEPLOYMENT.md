# Deploying React Router (Remix) v7 to Plesk

This guide explains how to deploy this React Router v7 application to a Plesk server using the Plesk Node.js extension (Phusion Passenger).

## Prerequisites
- A Plesk hosting account with the Node.js extension enabled.
- The project files pushed to your server (via Git, FTP, or File Manager).
- Database credentials ready.

## 1. Project Preparation

Ensure the following key files and directories are present in the project root on your remote server:
- `server.js` (The custom application entry point created specifically for Plesk Passenger)
- `package.json` & `package-lock.json`
- `prisma/` folder
- `public/` folder
- **Crucial:** The `build/` folder. You must run `npm run build` locally and upload the resulting `build` folder to the server, or run the build command on the server via SSH if it has sufficient memory.

## 2. Plesk Node.js Configuration

Navigate to **Websites & Domains** > **Your Domain** > **Node.js** in Plesk and configure the settings exactly as follows:

1. **Node.js Version:** `22.x` or `23.x` (Matching your local development environment)
2. **Package Manager:** `npm`
3. **Application Mode:** `production`
4. **Document Root:** `/lms.instructionalgraphics.org/build/client` (or your domain's folder path)
   *Important: This tells Plesk (Nginx/Apache) to serve static assets directly for better performance.*
5. **Application Root:** `/lms.instructionalgraphics.org` 
   *Important: Point this to the root of the project, NOT the `/build` folder.*
6. **Application Startup File:** `server.js`
   *Note: We use this custom file because Plesk requires a standalone script and doesn't allow passing CLI arguments to `node_modules` binaries.*

## 3. Environment Variables

Under the **Custom environment variables** section on the Plesk Node.js page, make sure you configure ALL variables found in your `.env.example` file. 

Crucial variables include:
- `NODE_ENV`: `production`
- `APP_URL`: Your actual live URL (e.g., `https://lms.instructionalgraphics.org`)
- `DATABASE_URL`: Your production database URL 
- `SESSION_SECRET`: A secure, random string
- All other API keys (Resend, Cloudinary, Shopify, etc.)

## 4. Install Dependencies

1. Once your files are uploaded, click the **NPM Install** button on the Plesk Node.js page.
2. Wait for it to complete. This will generate the `node_modules` directory on the server.

*Tip: If the web-based `NPM Install` times out or fails, SSH into your server, navigate to your app root, and run `npm ci --omit=dev`.*

## 5. Database Setup (Prisma)

You must run Prisma migrations to prepare the database before the app starts:

1. Open the **SSH Terminal** in Plesk (or connect via your own terminal).
2. Navigate to your application root directory:
   ```bash
   cd /var/www/vhosts/instructionalgraphics.org/lms.instructionalgraphics.org
   ```
3. Generate the Prisma client and run migrations:
   ```bash
   npx prisma generate
   npx prisma migrate deploy
   ```

## 6. Start the Server

1. Return to the Node.js settings page in Plesk.
2. Click the **Restart App** button at the top.
3. Open your application URL in a web browser to verify it's online.

---

## Updating the App in the Future

When you push new code to production, follow these steps:
1. Pull the latest code to Plesk (via Git extension or manual upload).
2. If `package.json` changed, click **NPM Install**.
3. If `schema.prisma` changed, run `npx prisma migrate deploy` via SSH.
4. **Crucial:** Build the application assets (either locally and upload the new `build/` folder, or run `npm run build` on the server).
5. Click **Restart App** in the Plesk Node.js interface to load the new server code.
