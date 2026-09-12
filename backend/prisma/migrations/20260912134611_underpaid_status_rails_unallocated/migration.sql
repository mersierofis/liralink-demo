-- CreateEnum
CREATE TYPE "PayRail" AS ENUM ('contract', 'memo');

-- AlterEnum
ALTER TYPE "LinkStatus" ADD VALUE 'underpaid';

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "unallocatedUSDC" DECIMAL(20,7) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "rail" "PayRail" NOT NULL DEFAULT 'memo';

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "receivedUSDC" DECIMAL(20,7) NOT NULL DEFAULT 0,
ADD COLUMN     "shortfallUSDC" DECIMAL(20,7);
