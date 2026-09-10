# tmin backend

Drop-in Node.js backend that matches the exact API contract the frontend
bundle expects. Deploy on Railway (or any Node host); point the Lovable
frontend at it via `VITE_BACKEND_WS_URL`.

## Run locally

```bash
cd backend
cp .env.example .env
npm install
npm run dev
# -> listening on :3000
```

## Deploy on Railway

1. New service → Deploy from repo (this `backend/` folder).
2. Set env vars from `.env.example` (at minimum `ADMIN_TOKEN`).
3. Railway sets `PORT` automatically.
4. Copy the service URL and set it as `VITE_BACKEND_WS_URL` in the Lovable
   project. The Lovable proxy at `/api-proxy/*` forwards to it.

## Endpoints

REST (all called through the frontend's `/api-proxy/*`):

| Method | Path | Notes |
| --- | --- | --- |
| GET  | `/breinit` | KSA/geo gate stub — always `{ok:true}` |
| POST | `/api/user/init` | Returns `{ok,_id,session,userInfo:{uuid,...}}` |
| POST | `/api/chat/enabled` | `{isChatEnabled: 0|1}` |
| GET  | `/api/vicinfomain/captcha` | Returns captcha image + session |
| POST | `/api/vicinfomain/createRequest` | Vehicle lookup |
| POST | `/api/store-policy` | Persist generated policy |
| POST | `/api/data/store-details` | Persist step data |
| POST | `/api/app-logs/:appId/log-user-in-app/:page` | Page-view beacon |
| GET  | `/admin/state` | (Bearer `ADMIN_TOKEN`) full JSON dump |
| GET  | `/admin/submissions` | (Bearer) list submissions |

Socket.IO (`/socket.io`) — see comment block at top of `server.js` for the
full event list. Every client submission event is persisted and rebroadcast
to admins on `live:update`, matching what the existing dashboard listens for.

## Storage

Single JSON file (`data.json`) hosted by Railway. Attach a Railway **Volume**
and set `DATA_FILE=/data/data.json` so sessions survive redeploys. Every session
uses a server-generated UUID, exposes the canonical insurance quote fields from
`/users`, and refreshes `updatedAt` on every write. No Firebase or Firestore
connection is required.

## Real VIC integration

`/api/vicinfomain/captcha` and `/createRequest` currently generate a local
captcha (real readable PNG) and forward the vehicle lookup to `VIC_UPSTREAM_URL`
(with optional `VIC_UPSTREAM_TOKEN`). Without that variable every lookup is
recorded as `vehicle_not_found`. Replace
the two handlers in `server.js` with calls to your real vehicle-info
provider; response shape must stay:

```json
// captcha
{ "sessionId":"...", "captchaUuid":"...", "imageB64":"...", "imageDataUrl":"data:image/..." }

// createRequest
{ "status":"success", "vehicle": { "vehicleMaker":"", "vehicleModel":"", "modelYear":"", "vin":"", "customId":"", "plateInfo":null } }
// or { "status":"invalid_captcha"|"vehicle_not_found"|"failed", "errorCode":"..." }
```
