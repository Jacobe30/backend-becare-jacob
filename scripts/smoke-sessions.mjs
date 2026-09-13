#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import process from "node:process";
import { io } from "socket.io-client";

const baseUrl = (process.env.SMOKE_BASE_URL || "https://backend-becare-jacob-production.up.railway.app").replace(/\/$/, "");
const shouldCleanup = process.env.SMOKE_CLEANUP === "1";
const adminToken = process.env.ADMIN_TOKEN || "";
const sessionId = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;

function ok(message) {
  console.log(`PASS ${message}`);
}

function fail(message, detail) {
  console.error(`FAIL ${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return body;
}

async function postJson(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function deleteSession() {
  if (!shouldCleanup) {
    console.warn(`WARN test session retained: ${sessionId}`);
    console.warn("Set SMOKE_CLEANUP=1 and ADMIN_TOKEN to remove it automatically.");
    return;
  }
  if (!adminToken) throw new Error("SMOKE_CLEANUP=1 requires ADMIN_TOKEN");
  const response = await fetch(`${baseUrl}/users/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`cleanup returned ${response.status}: ${await response.text()}`);
  ok("cleanup removed the test session");
}

async function main() {
  const version = await getJson("/version");
  ok(`backend is reachable (${version.version || "unknown version"})`);

  const initialized = await postJson("/api/user/init", {
    browserInfo: { source: "smoke-test", userAgent: "session-smoke-test" },
  });
  if (!initialized?.userInfo?.uuid) throw new Error("/api/user/init did not return userInfo.uuid");
  ok("customer initialization returns a session UUID");

  const socket = io(baseUrl, { transports: ["websocket", "polling"], timeout: 10000 });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket.IO connection timed out")), 12000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", reject);
    });
    ok("Socket.IO connection succeeds");
    socket.emit("join", { role: "visitor" });
    socket.emit("bindOrder", sessionId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    ok("visitor bindOrder event sent");
  } finally {
    socket.disconnect();
  }

  const users = await getJson("/users");
  if (!Array.isArray(users)) throw new Error("/users did not return an array");
  const found = users.find((user) => user.id === sessionId || user.uuid === sessionId);
  if (!found) throw new Error(`session ${sessionId} was not found in /users`);
  if (!found.lastSeen && !found.updatedAt) throw new Error("session has no activity timestamp");
  ok(`session ${sessionId} is visible in /users`);

  await deleteSession();
}

main().catch(async (error) => {
  fail("session smoke test", error instanceof Error ? error.message : String(error));
  if (shouldCleanup && adminToken) {
    try {
      await deleteSession();
    } catch (cleanupError) {
      console.error(`FAIL cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
});
