import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPart } from '../../../shared/agent-events.js';
import {
	disabledInheritedMcp,
	OPENCODE_BUILTIN_TOOLS_OFF,
	readUserOpenCodeMcpNames
} from '../../providers/opencode-config.js';
import { normalizeOpenCodeModel } from '../../providers/opencode.js';
import { sanitizedEnv, type SpawnProcess } from '../../providers/provider.js';
import {
	buildPanelPrompt,
	MCP_SERVER_NAME,
	normalizeToolName,
	PANEL_SYSTEM_PROMPT,
	parseToolPayload,
	toToolState,
	type PanelHarness,
	type PanelTurn
} from './harness.js';
import { streamJsonLines } from './stream-process.js';

/**
 * The panel's opencode config is the **INVERSE** of the drafting one, and they
 * must not be unified.
 *
 *   drafting (`buildOpenCodeEmptyToolsConfig`): no `mcp` block at all,
 *                                              `permission: { '*': 'deny' }`
 *   panel    (here):                           `mcp.whatsagent` mounted,
 *                                              `permission: { '*': 'deny',
 *                                                             'whatsagent*': 'allow' }`
 *
 * What they share is exactly two mechanical things, imported rather than copied:
 * the thirteen-key builtin-off block and the inherited-globals disable list.
 * Built-in tools stay false here too — the panel needs OUR tools and still no
 * bash, no read, no write, no webfetch.
 *
 * Verified against the real surface (opencode 1.18.9):
 * - The 11 tool-permitted registry actions appeared as `whatsagent_<name>` and
 *   the kebab case survived, so the prefix strip lands on the registry name.
 * - A decoy file in the run directory was NOT readable, and the positive
 *   control (default tools, `permission: { '*': 'allow' }`) DID return its
 *   marker — so the negative is a real absence of the tool, not a shy model.
 * - With no disable block, every MCP server from the developer's own user config
 *   was injected even under `--pure`, each appearing in the tool list under its
 *   own `<server>_*` prefix. `--pure` means "without external plugins", not
 *   "without the user config" — it logs loading every user config path. The
 *   server names are not reproduced here on purpose; see the note in
 *   `server/providers/opencode-config.ts`.
 *
 * The bearer token goes in as `{env:...}` rather than a literal, which opencode
 * also accepts: a literal would write an account-adjacent credential to disk.
 */
export function buildPanelOpenCodeConfig(options: {
	port: number;
	env?: NodeJS.ProcessEnv;
	home?: string;
	readFile?: (path: string) => string;
}): Record<string, unknown> {
	const inherited = readUserOpenCodeMcpNames({
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.readFile === undefined ? {} : { readFile: options.readFile })
	});
	return {
		$schema: 'https://opencode.ai/config.json',
		mcp: {
			// Inherited servers first, so a `whatsagent` key in the owner's own config
			// cannot shadow ours below.
			...disabledInheritedMcp(inherited, [MCP_SERVER_NAME]),
			[MCP_SERVER_NAME]: {
				type: 'remote',
				url: `http://127.0.0.1:${options.port}/mcp`,
				enabled: true,
				oauth: false,
				headers: { Authorization: `Bearer {env:WHATSAGENT_MCP_TOKEN}` }
			}
		},
		permission: { '*': 'deny', [`${MCP_SERVER_NAME}*`]: 'allow' },
		tools: { ...OPENCODE_BUILTIN_TOOLS_OFF }
	};
}

export type OpenCodePanelHarnessOptions = {
	/** Port the app's own server (and therefore `/mcp`) is listening on. */
	port: number;
	/** MCP bearer token from `app.mcp.token`. */
	token: string;
	command?: string;
	model?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnProcess;
	killGraceMs?: number;
};

/**
 * Translate `opencode run --format json` stdout into {@link AgentPart}s.
 *
 * The observed line shape is `{ type, timestamp, sessionID, part }` where
 * `part.type` is one of `step-start` | `text` | `tool` | `step-finish`, and:
 *
 *   text: `part.text` is the FULL accumulated string, not a delta. So no
 *         `delta` is emitted — `mergeAgentText` treats a snapshot as
 *         authoritative and monotonic, which is exactly right here.
 *   tool: `part.tool` is the prefixed name, `part.callID` identifies the call,
 *         and `part.state` carries `{ status, input, output?, error? }`.
 *         Statuses observed: `completed`, `error`.
 *
 * `part.id` is used as the partId so a re-emitted part updates in place through
 * `upsertAgentPart`. Session and message ids come from OUR turn, not from
 * opencode's — the panel groups by them and they must be stable across
 * harnesses.
 */
export class OpenCodePanelHarness implements PanelHarness {
	readonly id = 'opencode' as const;

	constructor(private readonly options: OpenCodePanelHarnessOptions) {}

