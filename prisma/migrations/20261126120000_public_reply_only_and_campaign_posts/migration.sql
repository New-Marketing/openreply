-- Public-reply-only campaigns (no DM).
ALTER TABLE "Automation" ADD COLUMN "dmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TYPE "DmStatus" ADD VALUE 'PUBLIC_REPLY_ONLY';

-- Campaigns that listen on several chosen posts.
CREATE TABLE "AutomationPost" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "postUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationPost_automationId_postId_key" ON "AutomationPost"("automationId", "postId");
CREATE INDEX "AutomationPost_postId_idx" ON "AutomationPost"("postId");

ALTER TABLE "AutomationPost" ADD CONSTRAINT "AutomationPost_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing single-post campaign becomes a one-post list.
INSERT INTO "AutomationPost" ("id", "automationId", "postId", "postUrl", "position")
SELECT 'ap_' || "id", "id", "postId", "postUrl", 0
FROM "Automation"
WHERE "postId" IS NOT NULL;
