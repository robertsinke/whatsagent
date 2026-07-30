import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPart } from '../../../shared/agent-events.js';
import { sanitizedEnv, type SpawnProcess } from '../../providers/provider.js';
import {
	buildPanelPrompt,
	MCP_SERVER_NAME,
	normalizeToolName,
	PANEL_SYSTEM_PROMPT,
	parseToolPayload,
	type PanelHarness,
	type PanelTurn
} from './harness.js';
import { streamJsonLines } from './stream-process.js';

/**
 * Claude Code's MCP config file. `${VAR}` env syntax — claude's, and different
 * from opencode's `{env:VAR}`. Both were verified working; neither accepts the
 * other's form.
 */
export function buildPanelClaudeMcpConfig(port: number): Record<string, unknown> {
	return {
		mcpServers: {
			[MCP_SERVER_NAME]: {
				type: 'http',
				url: `http://127.0.0.1:${port}/mcp`,
				headers: { Authorization: 'Bearer ${WHATSAGENT_MCP_TOKEN}' }
			}
		}
	};
}

export type ClaudePanelHarnessOptions = {
	port: number;
	token: string;
	command?: string;
	model?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	killGraceMs?: number;
	/** Tool-permitted registry action names, for `--allowedTools`. */
	allowedActions?: readonly string[];
};

/**
 * Translate `claude -p --output-format stream-json` stdout into
 * {@link AgentPart}s.
 *
 * Verified against Claude Code 2.1.220. Observed line shapes:
 *
 *   `{ type: 'assistant', message: { content: [ {type:'text'|'thinking'|'tool_use'} ] } }`
 *   `{ type: 'user', message: { content: [ {type:'tool_result', tool_use_id, content, is_error?} ] } }`
 *   `{ type: 'result', subtype: 'success', is_error }`
 *   `{ type: 'system', subtype: 'hook_started' | 'hook_response' | ... }`  ← noise
 *   `{ type: 'rate_limit_event', rate_limit_info }`
 *
 * `--tools ''` genuinely removes the built-ins: with it, the tool list was the
 * eleven `mcp__whatsagent__*` actions and nothing else — no Read, Bash, Edit,
 * Glob, Grep or WebFetch — and a decoy file in the run directory was not
 * readable. The positive control (`--tools 'Read'`, same prompt, same directory,
 * same marker) DID read it back, so the absence is the flag working rather than
 * the model declining.
 *
 * TWO HONEST CAVEATS, both machine-config dependent and neither fixable here:
 *
 * - `--allowedTools` did not narrow the advertised list. All eleven tools were
 *   listed whichever subset was named. Execution containment therefore rests on
 *   the dispatcher's caller policy, as designed — the flag is defence in depth,
 *   not the mechanism.
 * - An `advisor` tool appeared in the list, from the owner's own
 *   `~/.claude/settings.json` (`advisorModel`). `--tools ''`,
 *   `--strict-mcp-config` and `--disallowedTools advisor` all failed to remove
 *   it. It reads no files and sends no messages, but it does forward the
 *   transcript to a model, so it is a disclosure surface. `--bare` would strip
 *   hooks and plugins but forces `ANTHROPIC_API_KEY` auth and never reads the
 *   subscription login — the exact thing `sanitizedEnv` exists to prevent — so
 *   it is not an option here.
 *
 * Two structural differences from opencode, both load-bearing:
 *
 * 1. **The prompt goes on stdin, not argv.** With `-p` and stdin redirected from
 *    /dev/null, claude rejects a positional prompt outright ("Input must be
 *    provided either through stdin or as a prompt argument").
 * 2. **Tool calls and their results arrive as separate events**, so the call is
 *    emitted as `running` and correlated to its result by `tool_use_id`. The
 *    panel therefore shows the call the moment it starts, which is the point of
 *    a live trace.
 */
export class ClaudePanelHarness implements PanelHarness {
	readonly id = 'claude' as const;

