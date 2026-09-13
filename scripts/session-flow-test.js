const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const port = 39117;
const dataFile = path.join("/tmp", `tmin-session-flow-${process.pid}.json`);
const token = "integration-test-token";
const backend = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN: token },
  stdio: ["ignore", "pipe", "pipe"],
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, timeout = 5000, predicate = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
});

(async () => {
  try {
    await wait(500);
    const admin = io(backend, { path: "/socket.io", auth: { role: "admin", token }, transports: ["websocket"] });
    await once(admin, "connect");
    admin.emit("join", { role: "admin", token });
    await wait(150);

    const sessionId = "integration-session-001";
    const sessionUpdate = once(admin, "sessionUpdate", 5000, (payload) => payload?.id === sessionId || payload?.uuid === sessionId);
    const response = await fetch(`${backend}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionId, national_id: "TEST-ID", phone: "0500000000" }),
    });
    if (!response.ok) throw new Error(`/reg returned ${response.status}`);
    const session = await sessionUpdate;
    if (session.id !== sessionId && session.uuid !== sessionId) throw new Error("admin received the wrong REST session id");

    const client = io(backend, { path: "/socket.io", auth: { id: sessionId }, transports: ["websocket"] });
    await once(client, "connect");
    client.emit("user:join", { userType: "client", userId: sessionId });
    const redirect = once(client, "admin:redirect");
    admin.emit("adminRedirect", { id: sessionId, path: "/verfiy", pageName: "verification", token });
    const redirectPayload = await redirect;
    if (redirectPayload.id !== sessionId || redirectPayload.page !== "/verfiy") {
      throw new Error("client received an incomplete redirect payload");
    }

    const listed = await (await fetch(`${backend}/users`)).json();
    if (!listed.some((item) => item.id === sessionId || item.uuid === sessionId)) throw new Error("session missing from dashboard users API");
    console.log(JSON.stringify({ ok: true, restSubmissionToDashboard: true, adminRedirectToClient: true, sessionId }));
    admin.close();
    client.close();
    child.kill("SIGTERM");
    try { fs.unlinkSync(dataFile); } catch {}
  } catch (error) {
    console.error(error.stack || error.message);
    child.kill("SIGTERM");
    try { fs.unlinkSync(dataFile); } catch {}
    process.exitCode = 1;
  }
})();
