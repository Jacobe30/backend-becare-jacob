// Cloudflare Worker edge front door for the Railway backend.
// Proxies every path, including REST, /breinit, and /socket.io.

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

// Workers have no startup hook, so config is validated once on the first
// request of each isolate and the result is cached. Bad config fails fast
// with 500 instead of silently breaking CORS or captcha verification.
let configCache = null;

function validateEnv(env) {
  if (configCache) return configCache;
  const errors = [];

  // ORIGIN_URL — required, must be an absolute http(s) URL.
  let originUrl = null;
  if (!env.ORIGIN_URL || !String(env.ORIGIN_URL).trim()) {
    errors.push("ORIGIN_URL is missing");
  } else {
    try {
      originUrl = new URL(String(env.ORIGIN_URL).trim());
      if (!/^https?:$/.test(originUrl.protocol)) {
        errors.push("ORIGIN_URL must start with http:// or https://");
      }
    } catch {
      errors.push(`ORIGIN_URL is malformed: ${env.ORIGIN_URL}`);
    }
  }

  // ALLOWED_ORIGINS — required, comma separated list of scheme+host origins.
  const origins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    errors.push("ALLOWED_ORIGINS is missing or empty");
  }
  for (const candidate of origins) {
    try {
      const parsed = new URL(candidate);
      if (!/^https?:$/.test(parsed.protocol)) {
        errors.push(`ALLOWED_ORIGINS entry must be http(s): ${candidate}`);
      } else if (parsed.origin !== candidate.replace(/\/$/, "")) {
        errors.push(
          `ALLOWED_ORIGINS entry must be a bare origin with no path or trailing slash: ${candidate}`,
        );
      }
    } catch {
      errors.push(`ALLOWED_ORIGINS entry is malformed: ${candidate}`);
    }
  }

  // RECAPTCHA_SECRET — required, Google secrets look like "6L..." (40 chars).
  const secret = String(env.RECAPTCHA_SECRET || "").trim();
  if (!secret) {
    errors.push("RECAPTCHA_SECRET is missing (wrangler secret put RECAPTCHA_SECRET)");
  } else if (!/^6[0-9A-Za-z_-]{20,}$/.test(secret)) {
    errors.push("RECAPTCHA_SECRET is malformed (expected a Google reCAPTCHA secret starting with 6)");
  }

  configCache = { errors, origins, originUrl };
  if (errors.length) {
    console.error("Worker configuration invalid:\n - " + errors.join("\n - "));
  }
  return configCache;
}

function allowedOrigins(env) {
  return validateEnv(env).origins;
}


function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const headers = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  });

  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return headers;
}

export default {
  async fetch(request, env) {
    const config = validateEnv(env);
    if (config.errors.length) {
      return new Response(
        JSON.stringify({ ok: false, error: "worker_misconfigured", details: config.errors }),
        { status: 500, headers: { "Content-Type": "application/json", ...NO_CACHE } },
      );
    }

    const origin = config.originUrl;

    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, origin);
    const headers = new Headers(request.headers);

    headers.set("Host", origin.host);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", incoming.protocol.replace(":", ""));

    if (request.method === "OPTIONS") {
      const responseHeaders = corsHeaders(request, env);
      for (const [key, value] of Object.entries(NO_CACHE)) {
        responseHeaders.set(key, value);
      }
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    const proxiedRequest = new Request(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    // Cloudflare forwards the Upgrade header and WebSocket body untouched.
    const response = await fetch(proxiedRequest, {
      cf: { cacheEverything: false, cacheTtl: -1 },
    });
    const responseHeaders = corsHeaders(request, env);
    for (const [key, value] of Object.entries(NO_CACHE)) {
      responseHeaders.set(key, value);
    }

    const output = new Response(response.body, response);
    for (const [key, value] of responseHeaders) {
      output.headers.set(key, value);
    }
    return output;
  },
};
