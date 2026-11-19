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
4. **Document Root:** `/lms.instructionalgraphics.org/build/client`
   *Serves built assets directly and keeps the source out of the web root.
   §2a below adds the one nginx rule this needs.*
5. **Application Root:** `/lms.instructionalgraphics.org` 
   *Important: Point this to the root of the project, NOT the `/build` folder.*
6. **Application Startup File:** `server.js`
   *Note: We use this custom file because Plesk requires a standalone script and doesn't allow passing CLI arguments to `node_modules` binaries.*

### 2a. `.data` requests — required, or the app 500s

React Router fetches page data for in-app navigation from URLs ending in
`.data`:

```
/student.data
/student/course/<id>.data
```

With the Document Root set to `build/client`, the web server looks for those
files on disk, does not find them, and answers **500** without ever reaching
Node:

```
Unable to find the file .../build/client/student.data at the specified location
```

The first page load works (that is a normal document request); every click
inside the app fails. Fix it in Plesk — **the app cannot fix this itself.**

#### If "Additional nginx directives" is missing from the page

That field only appears when the subscription's service plan allows custom
directives. As the Plesk admin: **Service Plans → (the plan) → Permissions →
"Ability to manage additional nginx directives"** (and the Apache equivalent),
apply it to the subscription, then reload the Apache & nginx Settings page.

If you cannot enable it, the repo ships two `.htaccess` files that do the same
job through Apache — nothing to paste anywhere:

| File | Used when |
| --- | --- |
| `public/.htaccess` → `build/client/.htaccess` | Document Root = `build/client` (current setup) |
| `.htaccess` (project root) | Document Root = application root |

They set `DirectorySlash Off`, turn Passenger on for the folder, and let
requests that are not real files fall through to Node. They need
`AllowOverride` to be enabled for the domain (Plesk default). Re-upload
`build/` after building so `build/client/.htaccess` is present.

#### Recommended: send `.data` to the app

Plesk → *Websites & Domains* → your domain → *Apache & nginx Settings*:

1. Under **Serve static files directly by nginx**, make sure `data` is **not**
   in the extension list.
2. Add to **Additional nginx directives**:

