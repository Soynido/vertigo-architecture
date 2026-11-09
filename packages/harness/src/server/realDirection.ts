import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { realDirectionToolInput, type RealDirectionControl } from '../verify/realDirectionControl.ts';
import { beginNativeToolTrace, finishNativeToolTrace } from './toolTrace.ts';

export const realDirectionInstructions =
    'Real recipient-scoped META direction is enabled only for the configured accounts. ' +
    'For an owner request only to read an existing direction, use STATUS with its known recipient key (omit recipient for all configured recipients). It already returns the exact published body after fresh native proof plus separate receipt state: answer from this one observation, without general META CONTEXT or seller CONTEXT. Owner CONTEXT is not supported. ' +
    'Publication time is publication_completed_at (native Run Finished, UTC minute precision); approved_at is the separate owner validation time, not publication. ' +
    'The owner uses PREPARE to show the exact recipient, objective, horizon and recommendations, then APPROVE only after the human explicitly validates that exact proposal. ' +
    'Never transfer an approval to a different proposal; reuse an already attested approval only for the same immutable proposal during retry/resume, without asking again. A Notion label or general enthusiasm is not validation. Approval is a session attestation, not a cryptographically verified human click. ' +
    'Native Notion performs only the returned targeted writes with fresh schema, key lookup and readback, followed by VERIFY in the same turn. Never overwrite a conflicting or duplicate record. ' +
    'This is the dedicated META_ORIENTATION/1.0 contract: complete the ordered native Run/Ledger/Definition/personal package/Decision/pointer-last phases, then VERIFY until PUBLISHED, without a new user prompt for the same approved transaction. A pending write plan or ORIENTATION_NATIVE_VERIFIED alone is not the final published reply. Never claim global CONTROL or G11 confirmation, change their state, or modify existing Sales controls. If a precondition fails, stop only this orientation and explain the concrete blocked action. ' +
    'Sales CONTEXT loads only this recipient’s published direction; preserve local methods, targets, permissions and history. ' +
    'CONSUME prepares its control acknowledgement; create only the absent exact local receipt, read it back and VERIFY_CONSUMPTION in the same turn. ' +
    'A missing or expired direction does not block independent authorized work. A loaded direction or receipt is not a business result, new sending permission or automatic policy adoption. ' +
    'No private META sources or another seller’s data belong in a recipient reply. Explain the useful next action in ordinary French, not a technical protocol. No background execution promise.';

export function registerRealDirectionTool(server: McpServer, control: RealDirectionControl, principalId: string) {
    server.registerTool('vertigo_direction_control', {
        description: 'Orientation réelle META/Sales. Lecture propriétaire : STATUS avec recipient connu si une personne est demandée ; sans recipient pour tous. Retourne déjà le contenu publié exact vérifié nativement et sa réception distincte : aucun second CONTEXT nécessaire (CONTEXT est vendeur uniquement). Le propriétaire prépare puis atteste la validation exacte ; publication seulement après relecture indépendante. Le vendeur charge sa propre version et vérifie son reçu local. Cibles fixes côté serveur, aucune règle locale ou autorité externe modifiée. Pas le pilote fictif.',
        inputSchema: realDirectionToolInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async input => {
        const trace = beginNativeToolTrace('vertigo_direction_control', principalId, input.action);
        let result: Awaited<ReturnType<RealDirectionControl['run']>>;
        try {
            result = await control.run(principalId, input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: result.status === 'ACCESS_DENIED' || result.status === 'INVALID_ARGUMENT' };
        } finally {
            finishNativeToolTrace(trace, result ?? { status: 'UNCONFIRMED', reason: 'SOURCE_OR_JOURNAL_UNAVAILABLE' });
        }
    });
}
