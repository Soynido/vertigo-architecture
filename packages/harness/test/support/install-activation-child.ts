/**
 * One competing harness PROCESS attempting the INSTALL_PENDING → KNOWN compare-and-swap.
 *
 * Used by PT-INST-031 to prove the activation is atomic across processes, not merely across the callers of one
 * event loop. A Promise-local mutation queue would let every one of these children win.
 *
 * argv: <registryFile> <expectedAssignmentJson> <proofPlanId>
 * stdout: one JSON line { proof, won, entry }.
 */
import { FileSalesRuntimeRegistry, type InstallAssignmentSnapshot } from "../../src/registry/salesRuntimes.ts";

const [file, expectedJson, proof] = process.argv.slice(2) as [string, string, string];
const expected = JSON.parse(expectedJson) as InstallAssignmentSnapshot;
const registry = new FileSalesRuntimeRegistry(file);
try {
  const entry = await registry.activateInstallation(expected, proof);
  process.stdout.write(`${JSON.stringify({ proof, won: entry !== undefined, entry: entry ?? null })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ proof, won: false, error: (err as Error).message })}\n`);
}
