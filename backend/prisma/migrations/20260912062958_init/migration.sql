-- CreateEnum
CREATE TYPE "LinkStatus" AS ENUM ('open', 'paid', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "SettleStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "WdStatus" AS ENUM ('requested', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "iban" TEXT,
    "autoSavePercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountTRY" DECIMAL(20,7) NOT NULL,
    "quotedUSDC" DECIMAL(20,7) NOT NULL,
    "fxRate" DECIMAL(20,7) NOT NULL,
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" "LinkStatus" NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "amountUSDC" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountUSDC" DECIMAL(20,7) NOT NULL,
    "amountTRY" DECIMAL(20,7) NOT NULL,
    "fxRate" DECIMAL(20,7) NOT NULL,
    "savedUSDC" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "status" "SettleStatus" NOT NULL DEFAULT 'pending',
    "anchorRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amountTRY" DECIMAL(20,7) NOT NULL,
    "iban" TEXT NOT NULL,
    "status" "WdStatus" NOT NULL DEFAULT 'requested',
    "anchorRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedOperation" (
    "opId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedOperation_pkey" PRIMARY KEY ("opId")
);

-- CreateTable
CREATE TABLE "ListenerCursor" (
    "id" TEXT NOT NULL DEFAULT 'horizon-payments',
    "pagingToken" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListenerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "linkCode" TEXT,
    "txHash" TEXT NOT NULL,
    "fromAddr" TEXT NOT NULL,
    "amountUSDC" DECIMAL(20,7) NOT NULL,
    "assetCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_code_key" ON "PaymentLink"("code");

-- CreateIndex
CREATE INDEX "PaymentLink_code_idx" ON "PaymentLink"("code");

-- CreateIndex
CREATE INDEX "PaymentLink_merchantId_createdAt_idx" ON "PaymentLink"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_linkId_key" ON "Payment"("linkId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txHash_key" ON "Payment"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_paymentId_key" ON "Settlement"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_opId_key" ON "PaymentAttempt"("opId");

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "PaymentLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_linkCode_fkey" FOREIGN KEY ("linkCode") REFERENCES "PaymentLink"("code") ON DELETE SET NULL ON UPDATE CASCADE;
