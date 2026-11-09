import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".rl4", ".cursor", ".claude", ".codex", ".vscode"]);

export async function listFiles(root: string, exts: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        out.push(join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export interface Hit { readonly file: string; readonly line: number; readonly text: string; readonly pattern: string }

export async function scan(files: readonly string[], patterns: readonly RegExp[], allow: (file: string, line: string) => boolean = () => false): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, i) => {
      for (const p of patterns) {
        if (p.test(text) && !allow(relative(REPO_ROOT, file), text)) hits.push({ file: relative(REPO_ROOT, file), line: i + 1, text: text.trim(), pattern: p.source });
      }
    });
  }
  return hits;
}
