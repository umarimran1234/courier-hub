# courier-hub

One NestJS backend that talks to **PostEx, Leopards and TCS** so your app only ever calls *this* API:
book a parcel, get its status by tracking number, cancel, fetch the label, and receive status-change webhooks —
with one request format and one set of status values, whichever courier is behind it.

```
Your app / Shopify app ──►  courier-hub (/v1/...)  ──►  PostEx | Leopards | TCS adapters
                              Postgres (shipments, events)   BullMQ + Redis (sync, webhooks)
```

## Quick start

```bash
cp .env.example .env            # set ADMIN_KEY and ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up --build       # api on :3000, migrations run automatically
```

Local dev: `npm i && npx prisma migrate dev && npm run start:dev` (needs Postgres + Redis, see `.env.example`).

```bash
# 1. create a tenant (one per store/merchant) -> returns apiKey ONCE
curl -X POST :3000/v1/admin/tenants -H 'x-admin-key: $ADMIN_KEY' -H 'content-type: application/json' \
     -d '{"name":"My Store","webhookUrl":"https://myapp.com/hooks/courier"}'

# 2. connect a courier account (credentials are verified live, then stored AES-256-GCM encrypted)
curl -X POST :3000/v1/accounts -H 'x-api-key: chk_...' -H 'content-type: application/json' \
     -d '{"courier":"POSTEX","credentials":{"token":"<postex api token>","pickupAddressCode":"001"}}'

# 3. book (same payload for every courier)
curl -X POST :3000/v1/shipments -H 'x-api-key: chk_...' -H 'content-type: application/json' -d '{
  "courier":"POSTEX","orderRef":"#1001","codAmount":2500,"weightKg":1,"pieces":1,
  "consignee":{"name":"Ali Khan","phone":"03001234567","address":"House 1, Street 2","city":"Lahore"}}'

# 4. status by courier + tracking number
curl :3000/v1/shipments/track/postex/CX-1234 -H 'x-api-key: chk_...'
```

## Merchant model (each merchant is isolated)

One **tenant = one merchant**. Your app creates a tenant per merchant (`POST /v1/admin/tenants`, `x-admin-key`) and stores the
returned `apiKey` against that merchant. The merchant then connects **their own** courier account (client id/secret, token,
username/password: see the table below) through your app, which calls `POST /v1/accounts` with that merchant's key.

- Credentials are AES-256-GCM encrypted at rest, verified live against the courier on connect, and never returned by the API.
- Accounts, shipments, events, webhooks and cache entries are all scoped to the merchant. Merchant B can never read, use or delete merchant A's data (covered by e2e tests).
- Tracking uses only the calling merchant's own account. If they haven't connected that courier you get `404 No active <COURIER> account connected`.

```bash
# merchant connects their courier (your app calls this with the merchant's key)
curl -X POST :3000/v1/accounts -H 'x-api-key: chk_MERCHANT' -H 'content-type: application/json' \
     -d '{"courier":"TCS","credentials":{"username":"...","password":"...","clientId":"...","clientSecret":"..."}}'

# status of any tracking number via that merchant's account (nothing stored)
curl :3000/v1/track/tcs/779412326902  -H 'x-api-key: chk_MERCHANT'
curl :3000/v1/track                   -H 'x-api-key: chk_MERCHANT'     # which couriers this merchant connected
curl -X POST :3000/v1/track/bulk -H 'x-api-key: chk_MERCHANT' -H 'content-type: application/json' \
     -d '{"items":[{"courier":"leopards","trackingNumber":"LE1234567890"},{"courier":"tcs","trackingNumber":"779412326902"}]}'
```

`/v1/track/*` results are cached per merchant+account (`TRACK_CACHE_SECONDS`, final states for 1h). For stored shipments with
background sync and webhooks use `/v1/shipments` (below).

## Credentials per courier (what each merchant provides)

| Courier | `credentials` fields |
|---|---|
| POSTEX | `token`, optional `pickupAddressCode`, `storeAddressCode` |
| LEOPARDS | `apiKey`, `apiPassword`, optional `originCityId`, `shipperName/Email/Phone/Address` (default `self` = account profile), `shipmentType`, `fallbackEmail`; `"sandbox": true` uses the staging host |
| TCS | `username`, `password`, `accountNo`, `costCenterCode`, `shipperName`, `shipperAddress`, `shipperCity`, `shipperMobile`; optional `serviceCode` (default `O`), `clientId` + `clientSecret` (for the tracking API bearer token); `"sandbox": true` uses `devconnect.tcscourier.com` |

## API

All `/v1/*` routes except admin and inbound webhooks need `x-api-key`.

