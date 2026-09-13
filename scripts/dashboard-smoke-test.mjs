#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

const local = process.argv.includes("--local");
const baseArg = process.argv.find((arg) => arg.startsWith("--base="));
const base = baseArg ? baseArg.slice("--base=".length).replace(/\/$/, "") : "https://tmin-edge.bcare.workers.dev";
const allowWrite = process.env.ALLOW_WRITE_SMOKE === "1";
if (!local && !allowWrite) {
  console.error("Refusing to write to a remote backend. Use --local for the disposable test, or ALLOW_WRITE_SMOKE=1 explicitly.");
  process.exit(2);
}

const port = 39118;
const tempFile = path.join(os.tmpdir(), `tmin-dashboard-smoke-${process.pid}.json`);
let child;
if (local) {
  child = spawn(process.execPath, [path.resolve("server.js")], {
    env: { ...process.env, PORT: String(port), DATA_FILE: tempFile, ADMIN_TOKEN: "smoke-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const target = local ? `http://127.0.0.1:${port}` : base;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, timeout = 8000, predicate = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
  const handler = (payload) => {
    if (!predicate(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
});

try {
  if (local) await wait(500);
  const tag = `dashboard-smoke-${Date.now()}`;
  const admin = io(target, { transports: ["websocket"], auth: { role: "admin", token: local ? "smoke-token" : undefined } });
  await once(admin, "connect");
  admin.emit("join", { role: "admin", token: local ? "smoke-token" : undefined });
  await wait(150);

  const sessionUpdate = once(admin, "sessionUpdate", 8000, (p) => p?.id === tag || p?.uuid === tag);
  const response = await fetch(`${target}/reg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: tag, uuid: tag, national_id: "SMOKE-ONLY", phone: "0000000000", stage: "smoke" }),
  });
  if (!response.ok) throw new Error(`/reg returned HTTP ${response.status}`);
  const pushed = await sessionUpdate;
  const users = await (await fetch(`${target}/users`)).json();
  const rows = Array.isArray(users) ? users : users.users || [];
  const listed = rows.some((p) => p?.id === tag || p?.uuid === tag);
  if (!listed) throw new Error("submission was not present in /users");

  console.log(JSON.stringify({ ok: true, target, tag, liveSessionUpdate: true, dashboardUsersApi: true, cleanedUp: local }));
  admin.close();
} finally {
  if (child) child.kill("SIGTERM");
  if (local) {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}
