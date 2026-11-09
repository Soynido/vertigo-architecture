/** Frozen canonical-report format capability, not the current governing control
 * version. Changing the governing version never selects an unimplemented format. */
import { MapAdapterRegistry } from '../registry.ts';

const formats = new MapAdapterRegistry<{ kind: 'CANONICAL_REPORT' }>();
formats.register('CONTROL/1.1', { kind: 'CANONICAL_REPORT' });
export const supportedControlReportVersions = (): readonly string[] => formats.supported();
export const supportsControlReportVersion = (version: string): boolean => formats.resolve(version) !== undefined;
