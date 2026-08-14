import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool
} from '@modelcontextprotocol/sdk/types.js';
import {
	actionRegistry,
	dispatch,
	listActionsForCaller,
	type ActionRegistry,
	type ActionResult
} from '../actions/index.js';
import { MCP_SERVER_INSTRUCTIONS } from '../agent/panel/harness.js';
import type { RoutesDeps } from '../api/routes.js';
import { validateHostAndBearer } from '../api/security.js';

export const MCP_PATH = '/mcp';

export type McpSurface = {
	token: string;
	tokenPath: string;
	handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/**
 * Build the MCP HTTP surface. Tools are advertised from
 * `listActionsForCaller(registry, 'tool')` and every call goes through
 * `dispatch` with `caller: 'tool'` — never a hand-maintained list, never a
 * direct `run`.
 */
export function createMcpSurface(options: {
	deps: RoutesDeps;
	token: string;
	tokenPath: string;
	registry?: ActionRegistry;
}): McpSurface {
	const registry = options.registry ?? actionRegistry;
	const { deps, token, tokenPath } = options;

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const auth = validateHostAndBearer(req, token);
		if (!auth.ok) {
			writeJson(res, auth.status, {
				jsonrpc: '2.0',
				error: {
					code: -32001,
					message: auth.status === 401 ? 'unauthorized' : 'forbidden'
				},
				id: null
			});
			return;
		}

		const server = createRegistryServer(registry, deps);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined
		});
		// Register the cleanup listener BEFORE awaiting handleRequest. A
		// non-streaming JSON-RPC response can be fully written and closed inside
		// that await, and `close` does not replay for a listener attached
		// afterwards — so the per-request Server and transport would never be
		// closed. `once` because a stateless request closes exactly one time.
		res.once('close', () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch (error) {
			console.error('[mcp] request error', error instanceof Error ? error.message : 'error');
			if (!res.headersSent) {
				writeJson(res, 500, {
					jsonrpc: '2.0',
					error: { code: -32603, message: 'internal error' },
					id: null
				});
			}
			void transport.close();
			void server.close();
		}
	}

	return { token, tokenPath, handle };
}

export type RegistryServerOptions = {
	/**
	 * Override the advertised `instructions`. MCPX-4's stdio entry point folds
	 * the attached/headless mode into them so an external agent knows which
	 * world it is in without probing. Defaults to `MCP_SERVER_INSTRUCTIONS`.
	 */
	instructions?: string;
	/**
	 * MCPX-4 — last-mile adjustment of a dispatch result before it is shaped
	 * into a `CallToolResult`. Headless mode uses it to name the missing
	 * dependency on a dep-absent error and to state `focused: false` on
	 * `open-chat`, without editing the shared action definitions.
	 *
	 * Never invoked for a 403: that is the dispatcher's caller-policy refusal,
	 * and R9 rests on it. No annotator may soften, reshape or reinterpret it.
	 */
	annotate?: (name: string, result: ActionResult) => ActionResult;
};

export function createRegistryServer(
	registry: ActionRegistry,
	deps: RoutesDeps,
	options: RegistryServerOptions = {}
): Server {
	const server = new Server(
		{ name: 'whatsagent', version: '0.0.1' },
		{
			capabilities: { tools: {} },
			instructions: options.instructions ?? MCP_SERVER_INSTRUCTIONS
		}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listRegistryTools(registry)
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
		callRegistryTool(registry, deps, request.params.name, request.params.arguments, options)
	);

	return server;
}

/**
 * The advertised tool list. Split out of {@link createRegistryServer} so the
 * stdio entry point serves the identical list without standing a second MCP
 * `Server` up in-process.
 */
export function listRegistryTools(registry: ActionRegistry): Tool[] {
	return listActionsForCaller(registry, 'tool').map((action) => ({
		name: action.name,
		description: action.description,
		inputSchema: toToolInputSchema(action.jsonSchema)
	}));
}

/**
 * Dispatch one tool call and shape it into a `CallToolResult`. One
 * implementation, shared by the in-app HTTP surface and the headless stdio
 * mode, so the two can never answer differently for the same registry.
 */
export async function callRegistryTool(
	registry: ActionRegistry,
	deps: RoutesDeps,
	name: string,
	args: Record<string, unknown> | undefined,
	options: RegistryServerOptions = {}
): Promise<CallToolResult> {
	const dispatched = await dispatch(registry, name, args ?? {}, { caller: 'tool', deps });
	// The 403 guard lives here, not in the annotator, so it holds for every
	// annotator anyone writes later.
	const result =
		options.annotate && !(dispatched.kind === 'error' && dispatched.status === 403)
			? options.annotate(name, dispatched)
			: dispatched;

	if (result.kind === 'error') {
		audit(name, 'error', result.status);
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						error: result.error,
						status: result.status,
						...(result.extra ?? {})
					})
				}
			],
			isError: true
		};
	}

	audit(name, 'ok', result.status);
	return {
		content: [{ type: 'text', text: JSON.stringify(result.body) }]
	};
}

function toToolInputSchema(schema: Record<string, unknown>): Tool['inputSchema'] {
	// MCP requires the top-level input schema to be an object schema, and every
	// action's `jsonSchema` already is one. Pinned rather than copied through so
	// a future non-object action schema fails visibly here instead of shipping a
	// tool the harness silently rejects.
	return {
		type: 'object',
		...(typeof schema.properties === 'object' && schema.properties
			? { properties: schema.properties as Tool['inputSchema']['properties'] }
			: {}),
		...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
		...(schema.additionalProperties !== undefined
			? { additionalProperties: schema.additionalProperties as boolean }
			: {})
	};
}

/** Structured audit — action name, caller, outcome. Never log inputs. */
function audit(action: string, outcome: 'ok' | 'error', status: number): void {
	console.info(
		JSON.stringify({
			scope: 'mcp',
			action,
			caller: 'tool',
			outcome,
			status
		})
	);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload)
	});
	res.end(payload);
}

/** True when the MCP surface should be minted. Off by default. */
export function isMcpEnabled(
	options: { mcp?: boolean | { enabled?: boolean } } | undefined,
	env: NodeJS.ProcessEnv = process.env
): boolean {
	if (options?.mcp === false) return false;
	if (options?.mcp === true) return true;
	if (typeof options?.mcp === 'object' && options.mcp.enabled === true) return true;
	if (typeof options?.mcp === 'object' && options.mcp.enabled === false) return false;
	return env.WHATSAGENT_MCP === '1';
}

/**
 * PANEL-S1 — the caller's explicit answer, or `undefined` when they did not
 * give one.
 *
 * `isMcpEnabled` collapses "the caller said no" and "the caller said nothing"
 * into the same `false`, which is right for its own question and wrong for the
 * settings fallback: `createApp` must let a `panel_enabled` row switch the
 * surface on when nobody asked, and must never let it override a caller who
 * asked for `mcp: false`. Kept separate rather than folded in so the shipped
 * `isMcpEnabled` semantics and its unit tests stay exactly as they were.
 */
export function mcpOptionOverride(
	options: { mcp?: boolean | { enabled?: boolean } } | undefined
): boolean | undefined {
	if (typeof options?.mcp === 'boolean') return options.mcp;
	if (typeof options?.mcp === 'object' && typeof options.mcp.enabled === 'boolean') {
		return options.mcp.enabled;
	}
	return undefined;
}
