/**
 * PT-CFG-001..003 — deployment configuration is re-read on every lookup, and backend-derived facts can never be
 * supplied by a caller.
 *
 * A process-lifetime cache of a configuration FILE is an authorization bug: a suspended principal, a revoked rep
 * identity or a freshly activated provisioning assignment would all stay stale until someone restarted the
 * harness. Every file-backed registry therefore re-reads on each lookup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePrincipalRegistry, type Principal } from "../../src/auth/principal.ts";
import { FileSalesRuntimeRegistry, type SalesRuntimeEntry } from "../../src/registry/salesRuntimes.ts";
import { toolInputSchemas, TOOL_NAMES } from "../../src/tools/surface.ts";
import { buildInstallWorld } from "./install-fixtures.ts";
import { bind, detail, resume, boundHandle } from "../install/drive.ts";

const REP: Principal = { principal_id: "p-cfg", status: "ACTIVE", allowed_projects: ["VERTIGO"], allowed_lanes: ["SALES"], rep_identity_key: "rep-cfg", display_name: "Cfg Rep" };

async function tempFile(name: string, body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vertigo-cfg-"));
  const file = join(dir, name);
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

test("PT-CFG-001/a: the principals file is re-read on every lookup — a suspension takes effect immediately", async () => {
  const file = await tempFile("principals.json", { principals: [REP] });
  const registry = new FilePrincipalRegistry(file);
  assert.equal((await registry.get(REP.principal_id))?.status, "ACTIVE");

  await writeFile(file, `${JSON.stringify({ principals: [{ ...REP, status: "SUSPENDED" }] }, null, 2)}\n`);
  assert.equal((await registry.get(REP.principal_id))?.status, "SUSPENDED", "the principals file was cached for the process lifetime");

  await writeFile(file, `${JSON.stringify({ principals: [] }, null, 2)}\n`);
  assert.equal(await registry.get(REP.principal_id), undefined, "a removed principal stayed resolvable");
});

test("PT-CFG-001/b: the SALES runtime registry is re-read on every lookup", async () => {
  const pending: SalesRuntimeEntry = { rep_identity_key: "rep-cfg", status: "INSTALL_PENDING", root_ref: "r", expected_instance_id: "SALESOS-CFG", pointer_generation: "1" };
  const file = await tempFile("sales-runtimes.json", { runtimes: [pending] });
  const registry = new FileSalesRuntimeRegistry(file);
  assert.equal((await registry.lookup("rep-cfg"))?.status, "INSTALL_PENDING");

  await writeFile(file, `${JSON.stringify({ runtimes: [{ ...pending, status: "KNOWN", pointer_generation: "2" }] }, null, 2)}\n`);
  const fresh = await registry.lookup("rep-cfg");
  assert.equal(fresh?.status, "KNOWN", "the runtime registry was cached for the process lifetime");
  assert.equal(fresh?.pointer_generation, "2");
});

/* ─────────────────────────── PT-CFG-002: objective_package_ref is backend-derived only ─────────────────────────── */

test("PT-CFG-002/a: objective_package_ref is reported from the backend registry as a read-only observation", async () => {
  const w = buildInstallWorld({ objectivePackageRef: "OBJPKG-FIXTURE/1" });
  const e = await bind(w);
  assert.equal(e.code, "BOUND", detail(e));
  const resumed = await resume(w, await boundHandle(w));
  assert.equal(resumed.status, "OK", detail(resumed));
  // It rides on the resolved runtime's observations, never on anything a caller supplied.
  const entry = await w.lookupRegistry();
  assert.equal(entry?.objective_package_ref, "OBJPKG-FIXTURE/1");
});

test("PT-CFG-002/b: a runtime with no backend objective package reports NOT_APPLICABLE, never a guess", async () => {
  const w = buildInstallWorld();
  assert.equal((await w.lookupRegistry())?.objective_package_ref, undefined);
  const resumed = await resume(w, await boundHandle(w));
  assert.doesNotMatch(JSON.stringify(resumed), /OBJPKG/);
});

test("PT-CFG-002/c: no tool accepts objective_package_ref (or any runtime pointer) as caller input", async () => {
  for (const name of TOOL_NAMES) {
    const keys = Object.keys(toolInputSchemas[name].shape);
    for (const forbidden of ["objective_package_ref", "root_ref", "runtime_id", "rep_identity_key", "principal_id", "pointer_generation"]) {
      assert.ok(!keys.includes(forbidden), `${name} exposes ${forbidden} as a caller-settable argument`);
    }
  }
});

test("PT-CFG-003: an objective package supplied through chat is refused at the MCP surface", async () => {
  const w = buildInstallWorld();
  const { dispatch } = await import("../../src/tools/handlers.ts");
  const e = await dispatch("os_bind", { project: "VERTIGO", lane: "SALES", objective_package_ref: "OBJPKG-ATTACKER/9" } as never, { principal_id: "p-rep-a" }, w.deps);
  assert.equal(e.status, "ERROR", detail(e));
  assert.equal(e.code, "ERROR_INVALID_ARGUMENT", detail(e));
  assert.match(detail(e), /objective_package_ref/);
});
