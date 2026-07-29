/**
 * Agent panel event payloads shared by the server EventBus and the client
 * `applyEvent` reducer. Correlation lives inside each part (sessionId /
 * messageId / partId) — there is no separate request/response layer on the
 * WebSocket.
 *
 * Dependency-free so both the Node server and the SvelteKit client bundle can
 * import it without dragging Node built-ins into the browser.
 */

export type AgentPartBase = {
	sessionId: string;
	messageId: string;
	partId: string;
};

export type AgentTextPart = AgentPartBase & {
	kind: 'text';
	text: string;
};

/** Tool-call lifecycle a meta-agent panel can render without further lookups. */
export type AgentToolState = 'pending' | 'running' | 'complete' | 'error';

export type AgentToolPart = AgentPartBase & {
	kind: 'tool';
	name: string;
	/** Structured arguments — UI renders these directly. */
	input: unknown;
	state: AgentToolState;
	/** Present once the tool finishes successfully. */
	output?: unknown;
	/** Present when state is `error`. */
	error?: string;
};

export type AgentStepStartPart = AgentPartBase & {
	kind: 'step-start';
};

export type AgentStepFinishPart = AgentPartBase & {
	kind: 'step-finish';
};

export type AgentPart =
	| AgentTextPart
	| AgentToolPart
	| AgentStepStartPart
	| AgentStepFinishPart;

export type AgentPartKind = AgentPart['kind'];

const KNOWN_KINDS: ReadonlySet<string> = new Set([
	'text',
	'tool',
	'step-start',
	'step-finish'
]);

export function isKnownAgentPartKind(kind: string): kind is AgentPartKind {
	return KNOWN_KINDS.has(kind);
}

/**
 * Closed, typed set of pure-client UI actions. No stringly-typed method
 * dispatch — this channel can drive the UI and must not become an arbitrary
 * remote-control surface.
 */
export type ClientCommand =
	| { type: 'open-chat'; jid: string }
	| { type: 'select-reply'; messageId: string }
	| { type: 'dismiss-reply' }
	| { type: 'jump-to-quoted-message'; messageId: string };

export type AgentSessionView = {
	sessionId: string;
	parts: AgentPart[];
};

/**
 * Text accumulation rules (deliberate):
 *
 * 1. Snapshots never shrink text (monotonic by length). An out-of-order older
 *    snapshot is ignored so a late replay cannot erase newer tokens.
 * 2. A `delta` appends only when the snapshot is at least as long as the
 *    previous text and did not already advance past it — i.e. the snapshot has
 *    not absorbed this chunk, and we are not applying a delta on top of an
 *    older out-of-order snap.
 * 3. An identical delta re-delivered with an unchanged snapshot is skipped
 *    (duplicate guard).
 */
export function mergeAgentText(
	prevText: string,
	snapText: string,
	delta: string | undefined
): string {
	const snapWins = snapText.length >= prevText.length ? snapText : prevText;
	if (delta === undefined) return snapWins;
	// Snapshot already moved forward — trust it (typical streaming shape where
	// `part.text` is the full accumulated string and `delta` is informational).
	if (snapText.length > prevText.length) return snapWins;
	// Out-of-order older snapshot: keep the longer previous text; do not append.
	if (snapText.length < prevText.length) return prevText;
	// Snapshot unchanged. Skip an exact duplicate delta.
	if (delta.length > 0 && prevText.endsWith(delta)) return prevText;
	return prevText + delta;
}

/**
 * Upsert one part into a session's part list. Unknown kinds are rejected by
 * the caller before this runs; this function assumes a known {@link AgentPart}.
 */
export function upsertAgentPart(
	parts: readonly AgentPart[],
	part: AgentPart,
	delta?: string
): AgentPart[] {
	const idx = parts.findIndex((p) => p.partId === part.partId);
	const prev = idx >= 0 ? parts[idx]! : undefined;

	let next: AgentPart;
	if (part.kind === 'text') {
		const prevText = prev?.kind === 'text' ? prev.text : '';
		next = { ...part, text: mergeAgentText(prevText, part.text, delta) };
	} else if (part.kind === 'tool') {
		// Last-write-wins on tool fields so state/output/error update in place.
		const prevTool = prev?.kind === 'tool' ? prev : undefined;
		next = {
			kind: 'tool',
			sessionId: part.sessionId,
			messageId: part.messageId,
			partId: part.partId,
			name: part.name,
			input: part.input !== undefined ? part.input : (prevTool?.input ?? {}),
			state: part.state,
			...(part.output !== undefined
				? { output: part.output }
				: prevTool?.output !== undefined
					? { output: prevTool.output }
					: {}),
			...(part.error !== undefined
				? { error: part.error }
				: prevTool?.error !== undefined && part.state === 'error'
					? { error: prevTool.error }
					: {})
		};
	} else {
		next = part;
	}

	if (idx === -1) return [...parts, next];
	return parts.map((p, i) => (i === idx ? next : p));
}
