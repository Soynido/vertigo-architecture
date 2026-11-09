/**
 * Canonical serialization of a guard snapshot (Sales 0.5.11 candidate). Object keys are sorted lexicographically at
 * every level; arrays keep the order the snapshot builder gave them (rows by physical page id, predicates in
 * syntactic order); no insignificant whitespace; UTF-8; SHA-256 in lowercase hex. Only JSON types are accepted: a
 * non-finite number or an `undefined` is a builder defect and throws rather than hashing something ambiguous.
 */
import { createHash } from "node:crypto";

export type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical snapshot: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v as Canonical)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as { readonly [key: string]: Canonical };
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => {
      const v = obj[k];
      if (v === undefined) throw new Error("canonical snapshot: undefined value");
      return `${JSON.stringify(k)}:${canonicalJson(v)}`;
    }).join(",")}}`;
  }
  throw new Error("canonical snapshot: unsupported value");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export const digestOf = (value: Canonical): string => sha256Hex(canonicalJson(value));
