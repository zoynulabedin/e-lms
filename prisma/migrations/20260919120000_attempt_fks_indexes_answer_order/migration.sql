-- AlterTable
ALTER TABLE "Answer" ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "QuizAttemptAnswer" ALTER COLUMN "questionId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");

-- CreateIndex
CREATE INDEX "UserSession_userId_isActive_idx" ON "UserSession"("userId", "isActive");

-- CreateIndex
CREATE INDEX "Module_courseId_idx" ON "Module"("courseId");

-- CreateIndex
CREATE INDEX "Lesson_moduleId_idx" ON "Lesson"("moduleId");

-- CreateIndex
CREATE INDEX "Quiz_moduleId_idx" ON "Quiz"("moduleId");

-- CreateIndex
CREATE INDEX "Question_quizId_idx" ON "Question"("quizId");

-- CreateIndex
CREATE INDEX "Answer_questionId_idx" ON "Answer"("questionId");

-- CreateIndex
CREATE INDEX "License_userId_courseId_status_idx" ON "License"("userId", "courseId", "status");

-- CreateIndex
CREATE INDEX "License_courseId_idx" ON "License"("courseId");

-- CreateIndex
CREATE INDEX "License_shopifyOrderId_idx" ON "License"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "QuizAttempt_quizId_idx" ON "QuizAttempt"("quizId");

-- Clean up rows that would violate the new foreign keys. Until now these
-- tables had no FKs, so deleting a quiz/question/user left orphans behind.
DELETE FROM "QuizAttempt" WHERE "userId" NOT IN (SELECT id FROM "User");
DELETE FROM "QuizAttempt" WHERE "quizId" NOT IN (SELECT id FROM "Quiz");
DELETE FROM "QuizAttemptAnswer" WHERE "attemptId" NOT IN (SELECT id FROM "QuizAttempt");
UPDATE "QuizAttemptAnswer" SET "questionId" = NULL
  WHERE "questionId" IS NOT NULL AND "questionId" NOT IN (SELECT id FROM "Question");

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttemptAnswer" ADD CONSTRAINT "QuizAttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizAttemptAnswer" ADD CONSTRAINT "QuizAttemptAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The catalog now honours Course.isPublic. Everything that is published today
-- stays listed; admins can un-list individual courses from the builder.
UPDATE "Course" SET "isPublic" = true; -- the toggle had no effect before, so no course was intentionally un-listed
ALTER TABLE "Course" ALTER COLUMN "isPublic" SET DEFAULT true;

-- Shopify webhook idempotency ledger
CREATE TABLE "ShopifyOrder" (
    "orderId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopifyOrder_pkey" PRIMARY KEY ("orderId")
);
-- Orders that already produced licences count as processed.
INSERT INTO "ShopifyOrder" ("orderId")
  SELECT DISTINCT "shopifyOrderId" FROM "License" WHERE "shopifyOrderId" IS NOT NULL
  ON CONFLICT DO NOTHING;
