-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "anchorTxHash" TEXT,
ADD COLUMN     "anchorTxXdr" TEXT,
ADD COLUMN     "blockedReason" TEXT,
ADD COLUMN     "interactiveUrl" TEXT;
