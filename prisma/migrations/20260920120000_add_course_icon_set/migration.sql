-- Which module-icon set the course player sidebar uses ("market" | "money").
-- NULL keeps the generic lucide icons.
ALTER TABLE "Course" ADD COLUMN "iconSet" TEXT;
