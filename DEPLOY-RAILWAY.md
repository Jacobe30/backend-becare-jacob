# Deploy a new Railway service

## 1. Create the repo
```bash
unzip gosuksa-backend.zip -d gosuksa-backend
cd gosuksa-backend
git init && git add . && git commit -m "backend"
git remote add origin git@github.com:<you>/gosuksa-backend.git
git push -u origin main
```

## 2. Create the Railway service
1. railway.app -> New Project -> Deploy from GitHub repo -> pick the repo.
2. Railway auto-detects Node (Nixpacks) and runs `npm start` (see `railway.json` / `Procfile`).
3. Settings -> Networking -> Generate Domain. You get `https://<service>.up.railway.app`.

## 3. Variables (Railway -> Variables)
```
ADMIN_TOKEN=<long random string>
CHAT_ENABLED=true
DATA_FILE=/data/data.json     # only if you attach a volume
```
`PORT` is injected by Railway automatically — do not set it.

Persistence: the reference store is a JSON file. For real data attach a Railway
Volume mounted at `/data` and set `DATA_FILE=/data/data.json`, or swap the store
for the database your admin dashboard already uses.

## 4. Verify
```bash
curl -i https://<service>.up.railway.app/breinit
curl -i -X POST https://<service>.up.railway.app/api/user/init \
  -H 'content-type: application/json' -d '{}'
```
Both should return 200.

## 5. Point the frontend + admin dashboard
- Frontend (this Lovable project): set `VITE_BACKEND_WS_URL=https://<service>.up.railway.app`.
- Admin dashboard: same base URL, `Authorization: Bearer <ADMIN_TOKEN>`,
  Socket.IO at `/socket.io` joining with
  `{ userType: "admin", userInfo: { adminToken: "<ADMIN_TOKEN>" } }`.

## 6. Optional Cloudflare Worker front door (`worker/`)
```bash
cd worker
npx wrangler deploy
```
Set `ORIGIN_URL` in `wrangler.toml` to the new Railway URL, then point the
frontend at the Worker URL instead. The Worker proxies REST and Socket.IO
(including WebSocket upgrades) and handles CORS.
