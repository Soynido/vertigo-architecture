// Regenerate the code-derived catalogue. This reads a module of constant grammar
// definitions; it does not load runtime configuration or call Notion.
import fs from 'node:fs';
import * as grammar from '../packages/harness/src/versions/adapters/controlPlane.ts';
const variants=Object.entries(grammar)
 .filter(([key,value])=>key.includes('CONTROL_PLANE')&&value&&typeof value==='object')
 .map(([key,value])=>({export_name:key,evidence:'CODE_DERIVED_NOT_LIVE_SCHEMA',install_resources:value.installContract?.physicalResources??[],logical_resources:value.resources??{},journal_properties:{runs:value.runProps??null,ledger:value.ledgerProps??null,write:value.writeProps??null},control_plane_parent:value.parentTitle??null}));
const out=new URL('../notion/derived/control-plane-grammars.json',import.meta.url);
fs.writeFileSync(out,JSON.stringify({kind:'CODE_DERIVED_NOTION_GRAMMARS/1',prepared_on:'2026-11-09',source:'packages/harness/src/versions/adapters/controlPlane.ts',production_adoption:'NOT_ASSERTED',variants},null,2)+'\n');
console.log(JSON.stringify({variants:variants.length,network_requests:0}));
