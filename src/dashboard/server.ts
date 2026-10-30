import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DashboardStateSource {
  getDashboardState(): unknown;
  getTransactionSnapshot?(id: string): unknown;
  manageTransaction(id: string, action: "approve" | "reject" | "undo"): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function allowedHost(host: string | undefined): boolean {
  return Boolean(host && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host));
}

export async function handleDashboardRequest(req: IncomingMessage, res: ServerResponse, source: DashboardStateSource, htmlPath: string, port: number, eventStreams: Set<ServerResponse> = new Set()): Promise<void> {
  const host = req.headers.host;
  if (!isLoopback(req.socket.remoteAddress) || !allowedHost(host)) return json(res, 403, { error: "Dashboard accepts loopback connections only." });
  const origin = req.headers.origin;
  const allowedOrigins = ["http://127.0.0.1:" + port, "http://localhost:" + port, "http://[::1]:" + port];
  if (origin && !allowedOrigins.includes(origin)) {
    return json(res, 403, { error: "Cross-origin dashboard requests are not allowed." });
  }
  if (req.method === "POST") {
    if (!origin || !allowedOrigins.includes(origin)) return json(res, 403, { error: "Dashboard actions require a same-origin browser request." });
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return json(res, 415, { error: "Dashboard actions require application/json." });
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength !== 0 || req.headers["transfer-encoding"]) return json(res, 413, { error: "Dashboard actions do not accept a request body." });
  }
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = await readFile(htmlPath, "utf8");
    const scriptHashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .map((match) => "'sha256-" + createHash("sha256").update(match[1]).digest("base64") + "'");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src " + (scriptHashes.join(" ") || "'self'") + "; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    res.end(html);
    return;
  }
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, source.getDashboardState());
  const snapshotMatch = pathname.match(/^\/api\/tx\/([a-zA-Z0-9_-]+)\/snapshot$/);
  if (req.method === "GET" && snapshotMatch) {
    if (!source.getTransactionSnapshot) return json(res, 404, { error: "Snapshot preview is unavailable." });
    try { return json(res, 200, source.getTransactionSnapshot(snapshotMatch[1])); }
    catch (error) { return json(res, 404, { error: error instanceof Error ? error.message : "Snapshot is unavailable." }); }
  }
  if (req.method === "GET" && pathname === "/api/events") {
    if (eventStreams.size >= 32) return json(res, 429, { error: "Too many dashboard event streams." });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    eventStreams.add(res);
    res.write("event: state\ndata: " + JSON.stringify(source.getDashboardState()) + "\n\n");
    const unsubscribe = source.subscribe(() => {
      if (!res.destroyed) res.write("event: state\ndata: " + JSON.stringify(source.getDashboardState()) + "\n\n");
    });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": ping\n\n"); }, 20_000);
    res.on("close", () => { clearInterval(heartbeat); unsubscribe(); eventStreams.delete(res); });
    return;
  }
  const match = pathname.match(/^\/api\/tx\/([a-zA-Z0-9_-]+)\/(approve|reject|undo)$/);
  if (req.method === "POST" && match) {
    try {
      await source.manageTransaction(match[1], match[2] as "approve" | "reject" | "undo");
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  json(res, 404, { error: "Not found." });
}

export class DashboardServer {
  private server?: Server;
  private listeningPort = 0;
  private readonly eventStreams = new Set<ServerResponse>();
  private readonly htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public/index.html");

  constructor(private readonly requestedPort: number, private readonly source: DashboardStateSource) {}

  async start(): Promise<number> {
    if (this.server) return this.listeningPort;
    const server = createServer((req, res) => {
      void handleDashboardRequest(req, res, this.source, this.htmlPath, this.listeningPort, this.eventStreams).catch((error) => {
        if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        else res.destroy();
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.requestedPort, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          this.listeningPort = typeof address === "object" && address ? address.port : this.requestedPort;
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    return this.listeningPort;
  }

  get port(): number {
    return this.listeningPort;
  }

  get url(): string {
    return "http://127.0.0.1:" + this.listeningPort;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const current = this.server;
    this.server = undefined;
    for (const stream of this.eventStreams) stream.destroy();
    this.eventStreams.clear();
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }
}