```nginx
# React Router data requests are API calls, never static files
location ~ \.data$ {
    proxy_pass http://127.0.0.1:7080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`7080` is Plesk's default Apache backend port. If the domain runs nginx +
Passenger without Apache, replace the body with `passenger_enabled on;`.

3. Restart the app.

Keep the Document Root on `build/client` — it contains only built assets, so
nothing private is exposed.

#### ⚠️ Never create a folder in `public/` named after a route

`public/student/` would become `build/client/student/`, and Apache then treats
`/student` as a static directory: it redirects to `/student/`, finds no
`index.html`, and returns 500 — the whole dashboard breaks. This happened once;
that is why there are no such folders in `public/`.

#### Alternative: Document Root = application root

Setting the Document Root to `/lms.instructionalgraphics.org` also makes every
request reach Node (nothing in the project root matches an app URL), but it
**publishes the whole project folder over HTTP** — `/package.json`,
`/prisma/schema.prisma`, `/app/utils/auth.server.ts`, possibly `/.env`. Only
use this if you also add deny rules:

```nginx
location ~ ^/(app|prisma|scripts|node_modules|build/server)/ { deny all; }
location ~ ^/(package(-lock)?\.json|tsconfig\.json|.*\.ts|.*\.tsx)$ { deny all; }
location ~ /\. { deny all; }
```

The nginx `.data` rule above is simpler and safer.

## 3. Environment Variables

Under the **Custom environment variables** section on the Plesk Node.js page, make sure you configure ALL variables found in your `.env.example` file. 

Crucial variables include:
- `NODE_ENV`: `production`
- `APP_URL`: Your actual live URL (e.g., `https://lms.instructionalgraphics.org`)
- `DATABASE_URL`: Your production database URL 
- `JWT_SECRET`: A secure, random string (≥ 16 chars — the app refuses to start in production without it)
- `TRUST_PROXY`: `true` — exactly that lowercase word (Plesk's nginx/Apache sit in front of Node). It enables per-IP rate limiting on login/register/redeem, the real client IP on the Sessions page and same-device-first sign-out. `1`, `TRUE` or `yes` are ignored; with more than one proxy in front use `TRUST_PROXY_HOPS=<n>` instead. When it is missing or not understood the app logs `[rate-limit] TRUST_PROXY ...` once per start — on the first sign-in / register / redeem request, not at boot — and `npm run doctor` reports it any time.
- `ADMIN_EMAIL`: where Shopify order, refund and cancellation notifications go
- `SUPPORT_EMAIL` (optional): Reply-To on learner emails; defaults to `info@instructionalgraphics.org`
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
   npm run migrate:prod
   ```
   `migrate:prod` (= `node scripts/migrate.mjs`) first baselines a database that was
   historically synced with `prisma db push`, then runs `prisma migrate deploy`.
   It is safe to run on every deploy; it never drops tables or columns.

## 6. Start the Server

1. Return to the Node.js settings page in Plesk.
2. Click the **Restart App** button at the top.
3. Open your application URL in a web browser to verify it's online.

---

## After any schema change: regenerate the Prisma client

`prisma migrate deploy` changes the **database**. The **generated client** in
`node_modules/@prisma/client` is a separate artefact that only knows the models
present when `prisma generate` last ran — and Prisma 7 removed the postinstall
hook that used to regenerate it automatically.

If the client is older than the schema, `prisma.newModel` is `undefined` and
`undefined.findMany()` throws a synchronous `TypeError` that no `.catch()` can
intercept. The page returns a plain 500 with no Prisma error code, which makes
it look like an application bug rather than a deploy step that was missed.

This is now handled for you in two places, so a normal deploy cannot miss it:

* `npm run build` runs `prisma generate` first.
* `scripts/migrate.mjs` (run by `server.js` on every **Restart App**, and by
  `npm run migrate:prod`) runs `prisma generate` before `migrate deploy`.

To check a server at any time:

```bash
npm run doctor
```

It reports `✗ model "x" MISSING from the generated client` when the client is
stale, alongside the migration and schema checks.

## Shopify webhooks (licences)

Register the **same URL** — `https://lms.instructionalgraphics.org/shopify/webhook`, format **JSON** — for three events in Shopify admin → Settings → Notifications → Webhooks:

| Event | What the app does |
|---|---|
| `orders/paid` (Order payment) | Mints one key per seat and sends the buyer ONE email with all keys |
| `refunds/create` (Refund create) | Revokes the keys of the refunded seats and emails `ADMIN_EMAIL` |
| `orders/cancelled` (Order cancellation) | Revokes every key of the order and emails `ADMIN_EMAIL` |

All three are signed with the store's webhook secret shown on that page (`SHOPIFY_WEBHOOK_SECRET`). A revoked key can be restored from the License Keys page. Before 2026-11 only `orders/paid` was used — add the other two once, **after** the new build is running (Restart App done, `npm run doctor` clean): the old build answers those topics with 200 "ignored", and Shopify never re-sends a delivery that got a 2xx.

A refund that returns the course items in full revokes their keys. A *partial-amount* refund (items ticked, but less money returned than they cost — e.g. a goodwill refund) revokes nothing; the admin email says so, and the key can be revoked by hand.

Each course is matched by variant SKU = the course ID, or by the numeric Shopify product ID set in the course builder (FREE or PAID). `npm run doctor` warns about product IDs that are duplicated or not numeric.

## Licence migration of 2026-11

`prisma/migrations/20261119120000_license_line_items_refunds` adds nullable columns to `License` (`shopifyLineItemId`, `amountPaid`, `revokedAt`, `revokedReason`) and `ShopifyOrder` (`cancelledAt`), and the `ShopifyRefund` table. It is applied automatically by **Restart App** (`server.js` → `scripts/migrate.mjs`). Check with `npm run doctor` afterwards — the licence pages, the dashboard and the Shopify webhook need these columns.

## Updating the App in the Future

When you push new code to production, follow these steps:
1. Pull the latest code to Plesk (via Git extension or manual upload).
2. If `package.json` changed, click **NPM Install**.
3. If `schema.prisma` changed, run `npm run migrate:prod` via SSH — it
   regenerates the Prisma client and applies migrations. **Pages that use new
   models/columns 500 until this is done.**
4. **Crucial:** Build the application assets (either locally and upload the new `build/` folder, or run `npm run build` on the server).
5. Click **Restart App** in the Plesk Node.js interface to load the new server code.
