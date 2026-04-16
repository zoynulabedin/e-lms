# Instructional Graphics LMS — Project Documentation

## Overview

A full-featured Learning Management System (LMS) built with React Router v7 (SSR), Node.js, Prisma ORM, and PostgreSQL. Deployed on Plesk hosting (Phusion Passenger + Nginx + Apache). Supports course management, student licensing, HLS video streaming, quizzes, progress tracking, certificates, and Shopify payment integration.

- **Frontend domain:** `lms.instructionalgraphics.org`
- **Video/content domain:** `courses.instructionalgraphics.org`
- **Stack:** React Router 7 · Vite · Prisma · PostgreSQL (Neon) · Tailwind CSS v4 · hls.js
- **Hosting:** Plesk (Phusion Passenger, Nginx reverse proxy → Apache)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Router 7.12.0 (SSR/fullstack) |
| Build tool | Vite 7.1.7 |
| Database ORM | Prisma 7.4.2 |
| Database | PostgreSQL via `@neondatabase/serverless` + `pg` |
| Styling | Tailwind CSS 4.1.13 |
| Video streaming | hls.js 1.6.15 |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) |
| Email | Resend API + Nodemailer fallback |
| Media storage | Cloudinary |
| Payments | Shopify Webhooks |
| PDF generation | `@react-pdf/renderer` |
| Icons | Lucide React |
| Runtime | Node.js 18+ (requires global `fetch`) |

---

## Directory Structure

