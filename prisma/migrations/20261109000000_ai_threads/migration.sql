CREATE TABLE "AiThread" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL DEFAULT 'New conversation',
  "feature" VARCHAR(20) NOT NULL DEFAULT 'chat',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiThread_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AiMessage" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "role" VARCHAR(20) NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiThread_userId_updatedAt_idx" ON "AiThread"("userId", "updatedAt");
CREATE INDEX "AiMessage_threadId_createdAt_idx" ON "AiMessage"("threadId", "createdAt");
ALTER TABLE "AiThread" ADD CONSTRAINT "AiThread_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "AiThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
