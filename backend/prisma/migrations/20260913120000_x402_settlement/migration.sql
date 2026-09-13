-- CreateEnum
CREATE TYPE "X402SettleStatus" AS ENUM ('pending', 'settled', 'failed');

-- CreateTable
CREATE TABLE "X402Settlement" (
    "id" TEXT NOT NULL,
    "linkCode" TEXT NOT NULL,
    "payer" TEXT,
    "amountUSDC" DECIMAL(20,7) NOT NULL,
    "paymentPayload" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "status" "X402SettleStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "failReason" TEXT,
    "lastError" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "X402Settlement_status_idx" ON "X402Settlement"("status");
