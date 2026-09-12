-- DropIndex
DROP INDEX "Payment_linkId_key";

-- CreateIndex
CREATE INDEX "Payment_linkId_idx" ON "Payment"("linkId");
