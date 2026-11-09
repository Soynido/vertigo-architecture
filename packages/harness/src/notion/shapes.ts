/**
 * Minimal Notion REST API shapes and pure helpers used by the resolvers.
 * Only the fields the harness reads are typed; everything else stays unknown.
 */

export interface RichText {
  readonly type: "text" | "mention" | "equation";
  readonly plain_text: string;
  readonly annotations?: { readonly code?: boolean };
  readonly mention?: { readonly type: string; readonly page?: { readonly id: string } };
  readonly href?: string | null;
}

export interface Block {
  readonly id: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly [key: string]: unknown;
}

export interface BlockList {
  readonly results: readonly Block[];
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
}

export interface Page {
  readonly object?: "page";
  readonly id: string;
  readonly archived?: boolean;
  readonly in_trash?: boolean;
  readonly last_edited_time?: string;
  readonly parent?: { readonly type?: string; readonly data_source_id?: string; readonly database_id?: string; readonly page_id?: string };
  readonly properties: Readonly<Record<string, PageProperty>>;
}

export type PageProperty =
  | { readonly type: "title"; readonly title: readonly RichText[] }
  | { readonly type: "rich_text"; readonly rich_text: readonly RichText[] }
  | { readonly type: "url"; readonly url: string | null }
  | { readonly type: "email"; readonly email: string | null }
  | { readonly type: "phone_number"; readonly phone_number: string | null }
  | { readonly type: "select"; readonly select: { readonly name: string } | null }
  | { readonly type: "checkbox"; readonly checkbox: boolean }
  | { readonly type: "date"; readonly date: { readonly start: string; readonly end?: string | null } | null }
  | { readonly type: "number"; readonly number: number | null }
  | { readonly type: "unique_id"; readonly unique_id: { readonly prefix: string | null; readonly number: number } }
  | { readonly type: string; readonly [key: string]: unknown };

const HEX32 = /[0-9a-f]{32}/i;

/** Normalizes a Notion id or URL to 32 lowercase hex characters; undefined when none is present. */
export function normalizeId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/-/g, "");
  const matches = compact.match(new RegExp(HEX32.source, "gi"));
  if (!matches || matches.length === 0) return undefined;
  return (matches[matches.length - 1] as string).toLowerCase();
}

export function plainText(rich: readonly RichText[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text).join("");
}

export function mentionedPageIds(rich: readonly RichText[] | undefined): string[] {
  const ids: string[] = [];
  for (const r of rich ?? []) {
    if (r.type === "mention" && r.mention?.type === "page" && r.mention.page?.id) {
      const id = normalizeId(r.mention.page.id);
      if (id) ids.push(id);
    }
  }
  return ids;
}

export function richTextOf(block: Block): readonly RichText[] | undefined {
  const body = block[block.type];
  if (body && typeof body === "object" && "rich_text" in (body as object)) return (body as { rich_text: readonly RichText[] }).rich_text;
  return undefined;
}

export function childPageTitle(block: Block): string | undefined {
  if (block.type !== "child_page") return undefined;
  return (block["child_page"] as { title?: string } | undefined)?.title;
}

export function isHeading(block: Block): boolean {
  return block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3";
}

/** Bulleted/numbered items that follow the heading whose text equals `heading`, until the next heading. */
export function sectionItems(children: readonly Block[], heading: string): Block[] {
  const out: Block[] = [];
  let inSection = false;
  for (const b of children) {
    if (isHeading(b)) {
      inSection = plainText(richTextOf(b)).trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (inSection && (b.type === "bulleted_list_item" || b.type === "numbered_list_item")) out.push(b);
  }
  return out;
}

export interface KeyValueItem {
  readonly key: string;
  readonly value: string;
  readonly mentions: readonly string[];
}

/** Parses "Key: value" list items. The value keeps code-formatted text as plain text (no backticks). */
export function keyValueItems(items: readonly Block[]): KeyValueItem[] {
  const out: KeyValueItem[] = [];
  for (const b of items) {
    const rich = richTextOf(b);
    const text = plainText(rich);
    const idx = text.indexOf(":");
    if (idx <= 0) continue;
    out.push({ key: text.slice(0, idx).trim(), value: text.slice(idx + 1).trim(), mentions: mentionedPageIds(rich) });
  }
  return out;
}

export function propText(page: Page, name: string): string | undefined {
  const p = page.properties[name];
  if (!p) return undefined;
  switch (p.type) {
    case "title":
      return plainText((p as { title: readonly RichText[] }).title);
    case "rich_text":
      return plainText((p as { rich_text: readonly RichText[] }).rich_text);
    case "url":
      return (p as { url: string | null }).url ?? undefined;
    case "email":
      return (p as { email: string | null }).email ?? undefined;
    case "phone_number":
      return (p as { phone_number: string | null }).phone_number ?? undefined;
    case "select":
      return (p as { select: { name: string } | null }).select?.name;
    case "checkbox":
      return (p as { checkbox: boolean }).checkbox ? "true" : "false";
    case "date":
      return (p as { date: { start: string } | null }).date?.start;
    case "number": {
      const n = (p as { number: number | null }).number;
      return n === null || n === undefined ? undefined : String(n);
    }
    case "unique_id": {
      const u = (p as { unique_id: { prefix: string | null; number: number } }).unique_id;
      return `${u.prefix ? `${u.prefix}-` : ""}${u.number}`;
    }
    default:
      return undefined;
  }
}

/** Normalized, de-duplicated, sorted page ids linked by a relation property. Non-relations give an empty list. */
export function propRelationIds(page: Page, name: string): string[] {
  const p = page.properties[name];
  if (!p || p.type !== "relation") return [];
  const raw = (p as { relation?: readonly { id: string }[] }).relation ?? [];
  return [...new Set(raw.map((r) => normalizeId(r.id)).filter((id): id is string => id !== undefined))].sort();
}

export function propMentions(page: Page, name: string): string[] {
  const p = page.properties[name];
  if (!p) return [];
  if (p.type === "rich_text") return mentionedPageIds((p as { rich_text: readonly RichText[] }).rich_text);
  if (p.type === "title") return mentionedPageIds((p as { title: readonly RichText[] }).title);
  return [];
}

/** Published version pins may include the frozen `-candidate` prerelease marker used by governed adapters. */
export const VERSION_TOKEN = /\b[A-Z][A-Z_]*\/\d+\.\d+(?:\.\d+)?(?:-candidate)?\b/g;

export function versionTokens(text: string): string[] {
  return [...new Set(text.match(VERSION_TOKEN) ?? [])];
}

export function versionFamily(token: string): string {
  return token.slice(0, token.indexOf("/"));
}