	constructor(private readonly options: ClaudePanelHarnessOptions) {}

	async *run(turn: PanelTurn, signal: AbortSignal): AsyncIterable<AgentPart> {
		const configDirectory = await mkdtemp(join(tmpdir(), 'whatsagent-panel-claude-'));
		const configPath = join(configDirectory, 'mcp.json');
		await writeFile(
			configPath,
			`${JSON.stringify(buildPanelClaudeMcpConfig(this.options.port), null, 2)}\n`,
			{ mode: 0o600 }
		);

		const allowed = (this.options.allowedActions ?? []).map(
			(name) => `mcp__${MCP_SERVER_NAME}__${name}`
		);
		const args = [
			'-p',
			'--output-format',
			'stream-json',
			// Required alongside stream-json in print mode.
			'--verbose',
			// No built-in tools. Not a subset — the empty string.
			'--tools',
			'',
			// Only the MCP servers in our file; never the owner's own.
			'--strict-mcp-config',
			'--mcp-config',
			configPath,
			'--no-session-persistence'
		];
		if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
		if (this.options.model) args.push('--model', this.options.model);

		const env = sanitizedEnv(this.options.env ?? process.env, [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'OPENAI_API_KEY',
			'CODEX_API_KEY'
		]);
		env.WHATSAGENT_MCP_TOKEN = this.options.token;

		const state = newClaudeTurnState();

		try {
			for await (const event of streamJsonLines({
				command: this.options.command ?? 'claude',
				args,
				env,
				stdin: `${PANEL_SYSTEM_PROMPT}\n\n${buildPanelPrompt(turn)}\n`,
				cwd: configDirectory,
				timeoutMs: this.options.timeoutMs ?? 180_000,
				...(this.options.killGraceMs === undefined
					? {}
					: { killGraceMs: this.options.killGraceMs }),
				...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
				signal
			})) {
				for (const part of translateClaudeEvent(event, turn, state)) yield part;
			}
			// A harness that dies without emitting `result` would otherwise leave the
			// last step open, which is the stuck-shimmer failure the ledger exists to
			// prevent. Closing here covers the crash path too.
			for (const part of translateClaudeEvent({ type: 'result' }, turn, state)) yield part;
		} finally {
			await rm(configDirectory, { recursive: true, force: true });
		}
	}
}

export type ClaudeCallIndex = Map<string, { partId: string; name: string; input: unknown }>;

/**
 * Per-turn translation state. `openStep` is the load-bearing part.
 *
 * WHY A STEP LEDGER. Claude has no `step_finish` event of its own; it emits a
 * fresh `assistant` message per model turn and one `result` at the end. An
 * earlier draft opened a step per assistant message and closed one only on a
 * `tool_result`, which left the FINAL assistant message (the answer, which has
 * no tool result after it) permanently open. `groupTurns` then reported that
 * turn `inFlight` forever, so the panel header shimmered "working…" and a
 * phantom "Thinking…" sat under the finished answer for the rest of the session.
 * `agent-turn/finished` correctly cleared `running`, but the panel's `busy` is
 * `running || working` and `working` is derived from the step markers — so the
 * stuck step won.
 *
 * The rule now: exactly one step is open at a time, the next assistant message
 * closes the previous one, and `result` closes the last. Balanced by
 * construction rather than by hoping the event order cooperates.
 */
export type ClaudeTurnState = {
	calls: ClaudeCallIndex;
	openStep: string | null;
};

export function newClaudeTurnState(): ClaudeTurnState {
	return { calls: new Map(), openStep: null };
}

/**
 * One event can yield several parts (an assistant message may hold both text
 * and a tool call), so this returns an array. Exported for tests.
 */
