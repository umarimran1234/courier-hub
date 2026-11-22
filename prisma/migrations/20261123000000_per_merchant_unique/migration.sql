-- Shipments are unique per merchant, not globally, so merchants never collide or see each other's rows.
DROP INDEX "Shipment_courier_trackingNumber_key";
CREATE UNIQUE INDEX "Shipment_tenantId_courier_trackingNumber_key" ON "Shipment"("tenantId", "courier", "trackingNumber");
