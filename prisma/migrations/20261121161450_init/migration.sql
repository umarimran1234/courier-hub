-- CreateEnum
CREATE TYPE "Courier" AS ENUM ('POSTEX', 'LEOPARDS', 'TCS');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPT_FAILED', 'ON_HOLD', 'DELIVERED', 'RETURN_IN_PROGRESS', 'RETURNED', 'CANCELLED', 'LOST_OR_DAMAGED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "courier" "Courier" NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "credentialsEnc" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "webhookToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "courier" "Courier" NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "orderRef" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
    "rawStatus" TEXT,
    "codAmount" INTEGER,
    "consigneeName" TEXT,
    "consigneePhone" TEXT,
    "city" TEXT,
    "labelUrl" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "bookingRaw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "location" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmappedStatus" (
    "id" TEXT NOT NULL,
    "courier" "Courier" NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnmappedStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_apiKeyHash_key" ON "Tenant"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "CourierAccount_webhookToken_key" ON "CourierAccount"("webhookToken");

-- CreateIndex
CREATE INDEX "CourierAccount_tenantId_idx" ON "CourierAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierAccount_tenantId_courier_label_key" ON "CourierAccount"("tenantId", "courier", "label");

-- CreateIndex
CREATE INDEX "Shipment_tenantId_status_idx" ON "Shipment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Shipment_isTerminal_lastSyncedAt_idx" ON "Shipment"("isTerminal", "lastSyncedAt");

-- CreateIndex
CREATE INDEX "Shipment_orderRef_idx" ON "Shipment"("orderRef");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_courier_trackingNumber_key" ON "Shipment"("courier", "trackingNumber");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_occurredAt_idx" ON "ShipmentEvent"("shipmentId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentEvent_shipmentId_occurredAt_rawStatus_key" ON "ShipmentEvent"("shipmentId", "occurredAt", "rawStatus");

-- CreateIndex
CREATE UNIQUE INDEX "UnmappedStatus_courier_rawStatus_key" ON "UnmappedStatus"("courier", "rawStatus");

-- AddForeignKey
ALTER TABLE "CourierAccount" ADD CONSTRAINT "CourierAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CourierAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
