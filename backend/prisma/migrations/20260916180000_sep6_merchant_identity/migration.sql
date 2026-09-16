-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "sep12CustomerId" TEXT,
ADD COLUMN     "sep12HomeDomain" TEXT,
ADD COLUMN     "sep12Iban" TEXT;

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "anchorMemo" TEXT;

