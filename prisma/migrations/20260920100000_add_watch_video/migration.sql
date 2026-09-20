-- Admin-curated "Watch & Learn" videos for the student dashboard.
-- When no active row exists the dashboard falls back to the channel's
-- latest uploads (RSS), so this table starting empty is fine.
CREATE TABLE "WatchVideo" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchVideo_isActive_order_idx" ON "WatchVideo"("isActive", "order");
