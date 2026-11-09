CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500),
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpaceMember" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpaceMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpaceInvite" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "invitedUserId" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpaceInvite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpaceActivity" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" VARCHAR(40) NOT NULL,
    "detail" VARCHAR(255),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpaceActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpaceDocument" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpaceDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SpaceMember_spaceId_userId_key" ON "SpaceMember"("spaceId", "userId");
CREATE INDEX "Space_createdById_idx" ON "Space"("createdById");
CREATE INDEX "Space_visibility_idx" ON "Space"("visibility");
CREATE INDEX "Space_updatedAt_idx" ON "Space"("updatedAt");
CREATE INDEX "SpaceMember_spaceId_idx" ON "SpaceMember"("spaceId");
CREATE INDEX "SpaceMember_userId_idx" ON "SpaceMember"("userId");
CREATE UNIQUE INDEX "SpaceInvite_spaceId_invitedUserId_key" ON "SpaceInvite"("spaceId", "invitedUserId");
CREATE INDEX "SpaceInvite_invitedUserId_status_idx" ON "SpaceInvite"("invitedUserId", "status");
CREATE INDEX "SpaceInvite_spaceId_status_idx" ON "SpaceInvite"("spaceId", "status");
CREATE INDEX "SpaceActivity_spaceId_createdAt_idx" ON "SpaceActivity"("spaceId", "createdAt");
CREATE INDEX "SpaceActivity_actorId_idx" ON "SpaceActivity"("actorId");
CREATE INDEX "SpaceDocument_spaceId_updatedAt_idx" ON "SpaceDocument"("spaceId", "updatedAt");
CREATE INDEX "SpaceDocument_createdById_idx" ON "SpaceDocument"("createdById");
CREATE INDEX "SpaceDocument_updatedById_idx" ON "SpaceDocument"("updatedById");

ALTER TABLE "Space" ADD CONSTRAINT "Space_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceInvite" ADD CONSTRAINT "SpaceInvite_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceInvite" ADD CONSTRAINT "SpaceInvite_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceInvite" ADD CONSTRAINT "SpaceInvite_invitedUserId_fkey"
  FOREIGN KEY ("invitedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceActivity" ADD CONSTRAINT "SpaceActivity_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceActivity" ADD CONSTRAINT "SpaceActivity_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SpaceDocument" ADD CONSTRAINT "SpaceDocument_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceDocument" ADD CONSTRAINT "SpaceDocument_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SpaceDocument" ADD CONSTRAINT "SpaceDocument_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