	async *run(turn: PanelTurn, signal: AbortSignal): AsyncIterable<AgentPart> {
		const configDirectory = await mkdtemp(join(tmpdir(), 'whatsagent-panel-opencode-'));
		await writeFile(
			join(configDirectory, 'opencode.json'),
			`${JSON.stringify(
				buildPanelOpenCodeConfig({
					port: this.options.port,
					...(this.options.env === undefined ? {} : { env: this.options.env })
				}),
				null,
				2
			)}\n`,
			{ mode: 0o600 }
		);

		// `--auto` is mandatory: without it the harness waits on an approval
		// prompt and a headless run simply hangs. `--pure` skips external plugins.
		// `opencode run`, never `serve` + `--attach` — attach returns incomplete
		// turns (PL-S3, reproduced twice).
		const args = ['run', '--auto', '--pure', '--format', 'json', '--dir', configDirectory];
		if (this.options.model) args.push('-m', normalizeOpenCodeModel(this.options.model));
		// Prompt is argv, never shell-interpolated.
		args.push(`${PANEL_SYSTEM_PROMPT}\n\n${buildPanelPrompt(turn)}`);

		const env = sanitizedEnv(this.options.env ?? process.env, [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'OPENAI_API_KEY',
			'CODEX_API_KEY'
		]);
		env.WHATSAGENT_MCP_TOKEN = this.options.token;
		const state = newOpenCodeTurnState();

		try {
			for await (const event of streamJsonLines({
				command: this.options.command ?? 'opencode',
				args,
				env,
				// Empty but still closed — `opencode run` does not start until EOF.
				stdin: '',
				cwd: configDirectory,
				timeoutMs: this.options.timeoutMs ?? 180_000,
				...(this.options.killGraceMs === undefined
					? {}
					: { killGraceMs: this.options.killGraceMs }),
				...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
				signal
			})) {
				const part = translateOpenCodeEvent(event, turn, state);
				if (part) yield part;
			}
		} finally {
			await rm(configDirectory, { recursive: true, force: true });
		}
	}
}

/**
 * Per-turn counter for the partId fallback. See {@link translateOpenCodeEvent}.
 */
export type OpenCodeTurnState = { seq: number };

export function newOpenCodeTurnState(): OpenCodeTurnState {
	return { seq: 0 };
}

/**
 * Exported for tests — the translation is the unit worth pinning.
 *
 * THE PARTID FALLBACK MUST BE UNIQUE. `part.id` is present in every captured
 * event, but an absent one used to fall back to
 * `${messageId}-${part.type}` — which is the SAME string for every tool call in
 * a turn. `upsertAgentPart` is last-write-wins on partId, so two tool calls
 * would have collapsed into one rendered line and a call the agent actually made
 * would silently vanish from the trace. The tool trace is the product, so a
 * dropped call is the expensive failure. `part.callID` is per-call and is used
 * first; a monotonic counter covers step markers, which have neither id.
 */
export function translateOpenCodeEvent(
	event: Record<string, unknown>,
	turn: PanelTurn,
	state: OpenCodeTurnState = newOpenCodeTurnState()
): AgentPart | null {
	const part = event.part as Record<string, unknown> | undefined;
	if (!part || typeof part !== 'object') return null;
	const fallbackId =
		typeof part.callID === 'string' && part.callID
			? `call-${part.callID}`
			: `${turn.messageId}-${String(part.type ?? 'part')}-${++state.seq}`;
	const base = {
		sessionId: turn.sessionId,
		messageId: turn.messageId,
		partId: typeof part.id === 'string' && part.id ? part.id : fallbackId
	};

	switch (part.type) {
		case 'step-start':
			return { kind: 'step-start', ...base };
		case 'step-finish':
			return { kind: 'step-finish', ...base };
		case 'text': {
			// Snapshot, not a delta — see the class comment.
			const text = typeof part.text === 'string' ? part.text : '';
			if (!text) return null;
			return { kind: 'text', ...base, text };
		}
		case 'tool': {
			const state = (part.state as Record<string, unknown> | undefined) ?? {};
			const status = typeof state.status === 'string' ? state.status : undefined;
			const name = normalizeToolName(typeof part.tool === 'string' ? part.tool : 'tool');
			return {
				kind: 'tool',
				...base,
				name,
				input: state.input ?? {},
				state: toToolState(status),
				...(state.output !== undefined ? { output: parseToolPayload(state.output) } : {}),
				...(state.error !== undefined ? { error: describeError(state.error) } : {})
			};
		}
		default:
			return null;
	}
}

/**
 * A refused action arrives here as the dispatcher's JSON error body, which the
 * MCP surface returned as an `isError` text block. Surface the message rather
 * than the envelope, so the panel's error line reads "Caller not permitted"
 * instead of a stringified object.
 */
function describeError(raw: unknown): string {
	const parsed = parseToolPayload(raw);
	if (parsed && typeof parsed === 'object') {
		const body = parsed as Record<string, unknown>;
		if (typeof body.error === 'string') {
			return typeof body.status === 'number' ? `${body.error} (${body.status})` : body.error;
		}
	}
	return typeof raw === 'string' ? raw : JSON.stringify(raw);
}
