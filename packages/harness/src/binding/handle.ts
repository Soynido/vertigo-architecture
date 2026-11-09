import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque, random, non-guessable binding handle: 32 random bytes, base64url. */
export function generateHandle(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the hash is persisted. */
export function hashHandle(handle: string): string {
  return createHash("sha256").update(handle, "utf8").digest("hex");
}

export function handleMatches(handle: string, storedHash: string): boolean {
  const a = Buffer.from(hashHandle(handle), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Operational runtime generation: hash over logical identity + root identity + Manifest identity +
 * locator/registry pointer generation when available. Operational metadata, not a business attestation.
 */
export function runtimeGeneration(parts: { logicalKey: string; rootId: string; manifestId: string; pointerGeneration?: string | undefined }): string {
  const material = [parts.logicalKey, parts.rootId, parts.manifestId, parts.pointerGeneration ?? "NOT_APPLICABLE"].map((s) => `${s.length}:${s}`).join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}
