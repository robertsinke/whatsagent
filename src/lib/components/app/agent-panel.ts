/**
 * Rendering decisions for `AgentPanel.svelte`, kept out of the component so the
 * rules are testable without a DOM (the same split `message-runs.ts` /
 * `draft-panel.ts` use). Everything here is a pure function of the already-
 * accumulated `agentSessions` state — it never touches the wire and never
 * defers work to a later paint.
 *
 * The panel renders agent sessions as a sequence of TURNS, where a turn is a
 * run of parts bounded by `step-start` / `step-finish` markers (or the session
 * start/end when no markers are present). Text parts stream into prose inside a
 * turn; tool parts render as a compact, legible line each — the tool trace IS
 * the interesting output for a meta agent whose job is taking actions, so it
 * must read like "opened Boris chat, generated a draft, shortened it" as it
 * happens, not a wall of raw JSON and not a spinner that hides what is
 * happening.
 */

import type {
	AgentPart,
	AgentToolPart,
	AgentToolState
} from '../../../../shared/agent-events.js';

/**
 * One renderable turn: the parts between two `step-start`/`step-finish`
 * markers. Parts with no surrounding markers land in a single turn keyed by
 * the session — the common case while the dev emitter (and the eventual
 * runtime) always wraps a turn in markers.
 */
export type AgentTurn = {
	id: string;
	parts: AgentPart[];
	/** True until a matching `step-finish` has been seen. */
	inFlight: boolean;
};

/**
 * Group a session's flat part list into turns. A `step-start` opens a new turn;
 * a `step-finish` closes the current one; any part outside a step lands in a
 * synthetic leading turn so it is never dropped. Part order is preserved.
 */
export function groupTurns(parts: readonly AgentPart[]): AgentTurn[] {
	const turns: AgentTurn[] = [];
	let current: AgentTurn | null = null;
	let stray: AgentPart[] = [];

	for (const part of parts) {
		if (part.kind === 'step-start') {
			// Flush any stray parts collected before this step into their own turn
			// so they are not silently merged into the step that follows.
			if (stray.length > 0) {
				turns.push({ id: `stray-${stray[0]!.partId}`, parts: stray, inFlight: false });
				stray = [];
			}
			current = { id: part.partId, parts: [], inFlight: true };
			turns.push(current);
			continue;
		}
		if (part.kind === 'step-finish') {
			if (current) {
				current.inFlight = false;
				current = null;
			} else {
				// A finish with no open step — render it as a closed stray turn so
				// the boundary is visible rather than swallowed.
				turns.push({ id: part.partId, parts: [part], inFlight: false });
			}
			continue;
		}
		if (current) {
			current.parts.push(part);
		} else {
			stray.push(part);
		}
	}

	if (stray.length > 0) {
		turns.push({ id: `stray-${stray[0]!.partId}`, parts: stray, inFlight: false });
	}
	return turns;
}

/**
 * The concise, human label for a tool call's lifecycle state — what the panel
 * shows next to the tool name. A pending/running tool is "happening now"; a
 * complete tool shows its result; an errored tool shows its error. Never raw
 * JSON state.
 */
export function toolStateLabel(state: AgentToolState): string {
	switch (state) {
		case 'pending':
			return 'queued';
		case 'running':
			return 'running';
		case 'complete':
			return 'done';
		case 'error':
			return 'failed';
		default:
			return state;
	}
}

/**
 * A one-line summary of a tool call's argument, for the compact line. Picks the
 * single most legible scalar from a structured input (the chat name / jid / id
 * an action targets) rather than dumping the whole object. Falls back to an
 * empty string when there is nothing concise to show — the name + state label
 * already carry the call.
 */
export function toolArgSummary(input: unknown): string {
	if (input === null || input === undefined) return '';
	if (typeof input === 'string') return input;
	if (typeof input === 'number' || typeof input === 'boolean') return String(input);
	if (typeof input === 'object') {
		const obj = input as Record<string, unknown>;
		// Prefer the field a reader actually cares about for a meta agent acting
		// on the shell: the chat / message a tool targets. `name` covers draft-
		// shaping tools whose input names the intent.
		for (const key of [
			'jid',
			'chat',
			'chatJid',
			'messageId',
			'id',
			'name',
			'intent',
			'opened',
			'result',
			'text'
		]) {
			const v = obj[key];
			if (typeof v === 'string' && v.length > 0) return v;
		}
		return '';
	}
	return '';
}

/**
 * Render a tool call's result as a short string, available on the compact line
 * or beneath it. Prefers a single legible scalar from a structured output
 * (mirroring {@link toolArgSummary}); falls back to empty so a complete tool
 * with no concise result just shows its name + "done" and stays quiet. An error
 * state always surfaces its `error` string — never swallowed.
 */
export function toolResultSummary(tool: AgentToolPart): string {
	if (tool.state === 'error') return tool.error ?? 'error';
	if (tool.state !== 'complete') return '';
	return toolArgSummary(tool.output);
}

/**
 * True when any part of a turn is still streaming — a text part whose session
 * has not seen a closing `step-finish`, or a tool in `pending`/`running`
 * state. Drives the Shimmer affordance on the turn (and on the panel header).
 */
export function isTurnInFlight(turn: AgentTurn): boolean {
	if (turn.inFlight) return true;
	return turn.parts.some(
		(p) => p.kind === 'tool' && (p.state === 'pending' || p.state === 'running')
	);
}

/**
 * Whether the panel should show its empty state. No session yet is the normal
 * resting state, not an error — the agent is idle until something asks it to
 * act. A session whose every turn is closed is NOT empty: it shows the
 * completed trace.
 */
export function hasActiveSessions(
	agentSessions: Record<string, { parts: AgentPart[] }>
): boolean {
	return Object.keys(agentSessions).length > 0;
}

/**
 * PANEL-S1 — the empty-state copy, chosen from the two boot-time facts in
 * `AgentStatus`.
 *
 * A pure function rather than markup branches because the copy IS the feature
 * here: the shipped version told the owner to "start the app with
 * WHATSAGENT_MCP=1", an instruction a double-clicked `.app` cannot receive and
 * which would not have been sufficient anyway. Three states, three answers,
 * asserted in a test instead of eyeballed.
 *
 * `placeholder` is the disabled composer's, and is deliberately a different
 * length register from `title` — it sits inside a one-line field.
 */
export type PanelEmptyState = {
	/** Stable id for tests and `data-` attributes; never rendered. */
	state: 'idle' | 'restart-required' | 'not-configured';
	title: string;
	body: string;
	placeholder: string;
};

export function panelEmptyState(status: {
	available: boolean;
	restartRequired: boolean;
}): PanelEmptyState {
	if (status.available) {
		return {
			state: 'idle',
			title: 'Agent is idle',
			body: 'Ask for something below — open a chat, draft a reply, make it shorter. Tool calls and reasoning stream here as they happen.',
			placeholder: 'Ask the agent to do something…'
		};
	}
	if (status.restartRequired) {
		return {
			state: 'restart-required',
			title: 'Restart to start the agent panel',
			body: 'The panel is switched on in Settings → Agent, but this app was started without it. Quit and reopen WhatsAgent to load it.',
			placeholder: 'Restart to start the agent panel'
		};
	}
	return {
		state: 'not-configured',
		title: 'Agent panel is off',
		body: 'Turn it on in Settings → Agent and pick a harness. It can read your chats and draft replies for you; it can never send.',
		placeholder: 'Enable the agent panel in Settings'
	};
}