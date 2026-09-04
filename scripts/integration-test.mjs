#!/usr/bin/env node
/**
 * Integration test: submits a sample booking + payment payload over Socket.IO
 * and asserts every expected field is flattened onto the /users row.
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
socket.close();
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
