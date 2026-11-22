ALTER TABLE "Conversation" ADD COLUMN "disappearingSeconds" INTEGER;
ALTER TABLE "Message" ADD COLUMN "kind" VARCHAR(24) NOT NULL DEFAULT 'text';
ALTER TABLE "Message" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "Message_expiresAt_idx" ON "Message"("expiresAt");

CREATE TABLE "StarredMessage" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StarredMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StarredMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StarredMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StarredMessage_messageId_userId_key" ON "StarredMessage"("messageId", "userId");
CREATE INDEX "StarredMessage_userId_createdAt_idx" ON "StarredMessage"("userId", "createdAt");

CREATE TABLE "ScheduledMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sendAt" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScheduledMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ScheduledMessage_status_sendAt_idx" ON "ScheduledMessage"("status", "sendAt");
CREATE INDEX "ScheduledMessage_conversationId_senderId_idx" ON "ScheduledMessage"("conversationId", "senderId");

CREATE TABLE "LiveLocationShare" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "stoppedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LiveLocationShare_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveLocationShare_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LiveLocationShare_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LiveLocationShare_conversationId_expiresAt_idx" ON "LiveLocationShare"("conversationId", "expiresAt");
CREATE INDEX "LiveLocationShare_senderId_stoppedAt_idx" ON "LiveLocationShare"("senderId", "stoppedAt");