export function translateClaudeEvent(
	event: Record<string, unknown>,
	turn: PanelTurn,
	state: ClaudeTurnState
): AgentPart[] {
	const base = { sessionId: turn.sessionId, messageId: turn.messageId };
	const { calls } = state;
	const out: AgentPart[] = [];

	/** Close the open step, if there is one. Idempotent. */
	const closeStep = (): void => {
		if (state.openStep === null) return;
		out.push({ kind: 'step-finish', ...base, partId: `${state.openStep}-end` });
		state.openStep = null;
	};

	// The turn's terminal event. Nothing renderable in it, but it is the only
	// reliable signal that the last assistant message will not be continued.
	if (event.type === 'result') {
		closeStep();
		return out;
	}

	if (event.type === 'assistant') {
		const content = contentBlocks(event);
		if (content.length > 0) {
			// A step boundary per assistant message, so the panel groups a
			// call-then-answer exchange the way it groups an opencode step.
			closeStep();
			const stepId = `${messageKey(event, turn)}-step`;
			state.openStep = stepId;
			out.push({ kind: 'step-start', ...base, partId: stepId });
		}
		for (const [index, block] of content.entries()) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text) {
				out.push({
					kind: 'text',
					...base,
					partId: `${messageKey(event, turn)}-text-${index}`,
					// Each assistant text block is complete, not a delta.
					text: block.text
				});
			} else if (block.type === 'tool_use' && typeof block.id === 'string') {
				const name = normalizeToolName(typeof block.name === 'string' ? block.name : 'tool');
				const partId = `tool-${block.id}`;
				calls.set(block.id, { partId, name, input: block.input ?? {} });
				out.push({
					kind: 'tool',
					...base,
					partId,
					name,
					input: block.input ?? {},
					// Claude emits the call before the result, so it is genuinely in
					// flight at this point — the panel shows it spinning.
					state: 'running'
				});
			}
			// `thinking` blocks are deliberately dropped: they are not an AgentPart
			// kind, the panel has nowhere to put them, and inventing a kind for them
			// would change a shipped union for a cosmetic gain.
		}
		return out;
	}

	if (event.type === 'user') {
		for (const block of contentBlocks(event)) {
			if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
			const call = calls.get(block.tool_use_id);
			if (!call) continue;
			const payload = parseToolPayload(flattenResultContent(block.content));
			const isError = block.is_error === true;
			// Same partId as the call, so `upsertAgentPart` updates that line in place
			// instead of appending a second one. Deliberately does NOT close the step:
			// the tool result sits inside the step its call opened, and the next
			// assistant message (or `result`) is what closes it.
			out.push({
				kind: 'tool',
				...base,
				partId: call.partId,
				name: call.name,
				input: call.input,
				state: isError ? 'error' : 'complete',
				...(isError ? { error: describeError(payload) } : { output: payload })
			});
		}
		return out;
	}

	// `system` / `rate_limit_event` carry nothing the panel renders.
	return out;
}

type Block = Record<string, unknown> & { type?: string };

function contentBlocks(event: Record<string, unknown>): Block[] {
	const message = event.message as Record<string, unknown> | undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is Block => Boolean(b) && typeof b === 'object');
}

/** Stable per-assistant-message key so repeated blocks upsert rather than pile up. */
function messageKey(event: Record<string, unknown>, turn: PanelTurn): string {
	const message = event.message as Record<string, unknown> | undefined;
	return typeof message?.id === 'string' ? message.id : turn.messageId;
}

/** A tool_result's `content` is a block array; the panel wants the text. */
function flattenResultContent(content: unknown): unknown {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return content;
	const texts = content
		.filter((b): b is Block => Boolean(b) && typeof b === 'object')
		.map((b) => (typeof b.text === 'string' ? b.text : ''))
		.filter(Boolean);
	return texts.length === 1 ? texts[0]! : texts.join('\n');
}

/** Same treatment as the opencode adapter: show the message, not the envelope. */
function describeError(parsed: unknown): string {
	if (parsed && typeof parsed === 'object') {
		const body = parsed as Record<string, unknown>;
		if (typeof body.error === 'string') {
			return typeof body.status === 'number' ? `${body.error} (${body.status})` : body.error;
		}
	}
	return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
}
