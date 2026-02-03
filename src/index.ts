import express, { Request, Response } from "express";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const app = express();

// Upstreams
const A = process.env.JF_UPSTREAM_A ?? "http://10.8.0.2:8096";
const B = process.env.JF_UPSTREAM_B ?? "http://10.8.0.1:8096";

// Modes
type Mode = "mirror_writes" | "mirror_all" | "failover";
const MODE: Mode = (process.env.SPLIT_MODE as Mode) ?? "mirror_writes";

type AuthMode = "passthrough" | "upstream_tokens";
const AUTH_MODE: AuthMode = ((process.env.AUTH_MODE || "upstream_tokens").toLowerCase() as AuthMode);

const TOKEN_A = process.env.JF_TOKEN_A ?? "";
const TOKEN_B = process.env.JF_TOKEN_B ?? "";

const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? "15000", 10);
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

const log = (...args: any[]) => (LOG_LEVEL === "debug" || LOG_LEVEL === "info") && console.log(...args);
const dbg = (...args: any[]) => LOG_LEVEL === "debug" && console.log(...args);

type Upstream = "A" | "B";

const MAP_PATH = process.env.USERMAP_PATH ?? "/app/user-map.json";

type UserMapFile = {
  a2b: Record<string, string>;
  b2a: Record<string, string>;
  updatedAt: string;
};

let userMap: UserMapFile = {
  a2b: {},
  b2a: {},
  updatedAt: new Date().toISOString(),
};

// Health
app.get("/health", (_req, res) => res.status(200).send("ok"));

async function loadUserMap() {
  try {
    if (!existsSync(MAP_PATH)) return;
    const raw = await readFile(MAP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.a2b && parsed?.b2a) {
      userMap = parsed;
      console.log(`[map] loaded ${Object.keys(userMap.a2b).length} users`);
    }
  } catch (e: any) {
    console.error(`[map] load failed: ${e.message}`);
  }
}

async function resolveBUserIdByName(
  aUserId: string,
  req: Request
): Promise<string | null> {
  try {
    // 1) Get user on A → Determine name
    const rA = await forward(A, "A", req, null);
    if (!rA.ok) return null;

    const aUsers = JSON.parse(rA.body.toString());
    const aUser = Array.isArray(aUsers)
      ? aUsers.find((u) => u.Id === aUserId)
      : aUsers;

    if (!aUser?.Name) return null;

    // 2) Get all users on B
    const rB = await forward(B, "B", req, null);
    if (!rB.ok) return null;

    const bUsers = JSON.parse(rB.body.toString());
    const bUser = bUsers.find((u: any) => u.Name === aUser.Name);

    if (!bUser?.Id) return null;

    // 3) Set mapping
    setUserIdMapping(aUserId, bUser.Id);
    console.log(`[map] healed A:${aUserId} → B:${bUser.Id}`);

    return bUser.Id;
  } catch (e: any) {
    console.warn(`[map] heal failed for ${aUserId}: ${e.message}`);
    return null;
  }
}

let saveLock: Promise<void> | null = null;
async function saveUserMap() {
  if (saveLock) return saveLock;
  saveLock = (async () => {
    await mkdir(dirname(MAP_PATH), { recursive: true }).catch(() => {});
    userMap.updatedAt = new Date().toISOString();
    await writeFile(MAP_PATH, JSON.stringify(userMap, null, 2));
  })().finally(() => (saveLock = null));
  return saveLock;
}

