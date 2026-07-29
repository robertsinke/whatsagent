import type {
	ActionCaller,
	ActionContext,
	ActionDefinition,
	ActionResult
} from './types.js';
import { actionError } from './types.js';

export type ActionRegistry = ReadonlyMap<string, ActionDefinition<unknown>>;

/**
 * Resolve → caller policy → parse → run. Caller refusal happens here against
 * the action's declared `callers`, not inside `run`, so a future action cannot
 * forget the check.
 */
export async function dispatch(
	registry: ActionRegistry,
	name: string,
	raw: unknown,
	ctx: ActionContext
): Promise<ActionResult> {
	const action = registry.get(name);
	if (!action) {
		return actionError(404, 'Unknown action', { name });
	}
	if (!action.callers.includes(ctx.caller)) {
		return actionError(403, 'Caller not permitted', {
			action: name,
			caller: ctx.caller
		});
	}
	const parsed = action.parse(raw);
	if (!parsed.ok) {
		return actionError(parsed.status, parsed.error, parsed.extra);
	}
	return action.run(parsed.input, ctx);
}

export function listActionsForCaller(
	registry: ActionRegistry,
	caller: ActionCaller
): ActionDefinition<unknown>[] {
	return [...registry.values()].filter((a) => a.callers.includes(caller));
}
