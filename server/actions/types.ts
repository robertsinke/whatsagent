import type { RoutesDeps } from '../api/routes.js';

/**
 * Who invoked an action. The registry declares which callers each action
 * permits; the dispatcher enforces that before parse/run. `tool` is the
 * conversational agent.
 *
 * First-class-agent principle (owner, 2026-07-30): user and agent are both
 * first-class. Any action a user can take, an agent must be able to take —
 * defined ONCE in the registry, exposed through several surfaces (UI button,
 * agent tool). The default for a new action is therefore BOTH callers
 * (`['frontend', 'tool']`). Owner-only (`frontend` alone) needs a recorded
 * reason in the action file; do not leave a conservative default without one.
 *
 * The real exception is not "the agent may not act" — it is that outbound
 * actions arrive as proposals. Outbound = anything that puts something on the
 * wire to a contact (send, react, …). For each such action:
 *   1. Keep the owner-facing action frontend-only (it enqueues / wakes the pacer).
 *   2. Add a tool-only `propose-*` counterpart that writes an inert proposal row.
 *   3. Only `confirm-proposal` (frontend-only) may enqueue the outbox row.
 * `propose-send` / `propose-reaction` are the existing instances; R9 holds
 * because no tool path reaches the outbox. Prefer that pattern over refusing
 * the agent entirely when the underlying effect is outbound.
 */
export type ActionCaller = 'frontend' | 'tool';

export type ActionContext = {
	caller: ActionCaller;
	deps: RoutesDeps;
};

/** Ad-hoc body validation failure — same shape the old handlers returned. */
export type ActionParseError = {
	ok: false;
	status: number;
	error: string;
	extra?: Record<string, unknown>;
};

export type ActionParseOk<T> = { ok: true; input: T };

export type ActionParseResult<T> = ActionParseOk<T> | ActionParseError;

/** Classic `{ error, ...extra }` HTTP error body. */
export type ActionErrorResult = {
	kind: 'error';
	status: number;
	error: string;
	extra?: Record<string, unknown>;
};

/** Successful or structured non-error JSON (including special 409 bodies). */
export type ActionJsonResult = {
	kind: 'json';
	status: number;
	body: unknown;
};

export type ActionResult = ActionErrorResult | ActionJsonResult;

/**
 * One declared mutation. `parse` lifts the handler's ad-hoc body checks
 * verbatim — no schema library. `callers` is enforced by the dispatcher,
 * never inside `run`.
 *
 * `callers` default is both surfaces — see `ActionCaller`. Narrowing to
 * `frontend` alone is a deliberate owner-only decision and must be explained
 * in the action file (one line minimum). Outbound WhatsApp effects use the
 * propose-and-confirm pattern (`propose-*` tool → owner `confirm-proposal`)
 * rather than a silent refusal when the agent needs an equivalent capability.
 */
export type ActionDefinition<TInput = unknown> = {
	name: string;
	/**
	 * Tool-facing copy. Required — an optional field rots silently across the
	 * registry; tsc is the only thing that keeps new actions honest. Imperative,
	 * ≤300 chars, 1–2 sentences. Sentence 1 states the domain effect plus the
	 * argument hint that prevents a wasted call (JID format, pagination default).
	 * Every `propose-*` ends with the verbatim tail
	 * "Writes an inert proposal the owner must confirm in the app; this tool never puts anything on the wire."
	 * Tools that cost a model call say so.
	 */
	description: string;
	callers: readonly ActionCaller[];
	parse: (raw: unknown) => ActionParseResult<TInput>;
	run: (input: TInput, ctx: ActionContext) => Promise<ActionResult> | ActionResult;
	/** Hand-authored JSON Schema literal for tool discovery (see draftResultSchema). */
	jsonSchema: Record<string, unknown>;
};

export function actionError(
	status: number,
	error: string,
	extra?: Record<string, unknown>
): ActionErrorResult {
	return extra === undefined
		? { kind: 'error', status, error }
		: { kind: 'error', status, error, extra };
}

export function actionJson(status: number, body: unknown): ActionJsonResult {
	return { kind: 'json', status, body };
}

export function parseError(
	status: number,
	error: string,
	extra?: Record<string, unknown>
): ActionParseError {
	return extra === undefined ? { ok: false, status, error } : { ok: false, status, error, extra };
}
