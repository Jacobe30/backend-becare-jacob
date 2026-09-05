# gosuksa-edge — Cloudflare Worker front door

Proxies all REST, `/breinit`, and Socket.IO (polling + WebSocket upgrade) traffic
to the Railway backend, and applies CORS for the allowed frontend origins.

- Worker URL: `https://gosuksa-edge.bcare.workers.dev`
- Origin (Railway): `https://jbackend-production-dc1b.up.railway.app`
- Frontend points at the Worker via `VITE_BACKEND_WS_URL`.

---

## 1. Install

```bash
cd backend/worker
npm install
```

## 2. Log in to Cloudflare (once per machine)

```bash
npm run login      # opens the browser
npm run whoami     # confirms the account
```

## 3. Check the variables before deploying

`wrangler.toml` holds the non-secret vars:

```toml
[vars]
ORIGIN_URL = "https://jbackend-production-dc1b.up.railway.app"
ALLOWED_ORIGINS = "https://gosuksa-tmin.lovable.app,https://id-preview--175f4f58-4e54-426c-b9c2-7ac4e8f4e2f0.lovable.app"
```

Rules enforced by the Worker at runtime:

- `ORIGIN_URL` — absolute `http(s)` URL, no trailing path.
- `ALLOWED_ORIGINS` — comma-separated **bare origins** (`https://host`), no
  paths, no trailing slashes, no wildcards.
- `RECAPTCHA_SECRET` — a secret, not in `wrangler.toml`.

If any of these is missing or malformed, every request returns
`500 {"ok":false,"error":"worker_misconfigured","details":[...]}` and the exact
problem is logged — so a bad deploy fails immediately instead of silently
breaking CORS or captcha checks.

## 4. Set the reCAPTCHA secret

The site key lives in the frontend (`VITE_RECAPTCHA_SITE_KEY`,
currently `6Lc_s6ctAAAAAAP7In69-LKpeGGUGFQ8UCyfW0kd`). The **secret** key from the
same reCAPTCHA console entry goes here:

```bash
npm run secret:recaptcha    # prompts, value is never stored in git
```

Set the same secret on Railway as `RECAPTCHA_SECRET` if server-side verification
runs there too.

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints the uploaded worker name and URL.

## 6. Verify

```bash
npm run verify
# or against another URL:
node scripts/verify.mjs https://gosuksa-edge.bcare.workers.dev
```

It checks five things:

1. `GET /breinit` → `200 {"ok":true}`
2. Preflight from `https://gosuksa-tmin.lovable.app` returns a matching
   `Access-Control-Allow-Origin` (proves `ALLOWED_ORIGINS` is applied)
3. Preflight from an unlisted origin returns **no** allow-origin header
4. `GET /socket.io/?EIO=4&transport=polling` → `200` and advertises `websocket`
5. A real admin socket can relay accept, redirect, block, and OTP actions to a
   customer socket using the event names the customer pages consume

Manual equivalents:

```bash
curl -i https://gosuksa-edge.bcare.workers.dev/breinit
curl -i -X OPTIONS https://gosuksa-edge.bcare.workers.dev/breinit \
  -H 'Origin: https://gosuksa-tmin.lovable.app' \
  -H 'Access-Control-Request-Method: POST'
```

Live logs while testing the site:

```bash
npm run tail
```

## 7. Verify reCAPTCHA end to end

1. In the Google reCAPTCHA admin console, the key's **Domains** list must contain
   `gosuksa-tmin.lovable.app` (add the `id-preview--…lovable.app` host to test in
   the Lovable preview).
2. Open the site, submit a form, and watch `npm run tail`.
3. A `recaptcha` / `invalid-input-secret` failure means the secret does not match
   the site key — re-run `npm run secret:recaptcha` with the correct value and
   redeploy.

## 8. Adding a new frontend domain

1. Append the origin to `ALLOWED_ORIGINS` in `wrangler.toml`.
2. `npm run deploy`
3. Add the same hostname in the reCAPTCHA (and Turnstile) console.
4. `node scripts/verify.mjs` — check the CORS test with the new origin.
