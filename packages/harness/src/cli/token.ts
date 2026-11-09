#!/usr/bin/env node
/**
 * Endpoint credentials, one per seller (PV-CRED-001).
 *
 * Until now a single token travelled in the URL path, and that URL was baked into the plugin archive. Three
 * consequences made it unshippable to a team: the archive was itself a secret, so one had to be built per person;
 * anything that quotes a URL quotes the credential, which is how Valentin's token reached a working chat on
 * 2026-09-23; and a leak could only be repaired by hand-editing a JSON file on the server.
 *
 * This mints, rotates, revokes and lists tokens instead. The raw token is printed ONCE, to stdout, and is never
 * written anywhere: the registry stores only its SHA-256, exactly as the endpoint compares it. The file is
 * replaced atomically, and FileHttpTokenRegistry fresh-reads it per request, so a rotation takes effect on the
 * next call with no restart and no window in which the old token still works.
 *
 *   node src/cli/token.ts list                       --file <registry>
 *   node src/cli/token.ts mint   <principal_id>      --file <registry>
 *   node src/cli/token.ts rotate <principal_id>      --file <registry>
 *   node src/cli/token.ts revoke <principal_id>      --file <registry>
 *
 * --file defaults to HARNESS_HTTP_TOKENS_FILE. The command refuses to write a principal that no principals file
 * declares, so a typo cannot mint a credential for a principal that will never resolve.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "../server/http.ts";

export interface TokenEntry { readonly token_sha256: string; readonly principal_id: string }

/** 32 random bytes, base64url: 43 characters, no separator a URL, a shell or a log would mangle. */
export const newToken = (): string => randomBytes(32).toString("base64url");

export function readEntries(file: string): TokenEntry[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: unknown };
  if (!Array.isArray(parsed.tokens)) throw new Error(`${file} must contain a tokens array`);
  return parsed.tokens.map((raw) => {
    const e = raw as { token_sha256?: unknown; principal_id?: unknown };
    const digest = typeof e.token_sha256 === "string" ? e.token_sha256.toLowerCase() : "";
    const principal = typeof e.principal_id === "string" ? e.principal_id.trim() : "";
    if (!/^[0-9a-f]{64}$/.test(digest) || !principal) throw new Error(`${file} entries require a 64-hex token_sha256 and a principal_id`);
    return { token_sha256: digest, principal_id: principal };
  });
}

/** Replace the registry in one atomic step: readers see the old file or the new one, never a partial write. */
export function writeEntries(file: string, entries: readonly TokenEntry[]): void {
  const tmp = join(dirname(file), `.${Date.now()}-${randomBytes(4).toString("hex")}.tokens.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ tokens: entries }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

function declaredPrincipals(principalsFile: string | undefined): readonly string[] | undefined {
  if (!principalsFile || !existsSync(principalsFile)) return undefined;
  const parsed = JSON.parse(readFileSync(principalsFile, "utf8")) as { principals?: ReadonlyArray<{ principal_id?: unknown }> };
  return Array.isArray(parsed.principals) ? parsed.principals.map((p) => String(p.principal_id ?? "")).filter(Boolean) : undefined;
}

export interface Outcome { readonly lines: readonly string[]; readonly token?: string }

/** Pure apart from the file it is given: the same inputs always produce the same registry, minus the random token. */
export function run(argv: readonly string[], env: NodeJS.ProcessEnv, mint: () => string = newToken): Outcome {
  const args = argv.filter((a) => a !== "--");
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  };
  const positional = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--") || (args[i - 1] ?? "").includes("="));
  const command = positional[0];
  const principal = positional[1];
  const file = flag("file") ?? env["HARNESS_HTTP_TOKENS_FILE"];
  if (!file) throw new Error("no registry file: pass --file <path> or set HARNESS_HTTP_TOKENS_FILE");

  const entries = readEntries(file);
  const countFor = (p: string) => entries.filter((e) => e.principal_id === p).length;

  if (command === "list") {
    const byPrincipal = new Map<string, number>();
    for (const e of entries) byPrincipal.set(e.principal_id, (byPrincipal.get(e.principal_id) ?? 0) + 1);
    const lines = [...byPrincipal].sort().map(([p, n]) => `${p}: ${n} token${n > 1 ? "s" : ""}`);
    return { lines: lines.length > 0 ? lines : ["no token is registered"] };
  }

  if (command !== "mint" && command !== "rotate" && command !== "revoke") {
    throw new Error("usage: token <list|mint|rotate|revoke> [principal_id] [--file <registry>]");
  }
  if (!principal) throw new Error(`${command} requires a principal_id`);

  const declared = declaredPrincipals(flag("principals") ?? env["PRINCIPALS_FILE"]);
  if (command !== "revoke" && declared && !declared.includes(principal)) {
    throw new Error(`principal ${principal} is not declared in the principals file: ${declared.join(", ")}`);
  }

  if (command === "revoke") {
    const before = countFor(principal);
    if (before === 0) return { lines: [`${principal} had no token; nothing changed`] };
    writeEntries(file, entries.filter((e) => e.principal_id !== principal));
    return { lines: [`revoked ${before} token${before > 1 ? "s" : ""} for ${principal}`, "the endpoint refuses them on the next call; no restart is needed"] };
  }

  // rotate = mint + drop every earlier token of that principal, in ONE atomic write, so the old credential is
  // never valid alongside the new one.
  const kept = command === "rotate" ? entries.filter((e) => e.principal_id !== principal) : entries;
  const dropped = entries.length - kept.length;
  const token = mint();
  writeEntries(file, [...kept, { token_sha256: sha256(token), principal_id: principal }]);
  const lines = [
    command === "rotate" ? `rotated ${principal}: ${dropped} earlier token${dropped === 1 ? "" : "s"} revoked in the same write` : `minted a token for ${principal}`,
    "the endpoint accepts it on the next call; no restart is needed",
    "",
    "This value is shown ONCE and is stored nowhere. Put it in the application's authentication field,",
    "not in the server URL, and never paste it into a chat, a ticket or a screenshot.",
  ];
  return { lines, token };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
if (invokedDirectly) {
  try {
    const out = run(process.argv.slice(2), process.env);
    for (const line of out.lines) console.error(line);
    if (out.token) console.log(out.token);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
