/**
 * The skill ships WITH the plugin (PV0-020B): the harness serves it as MCP server `instructions` at initialize, as
 * the prompt `vertigo_skill` and as the resource `vertigo://skill`. Nothing has to be pasted into a chat.
 *
 * W3.4: this BUILD TARGET server announces five tools, so by default it serves the short candidate instructions,
 * packages/plugin/SKILL.candidate.md. packages/plugin/SKILL.md stays the historical LIVE six-tool canon and is never
 * served implicitly. An explicit HARNESS_SKILL_FILE still overrides the default. A missing or empty file fails closed:
 * there is no built-in fallback, because the only text one could embed here is the retired six-tool choreography.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The candidate instructions this server serves by default, resolved identically from src and from dist. */
export const CANDIDATE_SKILL_PATH = fileURLToPath(new URL("../../../plugin/SKILL.candidate.md", import.meta.url));

/** The file this process serves: the explicit override, else the candidate. Never the LIVE SKILL.md by default. */
export function skillPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["HARNESS_SKILL_FILE"] || CANDIDATE_SKILL_PATH;
}

let cached: { readonly path: string; readonly text: string } | undefined;
export function loadSkill(env: NodeJS.ProcessEnv = process.env): string {
  const path = skillPath(env);
  if (cached?.path === path) return cached.text;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`skill instructions unavailable at ${path}; refusing to serve without them (no fallback)`);
  }
  if (!text.trim()) throw new Error(`skill instructions empty at ${path}; refusing to serve without them (no fallback)`);
  cached = { path, text };
  return text;
}
