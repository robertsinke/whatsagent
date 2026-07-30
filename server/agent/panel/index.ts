import { listActionsForCaller, type ActionRegistry } from '../../actions/index.js';
import type { PanelHarness, PanelHarnessId } from './harness.js';
import { ClaudePanelHarness } from './claude-harness.js';
import { OpenCodePanelHarness } from './opencode-harness.js';

export {
	buildPanelPrompt,
	MCP_SERVER_NAME,
	normalizeToolName,
	PANEL_SYSTEM_PROMPT,
	renderHistory,
	type PanelHarness,
	type PanelHarnessId,
	type PanelTurn,
	type PanelTurnSummary
} from './harness.js';
export { PanelSessionManager, PanelTurnInFlightError } from './session.js';
export { PanelTurnError } from './stream-process.js';

/**
 * Harnesses the panel can run. Deliberately NOT the drafting provider list.
 *
 * `direct-ollama` is a drafting vehicle and not a panel vehicle: the app talks to
 * `/api/chat` itself there, which has no tool surface at all, so a panel agent on
 * it could not call a single action. Ollama models still participate — by running
 * *inside* opencode, which speaks MCP. The UI must not offer direct-Ollama as a
 * panel option, and this list is what makes that structural rather than a
 * convention.
 */
export const PANEL_HARNESS_IDS = ['opencode', 'claude'] as const;

export function isPanelHarnessId(value: unknown): value is PanelHarnessId {
	return typeof value === 'string' && (PANEL_HARNESS_IDS as readonly string[]).includes(value);
}

export type CreatePanelHarnessOptions = {
	harness: PanelHarnessId;
	/** Port the app server is listening on — `/mcp` is mounted on it. */
	port: number;
	/** Bearer token from `app.mcp.token`. */
	token: string;
	model?: string;
	registry?: ActionRegistry;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
};

export function createPanelHarness(options: CreatePanelHarnessOptions): PanelHarness {
	const shared = {
		port: options.port,
		token: options.token,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
	};
	if (options.harness === 'claude') {
		return new ClaudePanelHarness({
			...shared,
			// Derived from the registry, exactly like the MCP tool list — a
			// hand-maintained allowlist here would drift the moment a caller policy
			// changed, and would drift silently.
			allowedActions: options.registry
				? listActionsForCaller(options.registry, 'tool').map((a) => a.name)
				: []
		});
	}
	return new OpenCodePanelHarness(shared);
}