| Method & path | What it does |
|---|---|
| `GET /v1/couriers` | Supported couriers, required credentials, per-feature `verified` flags |
| `POST /v1/accounts` · `GET` · `POST /:id/verify` · `PATCH /:id` · `DELETE /:id` | Manage courier accounts |
| `POST /v1/shipments` | Book (rejects a second booking of the same `orderRef` unless `allowDuplicate: true`) |
| `GET /v1/shipments` | List, filter by `status`, `courier`, `orderRef`, `trackingNumber`, `from`, `to`; cursor pagination |
| `GET /v1/shipments/:id` | Shipment + full event history |
| `GET /v1/shipments/track/:courier/:trackingNumber` | Live status from the courier (works for parcels not booked here too) |
| `POST /v1/shipments/track-bulk` | Up to 200 tracking numbers, any mix of couriers, one call |
| `POST /v1/shipments/:id/refresh` · `/cancel` | Force re-sync · cancel at the courier |
| `GET /v1/shipments/:id/label` | Label (Leopards: stored slip link; TCS: PDF; PostEx: not available via API) |
| `GET /v1/shipments/:id/payment-status` | COD settlement status (PostEx, TCS) |
| `GET /v1/couriers/:courier/cities` · `/status-catalog` | City lists; the courier's own status list (PostEx, TCS) |
| `PATCH /v1/tenant/webhook` | Set your webhook URL; returns the HMAC secret |
| `POST /v1/webhooks/leopards/:accountWebhookToken` | Give this URL to Leopards for push updates |
| `POST /v1/admin/tenants` · `GET /v1/admin/unmapped-statuses` | Operator endpoints (`x-admin-key`) |

### Unified statuses

`CREATED → PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED`, plus `DELIVERY_ATTEMPT_FAILED`, `ON_HOLD`,
`RETURN_IN_PROGRESS`, `RETURNED`, `CANCELLED`, `LOST_OR_DAMAGED`, `UNKNOWN`.
The courier's original text is always kept in `rawStatus`. `DELIVERED / RETURNED / CANCELLED / LOST_OR_DAMAGED` are final.

### How status stays fresh

- Webhook push where the courier offers it (Leopards).
- Background sync: every `SYNC_INTERVAL_MINUTES`, open shipments are batch-tracked per account (BullMQ, retries, circuit breaker).
- On demand: `track` / `refresh`.
- On every change your `webhookUrl` receives `shipment.status_changed`, signed with header `x-courierhub-signature` = HMAC-SHA256(secret, raw body). Delivery retries with exponential backoff.

## READ THIS: what is verified and what is not

These courier APIs are only partly public. The code was built from the official TCS guide and from
open-source PostEx/Leopards clients, and tested against **stubbed** courier responses — it has **not** been run against live
courier accounts. Check each item once with real credentials (`GET /v1/couriers` also exposes these flags).

| | Basis | Confirm with a real account |
|---|---|---|
| **TCS** | Official "API User Guide v1.0": all endpoints, fields and auth | Tracking date format (parser accepts `DD/MM/YYYY HH:mm`, ISO); default `servicecode` `O`; middle name sent as `-` when the customer has none; guide has some host/field inconsistencies it flags itself |
| **PostEx** | Endpoint paths and `token` header confirmed from public wrappers; no public OpenAPI | Response field names for tracking (`dist.transactionStatus`, `transactionStatusHistory[]`) are parsed with several aliases; bulk tracking is a GET with a JSON body (falls back to one-by-one if it fails); run `GET /v1/couriers/POSTEX/status-catalog` to see the real status list |
| **Leopards** | `getAllCities`, `bookPacket`, `trackBookedPacket` confirmed from an open-source client | **Cancel** (`cancelBookedPackets`, param `cn_numbers`) and the **Push payload** shape are unverified; tracking response keys (`packet_list`, `Tracking Detail`) parsed defensively |

**Status mapping:** neither PostEx nor Leopards publishes a complete status list, so text is matched with ordered rules
(`src/couriers/status-mapper.ts`). Anything unmatched is stored as `UNKNOWN`-never-overwrites and logged in the
`UnmappedStatus` table: open `GET /v1/admin/unmapped-statuses` during your first week and add rules for what shows up.
The broad "in transit" keywords (hub, station, warehouse…) are deliberately last in the list.

**Booking is not retried** (a timeout could otherwise create two parcels). If a booking call times out, look the order up in the courier panel before retrying.

## Add another courier

1. Add the name to `enum Courier` in `prisma/schema.prisma` and run a migration.
2. Create `src/couriers/adapters/<name>.adapter.ts` implementing `CourierAdapter` (copy `postex.adapter.ts`).
3. Register it in `courier.registry.ts` and `couriers.module.ts`. Everything else (API, sync, webhooks, tests helpers) works unchanged.

## Tests

```bash
npm test                                   # 67 unit tests (mapper, parsers, adapters with stubbed HTTP, crypto)
DATABASE_URL=... REDIS_URL=... npm run test:e2e   # 27 end-to-end tests on real Postgres + Redis
```
