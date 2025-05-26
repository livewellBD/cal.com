-- CreateTable
CREATE TABLE "AuthorizedApplication" (
    "id" SERIAL NOT NULL,
    "applicationId" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorizedApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedApplication_applicationId_key" ON "AuthorizedApplication"("applicationId");

-- CreateIndex
CREATE INDEX "AuthorizedApplication_applicationId_idx" ON "AuthorizedApplication"("applicationId");
