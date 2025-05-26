-- CreateTable
CREATE TABLE "ApplicationUserMapping" (
    "id" SERIAL NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "identityProviderName" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "calComUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationUserMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationUserMapping_calComUserId_key" ON "ApplicationUserMapping"("calComUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationUserMapping_externalUserId_identityProviderName__key" ON "ApplicationUserMapping"("externalUserId", "identityProviderName", "applicationId");

-- AddForeignKey
ALTER TABLE "ApplicationUserMapping" ADD CONSTRAINT "ApplicationUserMapping_calComUserId_fkey" FOREIGN KEY ("calComUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
