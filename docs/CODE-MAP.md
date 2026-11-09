# Carte du code

Les liens visent la copie auditable et ses lignes, pas la machine de l’opérateur.
Les transformations sont décrites dans le manifeste de provenance.

| Question / responsabilité | Source |
|---|---|
| Sélection du parcours par profil authentifié | [index.ts](../packages/harness/src/index.ts#L160) |
| Authentification HTTP | [http.ts](../packages/harness/src/server/http.ts#L1) |
| Identités et registre | [principal.ts](../packages/harness/src/auth/principal.ts#L1) |
| Surface MCP Sales native | [nativeSales.ts](../packages/harness/src/server/nativeSales.ts#L9) |
| CONTEXT / VERIFY_RECEIPT / REPORT_STEP | [nativeSalesControl.ts](../packages/harness/src/verify/nativeSalesControl.ts#L13) |
| Protocole technique compatible servi | [nativeSalesRuntime.ts](../packages/harness/src/server/nativeSalesRuntime.ts#L1) |
| Surface native propriétaire | [nativePilot.ts](../packages/harness/src/server/nativePilot.ts#L1) |
| Contrôles META et contexte borné | [nativeMetaControl.ts](../packages/harness/src/verify/nativeMetaControl.ts#L1) |
| Projection des sources META | [nativeMetaContext.ts](../packages/harness/src/verify/nativeMetaContext.ts#L1) |
| Observation passive, pas surveillance | [passiveSalesActivity.ts](../packages/harness/src/verify/passiveSalesActivity.ts#L21) |
| Orientation validée et réception | [realDirectionControl.ts](../packages/harness/src/verify/realDirectionControl.ts#L30) |
| Relectures et journal séparé | [realDirectionPublication.ts](../packages/harness/src/verify/realDirectionPublication.ts#L14) |
| Traces techniques à champs fermés | [toolTrace.ts](../packages/harness/src/server/toolTrace.ts#L60) |
| Grammaires Notion versionnées | [controlPlane.ts](../packages/harness/src/versions/adapters/controlPlane.ts#L470) |
| Catalogue cinq outils candidat | [surface.ts](../packages/harness/src/tools/surface.ts#L1) |
| Transaction serveur candidate | [commit.ts](../packages/harness/src/transactions/commit.ts#L1) |
| Archive plugin et identité de paquet | [build-archive.mjs](../packages/plugin/scripts/build-archive.mjs#L1) |
| Préservation du paquet existant | [prepare-sales-bootstrap.mjs](../packages/plugin/scripts/prepare-sales-bootstrap.mjs#L1) |

## Compétences et tests

- [Compétences et provenance](../skills/README.md).
- [Tests Sales natif](../packages/harness/test/unit/pv-native-sales-control.test.ts).
- [Tests orientation](../packages/harness/test/unit/pv-real-direction-control.test.ts).
- [Tests de preuve native](../packages/harness/test/unit/pv-real-direction-native-plan.test.ts).
- [Tests d’activité passive](../packages/harness/test/unit/passive-sales-activity.test.ts).
- [Tests de journalisation](../packages/harness/test/unit/tool-trace.test.ts).
- [Tests de construction du paquet](../packages/plugin/test/native-sales-bootstrap-package.test.mjs).
- [Résultats exécutés pour cette revue](../verification/README.md).

Le paquet mail-executor et le noyau candidat sont conservés pour l’audit de leurs
invariants ; leur présence ne démontre pas leur activation dans le circuit hybride.
