-- CreateEnum
CREATE TYPE "UsdcWdSource" AS ENUM ('saved', 'unallocated');

-- CreateEnum
CREATE TYPE "UsdcWdStatus" AS ENUM ('submitted', 'completed', 'failed');

-- CreateTable
CREATE TABLE "UsdcWithdrawal" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amountUSDC" DECIMAL(20,7) NOT NULL,
    "destination" TEXT NOT NULL,
    "source" "UsdcWdSource" NOT NULL,
    "status" "UsdcWdStatus" NOT NULL DEFAULT 'submitted',
    "txHash" TEXT NOT NULL,
    "txXdr" TEXT NOT NULL,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "UsdcWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsdcWithdrawal_txHash_key" ON "UsdcWithdrawal"("txHash");

-- CreateIndex
CREATE INDEX "UsdcWithdrawal_merchantId_createdAt_idx" ON "UsdcWithdrawal"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "UsdcWithdrawal_status_idx" ON "UsdcWithdrawal"("status");

-- AddForeignKey
ALTER TABLE "UsdcWithdrawal" ADD CONSTRAINT "UsdcWithdrawal_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
