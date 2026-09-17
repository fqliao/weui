-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "browserSnapshot" JSONB;

-- CreateTable
CREATE TABLE "LoginProfile" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebFeature" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebCase" (
    "id" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginProfile_environmentId_idx" ON "LoginProfile"("environmentId");

-- CreateIndex
CREATE INDEX "WebFeature_environmentId_idx" ON "WebFeature"("environmentId");

-- CreateIndex
CREATE INDEX "WebCase_featureId_idx" ON "WebCase"("featureId");

-- AddForeignKey
ALTER TABLE "LoginProfile" ADD CONSTRAINT "LoginProfile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebFeature" ADD CONSTRAINT "WebFeature_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebCase" ADD CONSTRAINT "WebCase_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "WebFeature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
