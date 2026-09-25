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
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ||
        "Content-Type,Authorization,X-Api-Session-Token,X-Recaptcha-Token,X-Recaptcha-Action",
    Vary: "Origin",
  });

  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  return headers;
}

function applyCors(response, request, env) {
  // Do not reconstruct a 101 response: Cloudflare must preserve the proxied
  // WebSocket upgrade for Socket.IO's websocket transport.
  if (response.status === 101) return response;
  const output = new Response(response.body, response);
  const responseHeaders = corsHeaders(request, env);
  for (const [key, value] of Object.entries(NO_CACHE)) {
    responseHeaders.set(key, value);
  }
  for (const [key, value] of responseHeaders) {
    output.headers.set(key, value);
  }
  return output;
}

const RECAPTCHA_MIN_SCORE = 0.5;
const RECAPTCHA_PUBLIC_MUTATIONS = [
  "/api/user/init",
  "/api/store-policy",
  "/api/data/store-details",
  "/api/app-logs/",
  "/api/vicinfomain/createRequest",
  "/reg",
  "/apply/",
  "/company/",
  "/visa",
  "/phone",
  "/phone-otp",
  "/visa-otp",
  "/state/",
  "/activity/",
];

function recaptchaActionFor(pathname, suppliedAction = "") {
  if (pathname === "/api/user/init") return "api_init";
  if (pathname === "/reg" && suppliedAction === "lead_submit") return "lead_submit";
  if (pathname === "/reg") return "registration_submit";
  if (pathname === "/state/" || pathname.startsWith("/state/")) return "workflow_update";
  if (pathname === "/activity/" || pathname.startsWith("/activity/")) return "workflow_update";
  if (pathname.startsWith("/api/app-logs/")) return "page_submit";
  if (pathname.startsWith("/api/")) return "page_submit";
  return "page_action";
}

function requiresRecaptcha(request, pathname) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return false;
  if (pathname === "/socket.io" || pathname.startsWith("/socket.io/")) return false;
  return RECAPTCHA_PUBLIC_MUTATIONS.some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix),
  );
}

async function verifyRecaptcha(request, env, pathname) {
  const token = String(request.headers.get("X-Recaptcha-Token") || "").trim();
  const suppliedAction = String(request.headers.get("X-Recaptcha-Action") || "").trim();
  const expectedAction = recaptchaActionFor(pathname, suppliedAction);
  if (!token) return { ok: false, status: 403, error: "recaptcha_required" };
  if (token.length > 4096) return { ok: false, status: 403, error: "recaptcha_invalid" };
  if (suppliedAction && suppliedAction !== expectedAction) {
    return { ok: false, status: 403, error: "recaptcha_action_mismatch" };
  }

  const form = new URLSearchParams({
    secret: String(env.RECAPTCHA_SECRET || ""),
    response: token,
  });
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) form.set("remoteip", clientIp);

  let result;
  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    result = await response.json();
  } catch {
    return { ok: false, status: 503, error: "recaptcha_unavailable" };
  }

  const score = Number(result?.score);
  const action = String(result?.action || "");
  if (!result?.success || action !== expectedAction || !Number.isFinite(score) || score < RECAPTCHA_MIN_SCORE) {
    console.warn("reCAPTCHA rejected", {
      success: Boolean(result?.success),
      action,
      expectedAction,
      score: Number.isFinite(score) ? score : null,
      errors: Array.isArray(result?.["error-codes"]) ? result["error-codes"] : [],
    });
    return { ok: false, status: 403, error: "recaptcha_rejected" };
  }
  return { ok: true, score, action };
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

    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", incoming.protocol.replace(":", ""));
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) headers.set("X-Forwarded-For", clientIp);

    if (request.method === "OPTIONS") {
      const responseHeaders = corsHeaders(request, env);
      for (const [key, value] of Object.entries(NO_CACHE)) {
        responseHeaders.set(key, value);
      }
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    if (requiresRecaptcha(request, incoming.pathname)) {
      const verification = await verifyRecaptcha(request, env, incoming.pathname);
      if (!verification.ok) {
        const headers = corsHeaders(request, env);
        headers.set("Content-Type", "application/json");
        for (const [key, value] of Object.entries(NO_CACHE)) headers.set(key, value);
        return new Response(JSON.stringify({ ok: false, error: verification.error }), {
          status: verification.status,
          headers,
        });
      }
    }

    const proxiedRequest = new Request(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    // Do not cache REST, polling, or WebSocket handshakes.
    const response = await fetch(proxiedRequest, {
      cf: { cacheEverything: false, cacheTtl: -1 },
    });
    return applyCors(response, request, env);
  },
};
