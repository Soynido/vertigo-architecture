/**
 * Secret redaction for anything the harness writes to a log.
 *
 * The remote MCP endpoint accepts its bearer token either in the `Authorization` header or, for connector UIs
 * that cannot send headers, as the path segment `/mcp/<token>`. Both are live credentials, so neither may ever
 * reach `.run/harness.log` — a log file is read by operators, shipped to support and kept far longer than a
 * token's useful life. Query-string carriers (`?token=`, `?access_token=`, …) are redacted too: the harness does
 * not accept them, but a misconfigured client may still send one and it would otherwise be logged verbatim.
 */

/** Query parameter names whose VALUE is always a credential. */
const SENSITIVE_QUERY_KEY = /^(?:token|access_token|refresh_token|id_token|api_key|apikey|key|bearer|auth|authorization|secret|password|passwd|pwd|sig|signature)$/i;

export const REDACTED = "<redacted>";

/** Redacts the `/mcp/<token>` path segment and every sensitive query value in a request URL. */
export function redactUrl(raw: string): string {
  const [beforeHash, ...hash] = raw.split("#");
  const withPath = (beforeHash ?? "").replace(/\/mcp\/[^/?]+/gi, "/mcp/<token>");
  const q = withPath.indexOf("?");
  const redacted = q < 0 ? withPath : `${withPath.slice(0, q)}?${withPath.slice(q + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    let decoded = key;
    try { decoded = decodeURIComponent(key); } catch { /* a malformed escape is compared raw */ }
    return SENSITIVE_QUERY_KEY.test(decoded) ? `${key}=${REDACTED}` : pair;
  }).join("&")}`;
  return hash.length > 0 ? `${redacted}#${hash.join("#")}` : redacted;
}

/**
 * Redacts credentials from free-form text (error messages, stack traces, diagnostics). Applied to anything that
 * may have been built from a URL or a header, because an upstream error commonly quotes the request it failed on.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"'`,;)\]}]+/gi, `$1${REDACTED}`)
    .replace(/((?:Authorization|Proxy-Authorization|X-Api-Key|Notion-Token)\s*[:=]\s*)[^\s"'`,;)\]}]+/gi, `$1${REDACTED}`)
    .replace(/\/mcp\/[^/?\s"'`,;)\]}]+/gi, "/mcp/<token>")
    .replace(/([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|key|bearer|auth|authorization|secret|password|passwd|pwd|sig|signature)=)[^&\s"'`,;)\]}]+/gi, `$1${REDACTED}`);
}