```
instructionalgraphics/
├── app/
│   ├── components/        # Reusable UI components
│   ├── routes/            # All page and API routes (file-based routing)
│   ├── utils/             # Server-side utilities
│   └── root.tsx           # App shell, CSP headers, error boundary
├── prisma/
│   ├── schema.prisma      # Database schema
│   └── migrations/        # DB migration history
├── public/                # Static assets
├── scripts/               # Build/deploy helpers
├── build/                 # Production output (gitignored)
├── server.js              # Production server entry point
├── vite.config.ts         # Vite + React Router config
├── react-router.config.ts # React Router SSR config
├── prisma.config.ts       # Prisma config
├── .env                   # Environment variables (never commit)
├── .env.example           # Template for environment variables
├── Dockerfile             # Container build (optional)
└── PLESK_DEPLOYMENT.md    # Plesk-specific deployment notes
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values before running.

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` or `development` |
| `COOKIE_SECURE` | `true` in production (HTTPS-only cookies) |
| `APP_URL` | Full base URL, e.g. `https://lms.instructionalgraphics.org` |
| `DATABASE_URL` | PostgreSQL connection string (Neon or standard PG) |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `SESSION_SECRET` | Secret for session encryption |
| `RESEND_API_KEY` | Resend email service API key |
| `EMAIL_FROM` | Sender address, e.g. `noreply@instructionalgraphics.org` |
| `SHOPIFY_WEBHOOK_SECRET` | HMAC secret for verifying Shopify webhooks |
| `SHOPIFY_STORE_DOMAIN` | e.g. `your-store.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API access token |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

---

## NPM Scripts

```bash
npm run dev          # Start dev server (Vite HMR)
npm run build        # Production build → build/
npm run start        # Start production server
npm run typecheck    # TypeScript type validation
npm run migrate:dev  # Run Prisma migrations in development
npm run migrate:deploy  # Apply migrations in production
```

---

## Routes Reference

### Public Routes

| File | Path | Description |
|------|------|-------------|
| `home.tsx` | `/` | Public landing/marketing page |
| `catalog.tsx` | `/catalog` | Browsable course catalog |
| `redeem.tsx` | `/redeem` | License key redemption page |

### Auth Routes

| File | Path | Description |
|------|------|-------------|
| `auth.login.tsx` | `/auth/login` | Email + password login |
| `auth.register.tsx` | `/auth/register` | New account registration |
| `auth.logout.tsx` | `/auth/logout` | Clear session, redirect to login |
| `auth.forgot-password.tsx` | `/auth/forgot-password` | Request password reset email |
| `auth.reset-password.tsx` | `/auth/reset-password` | Reset with token from email |

### Student Routes

| File | Path | Description |
|------|------|-------------|
| `student.dashboard.tsx` | `/student/dashboard` | Enrolled courses grid |
| `student.course.$courseId.tsx` | `/student/course/:courseId` | Course player (lessons, videos, quizzes) |
| `certificate.$courseId.tsx` | `/certificate/:courseId` | Generate/download completion certificate |

### Admin Routes (protected, require ADMIN role)

| File | Path | Description |
|------|------|-------------|
| `layout.tsx` | `/` (admin layout) | Admin sidebar + navigation shell |
| `courses.tsx` | `/courses` | Course list with create/edit/delete |
| `courses.$courseId.tsx` | `/courses/:courseId` | Course editor (modules, lessons, quizzes) |
| `licenses.tsx` | `/licenses` | License key management + assignment |
| `users.tsx` | `/users` | User management (ban, suspend, roles) |
| `sessions.tsx` | `/sessions` | Device/session management |
| `settings.tsx` | `/settings` | System settings |
| `quiz-review.tsx` | `/quiz-review` | Review quiz attempts and grade essays |
| `reports.tsx` | `/reports` | Completion analytics and progress reports |
| `reports.export.tsx` | `/reports/export` | Export reports to PDF or CSV |
| `upload.tsx` | `/upload` | Upload course media to Cloudinary |

### API Routes (server-only loaders/actions)

| File | Path | Description |
|------|------|-------------|
| `api.video-proxy.ts` | `/api/video-proxy` | HLS video proxy — rewrites M3U8 playlists |
| `shopify.webhook.tsx` | `/shopify/webhook` | Shopify order webhook → auto-create license |

---

## Database Schema

### Enums

| Enum | Values |
|------|--------|
| `Role` | `ADMIN`, `STUDENT`, `CORPORATE` |
| `LicenseStatus` | `ACTIVE`, `PENDING`, `REVOKED` |
| `ContentType` | `STORYLINE`, `VIDEO` |
| `CourseType` | `FREE`, `PAID` |
| `CourseStatus` | `DRAFT`, `PUBLISHED` |
| `LessonType` | `VIDEO`, `STORYLINE`, `TEXT`, `DOWNLOAD` |
| `FeedbackMode` | `RETRY`, `REVEAL`, `DEFAULT` |

### Models

#### User
| Field | Type | Notes |
|-------|------|-------|
| id | String | UUID, PK |
| email | String | Unique |
| passwordHash | String | bcrypt hash |
| name | String | Display name |
| role | Role | `ADMIN`, `STUDENT`, `CORPORATE` |
| isBanned | Boolean | Account access blocked |
| isSuspended | Boolean | Temporary suspension |
| banReason | String? | Optional ban reason |
| maxDevices | Int | Max concurrent device sessions |
| createdAt / updatedAt | DateTime | Timestamps |

Relations: `licenses`, `progress`, `lessonProgress`, `enrollments`, `passwordResets`, `sessions`

#### Course
| Field | Type | Notes |
|-------|------|-------|
| id | String | UUID, PK |
| title / summary / description | String | Course metadata |
| category / instructor | String | Classification |
| courseType | CourseType | `FREE` or `PAID` |
| price | Float? | For PAID courses |
| shopifyProductId | String? | Links to Shopify product |
| status | CourseStatus | `DRAFT` or `PUBLISHED` |
| contentType | ContentType | `STORYLINE` or `VIDEO` |
| embedUrl | String? | Articulate Storyline embed URL |
| videoUrl | String? | Direct video or HLS `.m3u8` URL |
| introVideoUrl | String? | Course intro video |
| thumbnailUrl | String? | Course thumbnail image |
| isPublic | Boolean | Visible in catalog |
| difficulty | String? | e.g. Beginner, Intermediate |
| isQA | Boolean | QA/review mode flag |
| whatYouLearn / targetAudience / materialsIncluded / requirements | String[] | Course details arrays |

Relations: `licenses`, `progress`, `enrollments`, `modules`

#### Module
| Field | Type | Notes |
|-------|------|-------|
| id | String | UUID, PK |
| courseId | String | FK → Course |
| title / summary | String | Module info |
| order | Int | Display order |

Relations: `course`, `lessons`, `quizzes`

#### Lesson
| Field | Type | Notes |
|-------|------|-------|
| id | String | UUID, PK |
| moduleId | String | FK → Module |
| title | String | Lesson name |
| lessonType | LessonType | `VIDEO`, `STORYLINE`, `TEXT`, `DOWNLOAD` |
| order | Int | Display order |
| content | String? | HTML/text content |
| videoUrl | String? | Video or HLS URL |
| embedUrl | String? | Storyline embed URL |
| resourceUrl | String? | Download file URL |
| thumbnailUrl | String? | Lesson thumbnail |
| duration | Int? | Duration in seconds |

#### Quiz
| Field | Type | Notes |
|-------|------|-------|
| id | String | UUID, PK |
| moduleId | String | FK → Module |
| title / summary | String | Quiz info |
| timeLimit | Int? | Seconds, null = no limit |
| feedbackMode | FeedbackMode | Answer feedback mode |
| attemptsAllowed | Int | How many times student can attempt |
| passingGrade | Int | % score to pass |
| maxQuestionsAllowed | Int | Questions shown per attempt |
| autoStart | Boolean | Skip intro screen |

#### Question & Answer
- `Question`: belongs to Quiz, has type (`MULTIPLE_CHOICE`, `SHORT_ANSWER`, `ESSAY`, etc.), points value, ordering
- `Answer`: belongs to Question, text + `isCorrect`, optional image/video, `matchText` for matching questions

#### Enrollment
Free course access record linking `userId` → `courseId`.

#### License
| Field | Type | Notes |
|-------|------|-------|
| id / key | String | UUID PK + unique license key |
| status | LicenseStatus | `ACTIVE`, `PENDING`, `REVOKED` |
| customerEmail | String | Purchaser's email |
| courseId | String | FK → Course |
| userId | String? | Set when redeemed |
| shopifyOrderId | String? | From Shopify webhook |
| isBulk | Boolean | Bulk/corporate license |
| redeemedAt | DateTime? | When student redeemed |

#### Progress
Per-user per-course: `completionPercent`, `isCompleted`, `certificateUrl`, `lastAccessedAt`

#### LessonProgress
Per-user per-lesson: `isCompleted`, `completedAt`

#### QuizAttempt / QuizAttemptAnswer
Full quiz attempt records with per-answer scoring, manual grading support (`manualScore`, `gradedAt`, `gradedBy`)

#### UserSession
Device session tracking: `deviceId`, `ipAddress`, `userAgent`, `isActive`, `lastActiveAt`, `expiresAt`

---

## Key Components

### `app/components/HlsPlayer.tsx`

SSR-safe HLS video player.

- Uses dynamic import of `hls.js` (browser-only, not bundled for SSR)
- Falls back to native `<video>` HLS for Safari
- Quality selector dropdown (auto + manual levels)
- Error recovery with automatic retry
- Buffering state with loading indicator
- `enableWorker: false` for CSP compliance (no Web Workers)
- `crossOrigin` attribute intentionally omitted (credentials not sent)

**Usage:**
```tsx
<HlsPlayer src="https://courses.instructionalgraphics.org/.../stream_0.m3u8" />
```

### `app/components/Toast.tsx`

Toast notification component for success/error messages.

---

## Server Utilities (`app/utils/`)

| File | Exports | Purpose |
|------|---------|---------|
| `auth.server.ts` | `requireUser`, `getSession`, `createSession`, `hashPassword`, `verifyPassword` | JWT auth + session management |
| `db.server.ts` | `db` | Prisma client singleton |
| `email.server.ts` | `sendEmail` | Send email via Resend API |
| `shopify.server.ts` | `verifyShopifyWebhook` | HMAC verification for Shopify events |
| `cloudinary.server.ts` | `uploadToCloudinary` | Image/video upload |

---

## Video System

### How Videos Work

1. Admin sets a `videoUrl` on a Course or Lesson (can be YouTube, Vimeo, Wistia, HLS `.m3u8`, or direct MP4)
2. `resolveVideoEmbed(url)` in `student.course.$courseId.tsx` detects the video type:

```typescript
function resolveVideoEmbed(raw: string) {
  if (getYouTubeId(raw))  return { type: "youtube", src: `https://youtube.com/embed/...` };
  if (getVimeoId(raw))    return { type: "vimeo",   src: `https://player.vimeo.com/video/...` };
  if (raw.includes("wistia.com")) return { type: "iframe", src: ... };
  if (raw.includes(".m3u8"))      return { type: "hls",    src: raw };
  return { type: "direct", src: raw };
}
```

3. HLS videos render using `<HlsPlayer src={src} />` which loads hls.js in-browser

### HLS + CORS

Videos hosted on `courses.instructionalgraphics.org` require CORS headers to play in Chrome/Firefox when loaded from `lms.instructionalgraphics.org`.

**Required Nginx headers** (add to `courses.instructionalgraphics.org` Additional Directives in Plesk):

```nginx
location ~* \.(m3u8|ts|key)$ {
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS, HEAD' always;
    add_header 'Access-Control-Allow-Headers' 'Range, Content-Type' always;
    add_header 'Access-Control-Expose-Headers' 'Content-Length, Content-Range' always;
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '*';
        add_header 'Access-Control-Max-Age' 1728000;
        add_header 'Content-Type' 'text/plain charset=UTF-8';
        add_header 'Content-Length' 0;
        return 204;
    }
}
```

**Video proxy route** (`/api/video-proxy`) exists as fallback — rewrites `.m3u8` segment URLs to route through the LMS server, bypassing CORS. Currently not in use (raw URL mode active).

---

## Content Security Policy

Defined in `app/root.tsx` `headers()` export:

```
default-src 'self';
script-src  'self' 'unsafe-inline' 'unsafe-eval' https:;
style-src   'self' 'unsafe-inline' https:;
img-src     'self' data: blob: https:;
media-src   'self' blob: https:;
connect-src 'self' https:;
font-src    'self' https: data:;
frame-src   'self' https:;
```

`'unsafe-eval'` is required for hls.js to function. `frame-src https:` allows Articulate Storyline embeds.

---

## Authentication

- **Method:** JWT stored in HTTP-only cookies
- **Session tracking:** `UserSession` model stores device ID, IP, user agent — supports `maxDevices` limit per user
- **Password reset:** Token-based, stored in `PasswordReset` model with expiry
- **Roles:** `ADMIN` (full access), `STUDENT` (own courses only), `CORPORATE` (bulk license holder)
- **Cookie:** `Secure` flag controlled by `COOKIE_SECURE` env var (set `true` in production)

---

## Shopify Integration

Shopify sends a POST to `/shopify/webhook` on order completion.

Flow:
1. Webhook received → HMAC verified with `SHOPIFY_WEBHOOK_SECRET`
2. Parse order: extract `shopifyProductId`, customer email
3. Find matching Course by `shopifyProductId`
4. Create a `License` record with status `ACTIVE`
5. Student redeems via `/redeem` with their license key → enrolled in course

---

## Production Deployment (Plesk)

### Server Entry Point

```javascript
// server.js
import 'dotenv/config';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.argv = [process.argv[0], process.argv[1], './build/server/index.js'];
import('./node_modules/@react-router/serve/dist/cli.js');
```

Uses `@react-router/serve` CLI. Phusion Passenger runs `server.js` as the Node.js app entry.

### Deploy Steps

1. Run `npm run build` locally
2. Upload `build/` folder to Plesk (FTP or file manager)
3. Restart app in Plesk → Node.js panel → "Restart"
4. Check app logs in Plesk if there are errors

### Passenger Architecture

```
Browser → Nginx (reverse proxy) → Apache → Phusion Passenger → Node.js (server.js)
```

Static files may be served directly by Nginx, bypassing Apache + Passenger. This affects where CORS headers must be set — Nginx location blocks, not `.htaccess`.

---

## Known Issues / Active Work

| Issue | Status | Notes |
|-------|--------|-------|
| HLS CORS in Chrome/Firefox | **Active** | Videos on `courses.instructionalgraphics.org` blocked by CORS. Nginx CORS headers being configured. |
| Video proxy 500 errors | Dormant | Proxy route exists at `/api/video-proxy` but raw URL mode is active. |
| Safari login | Fixed | `COOKIE_SECURE` + SameSite cookie config resolved |
| License role badge | Fixed | CORPORATE role showing Admin — resolved |
| CSP blocking hls.js | Fixed | Added `'unsafe-eval'` to script-src |

---

## Development Setup

```bash
# 1. Clone and install
git clone <repo>
cd instructionalgraphics
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, JWT_SECRET, etc.

# 3. Set up database
npm run migrate:dev

# 4. Start dev server
npm run dev
# → http://localhost:5173
```

---

## Project Dependencies Summary

### Production
- `react` / `react-dom` 19.2.4
- `react-router` 7.12.0 + `@react-router/serve`, `@react-router/node`, `@react-router/express`
- `@prisma/client` 7.4.2 + `@prisma/adapter-neon`, `@prisma/adapter-pg`
- `@neondatabase/serverless` + `pg` 8.20.0
- `express` 4.22.1
- `hls.js` 1.6.15
- `bcryptjs` 3.0.3
- `jsonwebtoken` 9.0.3
- `cloudinary` 2.9.0
- `nodemailer` 8.0.3 + `resend` 6.9.4
- `@react-pdf/renderer` 4.3.2
- `lucide-react` 0.576.0
- `uuid` 13.0.0
- `dotenv` 17.3.1

### Dev
- `vite` 7.1.7
- `typescript` 5.9.2
- `@tailwindcss/vite` + `tailwindcss` 4.1.13
- `prisma` 7.4.2
- `vite-tsconfig-paths`
