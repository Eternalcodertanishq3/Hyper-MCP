import assert from "node:assert/strict";
import { Readable } from "node:stream";
import path from "node:path";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDashboardRequest, type DashboardStateSource } from "../src/dashboard/server.ts";

function request(options: { method: string; url: string; host?: string; origin?: string; contentType?: string; remoteAddress?: string }): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: options.method,
    url: options.url,
    headers: {
      host: options.host ?? "127.0.0.1:4317",
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.contentType ? { "content-type": options.contentType } : {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  });
  return stream;
}

function makeResponse(): { instance: ServerResponse; state: { status?: number; headers?: Record<string, string>; body: string } } {
  const state: { status?: number; headers?: Record<string, string>; body: string } = { body: "" };
  const raw: any = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) { state.status = status; state.headers = headers; raw.headersSent = true; return raw; },
    end(body?: string) { state.body = body ?? ""; return raw; },
    destroy() { return raw; },
  };
  return { instance: raw as ServerResponse, state };
}

test("dashboard mutation endpoints require same-origin JSON requests", async () => {
  let actions = 0;
  const source: DashboardStateSource = {
    getDashboardState: () => ({ ok: true }),
    manageTransaction: async (_id, action) => { actions += 1; return { status: action }; },
    subscribe: () => () => undefined,
  };
  const htmlPath = path.resolve("src/dashboard/public/index.html");
  const invoke = async (req: IncomingMessage) => {
    const res = makeResponse();
    await handleDashboardRequest(req, res.instance, source, htmlPath, 4317);
    return res.state;
  };

  assert.equal((await invoke(request({ method: "POST", url: "/api/tx/tx_123/approve" }))).status, 403);
  assert.equal((await invoke(request({ method: "POST", url: "/api/tx/tx_123/approve", origin: "https://attacker.example", contentType: "application/json" }))).status, 403);
  assert.equal((await invoke(request({ method: "POST", url: "/api/tx/tx_123/approve", origin: "http://127.0.0.1:4317", contentType: "text/plain" }))).status, 415);
  assert.equal(actions, 0);

  const approved = await invoke(request({ method: "POST", url: "/api/tx/tx_123/approve", origin: "http://127.0.0.1:4317", contentType: "application/json" }));
  assert.equal(approved.status, 200);
  assert.equal(actions, 1);
  assert.equal((await invoke(request({ method: "POST", url: "/api/tx/tx_123/approve", origin: "http://127.0.0.1:4317", contentType: "application/json", remoteAddress: "192.168.1.4" }))).status, 403);
});

test("dashboard HTML allows its fixed script by hash instead of unsafe-inline", async () => {
  const source: DashboardStateSource = { getDashboardState: () => ({}), manageTransaction: async () => ({}), subscribe: () => () => undefined };
  const res = makeResponse();
  await handleDashboardRequest(request({ method: "GET", url: "/" }), res.instance, source, path.resolve("src/dashboard/public/index.html"), 4317);
  const csp = res.state.headers?.["content-security-policy"] ?? "";
  assert.match(csp, /script-src 'sha256-/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});
