-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "contractDeadlineLedger" INTEGER,
ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "contractTxHash" TEXT;