function setUserIdMapping(aId: string, bId: string) {
  userMap.a2b[aId] = bId;
  userMap.b2a[bId] = aId;
  console.log(`[map] A:${aId} <-> B:${bId}`);
  void saveUserMap();
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function logSpacer(title?: string) {
  const line = "─".repeat(80);
  if (title) {
    console.log(`\n${line}\n[${ts()}] ${title}\n${line}`);
  } else {
    console.log(`\n${line}\n`);
  }
}

function rewriteUrlForUpstream(originalUrl: string, which: "A" | "B") {
  if (which !== "B") return originalUrl;

  const [path, query] = originalUrl.split("?");

  // Do NOT rewrite for Auth/Create endpoints
  const lower = path.toLowerCase();
  if (
    lower.startsWith("/users/authenticate") ||
    lower.startsWith("/users/new") ||
    lower.startsWith("/users/public")
  ) {
    return originalUrl;
  }

  // Only rewrite for /Users/{id}/...
  const m = path.match(/^\/Users\/([^\/]+)(\/.*)$/);
  if (!m) return originalUrl;

  const aId = m[1];
  const rest = m[2] ?? "";
  const bId = userMap.a2b[aId];

  if (!bId) {
    console.warn(`[map] missing mapping for A:${aId}, attempting heal`);
    return originalUrl; // Continue as normal for now, healing happens asynchronously.
  }

  return `/Users/${bId}${rest}${query ? "?" + query : ""}`;
}

function isReadMethod(m: string) {
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

function buildXEmbyAuth(token: string) {
  const client = process.env.JF_AUTH_CLIENT ?? "Seerr";
  const device = process.env.JF_AUTH_DEVICE ?? "Seerr";
  const deviceId = process.env.JF_AUTH_DEVICEID ?? "BOT_seerr";
  const version = process.env.JF_AUTH_VERSION ?? "1.0.0";
  return `MediaBrowser Client="${client}", Device="${device}", DeviceId="${deviceId}", Version="${version}", Token="${token}"`;
}

function stripAuthHeaders(h: Record<string, string>) {
  delete h["authorization"];
  delete h["Authorization"];
  delete h["x-emby-authorization"];
  delete h["X-Emby-Authorization"];
  delete h["x-mediabrowser-authorization"];
  delete h["X-MediaBrowser-Authorization"];
  delete h["x-mediabrowser-token"];
  delete h["X-MediaBrowser-Token"];
}

function isAuthEndpoint(path: string) {
  const p = path.toLowerCase();
  return (
    p.startsWith("/users/authenticate") ||
    p.startsWith("/quickconnect") ||
    p.startsWith("/sessions")
  );
}

function hasClientAuthHeaders(h: Record<string, string>) {
  const keys = Object.keys(h).map((k) => k.toLowerCase());
  const has = (k: string) => keys.includes(k);
  return (
    has("authorization") ||
    has("x-emby-authorization") ||
    has("x-mediabrowser-authorization") ||
    has("x-emby-token") ||
    has("x-mediabrowser-token")
  );
}

function cloneHeadersForUpstream(req: Request, which: Upstream): Record<string, string> {
  const h: Record<string, string> = {};

  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") h[k] = v;
  }
  
  delete h["host"];
  delete h["accept-encoding"];
  delete h["Accept-Encoding"];

  h["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || "http";
  h["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string) || (req.headers["host"] as string) || "";
  h["x-forwarded-for"] =
    (Array.isArray(req.headers["x-forwarded-for"])
      ? req.headers["x-forwarded-for"][0]
      : req.headers["x-forwarded-for"]) ?? req.ip ?? "unknown";

  // Auth endpoints: never touch
  const authPath = isAuthEndpoint(req.path);
  const clientProvidedAuth = hasClientAuthHeaders(h);

  if (AUTH_MODE === "upstream_tokens" && !authPath) {
    // For B: always use service token (B does not know client token)
    const forceServiceToken = which === "B";

    if (forceServiceToken || !clientProvidedAuth) {
      stripAuthHeaders(h);
      const t = which === "A" ? TOKEN_A : TOKEN_B;
      if (t) {
        h["X-Emby-Authorization"] = buildXEmbyAuth(t);
        h["X-MediaBrowser-Token"] = t;
      }
    } else {
      dbg(`[auth] client auth preserved for ${req.method} ${req.path}`);
    }
  }

  return h;
}

type ResponsePayload = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

async function forward(
  base: string,
  which: Upstream,
  req: Request,
  bodyBuf: Buffer | null,
  abortSignal?: AbortSignal
): Promise<ResponsePayload> {
  const rewritten = rewriteUrlForUpstream(req.originalUrl, which);
  const url = new URL(rewritten, base).toString();
  const headers = cloneHeadersForUpstream(req, which);

  if (bodyBuf && bodyBuf.length > 0 && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    headers["content-length"] = String(bodyBuf.length);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (abortSignal) abortSignal.addEventListener("abort", () => controller.abort());

  try {
    const method = req.method.toUpperCase();
    const canHaveBody = !(method === "GET" || method === "HEAD" || method === "OPTIONS");

    const r = await fetch(url, {
      method,
      headers,
      body: canHaveBody && bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    const buf = Buffer.from(await r.arrayBuffer());
    clearTimeout(timeout);

    const outHeaders: Record<string, string> = {};
    const SKIP = new Set([
      "transfer-encoding", "connection", "keep-alive",
      "proxy-authenticate", "proxy-authorization",
      "te", "trailers", "upgrade",
      // important: prevents gzip header/body mismatch
      "content-encoding",
      "content-length",
    ]);

r.headers.forEach((v, k) => {
  if (SKIP.has(k.toLowerCase())) return;
  outHeaders[k] = v;
});

    return { ok: true, status: r.status, headers: outHeaders, body: buf };
  } catch (e: any) {
    clearTimeout(timeout);
    return {
      ok: false,
      status: 502,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`upstream ${which} error: ${e?.message || String(e)}`),
    };
  }
}

// Read body as buffer + routing
app.all("*", async (req: Request, res: Response) => {
  if (req.path === "/health") return res.status(200).send("ok");

  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req.on("end", async () => {
    const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;

    const authPath = isAuthEndpoint(req.path);
    const isCreateUser = req.method === "POST" && req.path === "/Users/New";

    if (LOG_LEVEL === "debug") {
      logSpacer(`${req.method} ${req.originalUrl}${authPath ? " [AUTH]" : ""}`);
    }

    const shouldMirror =
      !authPath &&
      (MODE === "mirror_all" || (MODE === "mirror_writes" && !isReadMethod(req.method)));

    if (MODE === "failover") {
      const rA = await forward(A, "A", req, bodyBuf);
      if (rA.ok && rA.status < 500) {
        res.status(rA.status);
        for (const [k, v] of Object.entries(rA.headers)) res.setHeader(k, v);
        return res.send(rA.body);
      }
      const rB = await forward(B, "B", req, bodyBuf);
      res.status(rB.status);
      for (const [k, v] of Object.entries(rB.headers)) res.setHeader(k, v);
      return res.send(rB.body);
    }

    // Answer comes from A
    const pA = forward(A, "A", req, bodyBuf);

    // Mirror to B best effort
    let pB: Promise<ResponsePayload> | null = null;
    if (shouldMirror) {
      // Self-heal mapping before mirror to B
      if (
        shouldMirror &&
        req.path.startsWith("/Users/") &&
        !isAuthEndpoint(req.path)
      ) {
        const m = req.path.match(/^\/Users\/([^\/]+)/);
        if (m) {
          const aId = m[1];
          if (!userMap.a2b[aId]) {
            await resolveBUserIdByName(aId, req);
          }
        }
      }

      pB = forward(B, "B", req, bodyBuf).then((r) => {
        if (!r.ok || r.status >= 400) dbg(`→ [B] ${req.method} ${req.originalUrl} -> ${r.status}`);
        return r;
      });
    }

    const rA = await pA;
    log(`→ [A] ${req.method} ${req.originalUrl} -> ${rA.status} ${shouldMirror ? "(mirrored)" : ""}`);

    res.status(rA.status);
    for (const [k, v] of Object.entries(rA.headers)) res.setHeader(k, v);
    res.send(rA.body);

        // Mapping after successful creation
    if (pB && isCreateUser) {
      try {
        const rB = await pB;
        if (rA.ok && rB.ok && rA.status < 400 && rB.status < 400) {
          const aJson = JSON.parse(rA.body.toString());
          const bJson = JSON.parse(rB.body.toString());
          if (aJson?.Id && bJson?.Id) {
            setUserIdMapping(aJson.Id, bJson.Id);
          }
        }
      } catch (e: any) {
        console.warn(`[map] create parse failed: ${e.message}`);
      }
    }

    if (pB && LOG_LEVEL === "debug") await pB;
  });

  req.on("error", (err) => res.status(500).send(`request read error: ${String(err)}`));
});


async function main() {
  await loadUserMap();

  app.listen(8095, "0.0.0.0", () => {
    console.log(`    __ _____     _____     _ _ _   _                         ┏━━━ Jellyfin A: ${A}`);
    console.log(` __|  |   __|___|   __|___| |_| |_| |_ ___ ___     ━━━━━━━━━━┫`);
    console.log(`|  |  |   __|___|__   | . | | |  _|  _| -_|  _|              ┗━━━ Jellyfin B: ${B}`);
    console.log(`|_____|__|      |_____|  _|_|_|_| |_| |___|_|  `);
    console.log(`                      |_|  `);
    console.log(`                              listening on 0.0.0.0:8095`);
    console.log(`MODE = ${MODE}`);
    console.log(`AUTH_MODE=${AUTH_MODE}`);
    console.log(` `);
  });
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});