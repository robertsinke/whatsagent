import { isRefinementIntent } from '../providers/provider.js';
import type { ActionDefinition } from './types.js';
import { actionError, actionJson, parseError } from './types.js';

export type RefineDraftInput = {
	chatJid: string;
	intent: import('../providers/provider.js').RefinementIntent;
	text?: string;
};

export const refineDraftAction: ActionDefinition<RefineDraftInput> = {
	name: 'refine-draft',
	callers: ['frontend', 'tool'],
	jsonSchema: {
		type: 'object',
		properties: {
			chatJid: { type: 'string' },
			intent: {
				type: 'string',
				enum: ['regenerate', 'shorter', 'longer', 'more_formal', 'less_formal']
			},
			text: { type: 'string' }
		},
		required: ['chatJid', 'intent'],
		additionalProperties: false
	},
	parse(raw: unknown) {
		const body = raw as { chatJid?: unknown; intent?: unknown; text?: unknown } | undefined;
		if (typeof body?.chatJid !== 'string' || !body.chatJid) {
			return parseError(400, 'Expected { chatJid, intent }');
		}
		if (!isRefinementIntent(body.intent)) {
			return parseError(400, 'Invalid refinement intent');
		}
		if (body.text !== undefined && typeof body.text !== 'string') {
			return parseError(400, 'Expected text to be a string');
		}
		return {
			ok: true,
			input: {
				chatJid: body.chatJid,
				intent: body.intent,
				...(body.text !== undefined ? { text: body.text } : {})
			}
		};
	},
	async run(input, ctx) {
		if (!ctx.deps.refineDraft) {
			return actionError(503, 'Draft refinement unavailable');
		}
		const result = await ctx.deps.refineDraft({
			chatJid: input.chatJid,
			intent: input.intent,
			preview: input.text,
			// PL-U3: a refinement rewrites the draft, so the owner has to be able
			// to see whose idea it was when the approval hash stops matching.
			requestedBy: ctx.caller === 'tool' ? 'agent' : 'owner'
		});
		if (result.kind === 'ready') {
			return actionJson(200, result.draft);
		}
		if (result.kind === 'not_found') {
			return actionError(404, 'Draft not found');
		}
		if (result.kind === 'not_refinable') {
			return actionError(409, 'Draft is not refinable', { status: result.status });
		}
		if (result.kind === 'invalid_preview') {
			return actionError(400, 'Empty draft text');
		}
		if (result.kind === 'superseded') {
			return actionError(409, 'Draft changed during refinement');
		}
		return actionError(result.code === 'rate_limit' ? 429 : 502, 'Draft refinement failed', {
			code: result.code
		});
	}
};
