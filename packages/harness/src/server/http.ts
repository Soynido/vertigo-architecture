/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Each POST /mcp is authenticated by a bearer token whose SHA-256
 * maps to a principal_id in a deployment file; the principal is supplied by this transport layer, never by tool
 * arguments (PV0-002). Only POST is served; the harness stays read-only against Notion.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../index.ts";
import type { HarnessDeps } from "../tools/handlers.ts";
import { redactSecrets } from "./redact.ts";
import { traceHttpAuth, withHttpTrace } from "./toolTrace.ts";

export interface HttpTokenRegistry { principalFor(bearer: string): Promise<string | undefined> | string | undefined }

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** `{ "tokens": [{ "token_sha256": "<hex>", "principal_id": "p-…" }] }` — hashes only; raw tokens never live on disk. */
export class FileHttpTokenRegistry implements HttpTokenRegistry {
  readonly #source: string | ReadonlyArray<{ token_sha256: string; principal_id: string }>;
  constructor(source: string | ReadonlyArray<{ token_sha256: string; principal_id: string }>) { this.#source = source; }

  static async #entries(file: string): Promise<ReadonlyArray<{ token_sha256: string; principal_id: string }>> {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { tokens?: unknown };
    if (!Array.isArray(parsed.tokens)) throw new Error("HTTP token registry must contain a tokens array");
    const seen = new Map<string, string>();
    for (const raw of parsed.tokens) {
      if (!raw || typeof raw !== "object") throw new Error("HTTP token registry entry must be an object");
      const e = raw as { token_sha256?: unknown; principal_id?: unknown };
      const digest = typeof e.token_sha256 === "string" ? e.token_sha256.toLowerCase() : "";
      const principal = typeof e.principal_id === "string" ? e.principal_id.trim() : "";
      if (!/^[0-9a-f]{64}$/.test(digest) || !principal) throw new Error("HTTP token registry entries require a 64-hex token_sha256 and principal_id");
      const prior = seen.get(digest);
      if (prior && prior !== principal) throw new Error("HTTP token registry maps one token hash to multiple principals");
      seen.set(digest, principal);
    }
    return [...seen].map(([token_sha256, principal_id]) => ({ token_sha256, principal_id }));
  }

  static async load(file: string): Promise<FileHttpTokenRegistry> {
    // Validate once before listening, then keep the FILE as the source. principalFor fresh-reads it for every
    // request so an atomic rename rotates credentials without restarting and, critically, never caches the old one.
    await FileHttpTokenRegistry.#entries(file);
    return new FileHttpTokenRegistry(file);
  }
  async principalFor(bearer: string): Promise<string | undefined> {
    const entries = typeof this.#source === "string" ? await FileHttpTokenRegistry.#entries(this.#source) : this.#source;
    const digest = sha256(bearer);
    return entries.find((e) => e.token_sha256.toLowerCase() === digest)?.principal_id;
  }
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  // An upstream error commonly quotes the request it failed on; never echo a credential back to the caller.
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: redactSecrets(message) }, id: null }));
}

/**
 * Whether a credential may travel as the /mcp/<token> path segment (PV-CRED-001).
 *
 * It is a fallback for connector UIs with no authentication field, and it has a real cost: the URL becomes the
 * credential, so it cannot be shared, cannot be put in a plugin archive meant for a team, and leaks through
 * anything that quotes a URL. Once every application authenticates with a header, deployments set
 * HARNESS_ALLOW_PATH_TOKEN=false and the endpoint stops honouring the path entirely.
 */
export async function handleMcpRequest(deps: HarnessDeps, tokens: HttpTokenRegistry, req: IncomingMessage, res: ServerResponse, allowPathToken = true): Promise<void> {
  return withHttpTrace(req, res, async () => {
  const url = req.url ?? "";
  if (req.method !== "POST" || !url.startsWith("/mcp")) return deny(res, 405, "only POST /mcp is served");
  const auth = req.headers["authorization"] ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] ?? "" : auth)?.[1]?.trim();
  // Connector UIs without an authentication field may carry the token as the path segment /mcp/<token> (HTTPS
  // only), unless the deployment has turned that fallback off.
  const pathToken = allowPathToken ? /^\/mcp\/([A-Za-z0-9._~-]{16,})\/?(?:\?.*)?$/.exec(url)?.[1] : undefined;
  const bearerPrincipal = bearer ? await tokens.principalFor(bearer) : undefined;
  // Keep the original nullish short circuit: diagnostics do not perform an extra registry lookup.
  const pathPrincipal = bearerPrincipal == null && pathToken ? await tokens.principalFor(pathToken) : undefined;
  const principal = bearerPrincipal ?? pathPrincipal;
  traceHttpAuth(Boolean(principal), {
    bearer: bearer ? (bearerPrincipal ? "MAPPED" : "UNMAPPED") : auth ? "MALFORMED" : "ABSENT",
    path: !allowPathToken ? "DISABLED" : !pathToken ? (/^\/mcp\/?(?:\?.*)?$/.test(url) ? "ABSENT" : "MALFORMED")
      : bearerPrincipal != null ? "NOT_CHECKED" : pathPrincipal ? "MAPPED" : "UNMAPPED",
    pathEnabled: allowPathToken,
    source: principal ? (bearerPrincipal ? "BEARER" : "PATH") : "NONE",
  });
  if (!principal) return deny(res, 401, allowPathToken
    ? "unauthenticated: a token mapped to a principal is required (Authorization: Bearer <token>, or the path /mcp/<token>)"
    : "unauthenticated: a token mapped to a principal is required in the Authorization: Bearer header; this endpoint no longer accepts a token in the URL path");
  const server = createServer(deps, principal);
  // Stateless mode (no session id): each POST is an independent, authenticated MCP exchange.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true } as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(req, res);
  });
}

export async function startHttpServer(deps: HarnessDeps, tokens: HttpTokenRegistry, port: number, host = "127.0.0.1", allowPathToken = true): Promise<{ readonly port: number; close(): Promise<void> }> {
  const node = createNodeServer((req, res) => { handleMcpRequest(deps, tokens, req, res, allowPathToken).catch((err) => { if (!res.headersSent) deny(res, 500, err instanceof Error ? err.message : String(err)); else res.end(); }); });
  await new Promise<void>((resolve) => node.listen(port, host, resolve));
  const addr = node.address();
  return { port: typeof addr === "object" && addr ? addr.port : port, close: () => new Promise<void>((resolve, reject) => node.close((e) => (e ? reject(e) : resolve()))) };
}
