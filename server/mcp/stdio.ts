/**
 * MCPX-4 — the stdio MCP entry point the owner's own Claude Code / Cursor
 * sessions talk to.
 *
 * Launched as
 * `ELECTRON_RUN_AS_NODE=1 /Applications/WhatsAgent.app/Contents/MacOS/WhatsAgent
 *  <this file> --data-dir <dir>`, which is a full Node that resolves modules
 * inside `app.asar`. It picks one of two modes at startup:
 *
 * - **attached** — the runtime discovery file exists, its pid is alive, and an
 *   `initialize` probe answers as `whatsagent`. Every request is proxied to the
 *   running app, so there is exactly one database writer and an open window
 *   updates live.
 * - **headless** — otherwise. The database is opened directly and the same
 *   action registry is served in-process, so `tools/list` and every
 *   `dispatch(..., { caller: 'tool' })` are identical between modes.
 *
 * ## stdout belongs to the protocol
 *
 * `StdioServerTransport` writes JSON-RPC frames to stdout, and a single stray
 * `console.log` corrupts the stream for the client. The registry server audits
 * every tool call with `console.info`, better-sqlite3 and the provider CLI
 * adapters have their own chatter, and none of them can know they are being run
 * this way. So the first thing this module does is point every stdout console
 * method at stderr. Diagnostics still reach the client's MCP log; they just
 * stop pretending to be protocol.
 *
 * ## Why `assertNotLiveDbFromWorktree` does not apply here
 *
 * This entry point resolves a data dir itself and passes it to `openDatabase`,
 * which disarms the worktree guard. That guard exists for exactly one reason:
 * to stop a second Baileys socket landing on the owner's personal WhatsApp
 * account. Nothing in this module can construct a channel — it imports neither
 * `server/index.ts` nor anything under `server/channels/whatsapp/`, and there
 * is no send transport, no `WhatsAppConnection`, and no path to one. Re-adding
 * the guard here would protect against nothing while breaking the entry point's
 * whole purpose, which is to open a data dir the app itself chose.
 *
 * That claim is enforced rather than promised: `stdio.test.ts` resolves this
 * file's transitive runtime import graph and asserts `baileys` and
 * `server/channels/whatsapp/` are both absent from it, and proves the walker is
 * not vacuous by finding `baileys` from `connection.ts` in the same test.
 */

// Before anything else can log. Module-body statements run after imports are
// evaluated, and no import in this graph logs at evaluation time.
const toStderr = (...args: unknown[]): void => {
	console.error(...args);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { actionRegistry } from '../actions/index.js';
import { mcpServerInstructions, type McpServerMode } from '../agent/panel/harness.js';
import type { RoutesDeps } from '../api/routes.js';
import { resolveDataDirOverride } from '../data-dir.js';
import { getDefaultDataDir, type AppDatabase } from '../store/db.js';
import { getMcpEnabledSetting } from '../store/settings.js';
import {
	annotateHeadlessResult,
	createHeadlessDeps,
	HeadlessRefusal,
	openHeadlessDatabase
} from './headless.js';
import { readMcpRuntimeFile, type McpRuntimeFile } from './runtime.js';
import { callRegistryTool, listRegistryTools } from './surface.js';

/**
 * How long the `initialize` probe waits before falling back to headless.
 *
 * A wedged app must not hang the entry point: the owner's agent gets a working
 * headless surface a few seconds late instead of a session that never starts.
 */
const PROBE_TIMEOUT_MS = 3_000;

/** How long a failed probe suppresses re-dialling the same discovery file. */
const REJECTED_PROBE_TTL_MS = 5_000;

const SERVER_NAME = 'whatsagent';

/**
 * The only text a disabled `mcp_enabled` row may produce. Startup and a live
 * session that is switched off mid-flight share it, so a client cannot tell
 * the two refusals apart — and a later edit cannot let them drift.
 */
const MCP_DISABLED_REFUSAL =
	'whatsagent: external agents are switched off. Open WhatsAgent → Settings → External agents (MCP) to turn them on.';

type AttachedLink = { client: Client; key: string };

type Headless = { db: AppDatabase; deps: RoutesDeps };

function runtimeKey(runtime: McpRuntimeFile): string {
	return `${runtime.pid}:${runtime.url}:${runtime.startedAt}`;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Connect to a running app and confirm it is ours.
 *
 * Returns `null` for every failure — a missing, stale or corrupt discovery
 * file, a dead pid, a wrong token, a 404 because MCP is switched off in the
 * running app, or a timeout. All of them mean the same thing to the caller:
 * there is no live app to proxy to, fall back to headless and let the
 * `mcp_enabled` row have the final word. Same switch, one meaning.
 */
async function probeAttached(dataDir: string): Promise<AttachedLink | null> {
	const runtime = readMcpRuntimeFile(dataDir);
	if (!runtime) return null;
	if (!processAlive(runtime.pid)) return null;

	const client = new Client({ name: 'whatsagent-stdio', version: '0.0.1' });
	const transport = new StreamableHTTPClientTransport(new URL(runtime.url), {
		requestInit: { headers: { Authorization: `Bearer ${runtime.token}` } }
	});
	try {
		await withTimeout(client.connect(transport), PROBE_TIMEOUT_MS);
		if (client.getServerVersion()?.name !== SERVER_NAME) {
			await client.close();
			return null;
		}
		return { client, key: runtimeKey(runtime) };
	} catch {
		// Never surface the reason: the discovery file carries the bearer token
		// and transport errors quote request detail.
		await client.close().catch(() => {});
		return null;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error('failed'));
			}
		);
	});
}

/**
 * Decides, per request, which world serves it.
 *
 * Headless→attached is re-checked before each request because an owner who
 * opens WhatsAgent mid-session expects their next tool call to land in the
 * window, not in a second writer. The check is filesystem-only (`read the
 * discovery file`, `kill(pid, 0)`) until the file actually changes; only then
 * is the network probe paid. Attached→headless never happens: once there is a
 * live app it owns the database, and dropping back would reintroduce the second
 * writer this whole design exists to avoid.
 */
class ModeRouter {
	readonly #dataDir: string;
	#attached: AttachedLink | null = null;
	#headless: Headless | null = null;
	/**
	 * Discovery-file identity already probed and rejected, with the time it was
	 * rejected. Cached so a stale file does not cost a network dial on every
	 * request — but EXPIRING, because the rejection may be a race rather than a
	 * verdict: `createApp` writes the runtime file from `reconcilePanelRuntime()`
	 * before `server.on('listening')` whenever the port is not ephemeral, so
	 * there is a window in which the file is real and `/mcp` is not yet
	 * answering. Caching that forever would strand the session in headless mode
	 * for the whole life of an app it could have attached to.
	 */
	#rejected: { key: string; at: number } | null = null;

	constructor(dataDir: string) {
		this.#dataDir = dataDir;
	}

	get mode(): McpServerMode {
		return this.#attached ? 'attached' : 'headless';
	}

	/** Startup: probe once, and build the headless world only if there is no app. */
	async start(): Promise<void> {
		this.#attached = await probeAttached(this.#dataDir);
		if (this.#attached) return;
		this.#headless = await this.#openHeadless();
	}

	async #openHeadless(): Promise<Headless> {
		const db = openHeadlessDatabase(this.#dataDir);
		if (!getMcpEnabledSetting(db)) {
			db.close();
			throw new HeadlessRefusal(MCP_DISABLED_REFUSAL);
		}
		return { db, deps: await createHeadlessDeps(db, this.#dataDir) };
	}

	/**
	 * Headless deps for this call, re-reading `mcp_enabled` first.
	 *
	 * The row is the owner's switch. It is checked at open, and again on every
	 * later call: turning External agents off must stop a session that is
	 * already running. Anything other than exactly enabled closes that
	 * database, drops the cache, and fails with the startup refusal. The stale
	 * deps are not served.
	 */
	async #liveHeadless(): Promise<Headless> {
		if (!this.#headless) this.#headless = await this.#openHeadless();
		if (getMcpEnabledSetting(this.#headless.db)) return this.#headless;
		const stale = this.#headless;
		this.#headless = null;
		stale.db.close();
		throw new HeadlessRefusal(MCP_DISABLED_REFUSAL);
	}

	/** The link to use for this request, re-probing when still headless. */
	async current(): Promise<AttachedLink | Headless> {
		if (this.#attached) return this.#attached;

		const runtime = readMcpRuntimeFile(this.#dataDir);
		if (runtime && this.#worthProbing(runtimeKey(runtime)) && processAlive(runtime.pid)) {
			const link = await probeAttached(this.#dataDir);
			if (link) {
				// One writer is the point: hand the database back before proxying.
				this.#headless?.db.close();
				this.#headless = null;
				this.#attached = link;
				return link;
			}
			this.#rejected = { key: runtimeKey(runtime), at: Date.now() };
		}
		return await this.#liveHeadless();
	}

	#worthProbing(key: string): boolean {
		if (this.#rejected === null || this.#rejected.key !== key) return true;
		return Date.now() - this.#rejected.at >= REJECTED_PROBE_TTL_MS;
	}

	async close(): Promise<void> {
		await this.#attached?.client.close().catch(() => {});
		this.#headless?.db.close();
	}
}

function isAttached(link: AttachedLink | Headless): link is AttachedLink {
	return 'client' in link;
}

/**
 * One MCP server over stdio, routing each request to the current mode.
 *
 * `tools/list` is served from whichever side is live — in attached mode from
 * the running app, so an older bundle's entry point never advertises tools the
 * app does not have. The list is the same registry either way; it is stable
 * across a mode switch, which is what clients cache.
 */
function createStdioServer(router: ModeRouter): Server {
	const server = new Server(
		{ name: SERVER_NAME, version: '0.0.1' },
		{
			capabilities: { tools: {} },
			instructions: mcpServerInstructions(router.mode)
		}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const link = await router.current();
		if (isAttached(link)) return await link.client.listTools();
		return { tools: listRegistryTools(actionRegistry) };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const link = await router.current();
		if (isAttached(link)) {
			return (await link.client.callTool({
				name: request.params.name,
				arguments: request.params.arguments ?? {}
			})) as CallToolResult;
		}
		// Same builder the HTTP surface uses, so `caller: 'tool'` policy, the
		// dispatch call and the result encoding are one implementation — R9's
		// refusal cannot differ between modes because there is only one of it.
		return await callRegistryTool(
			actionRegistry,
			link.deps,
			request.params.name,
			request.params.arguments,
			{ annotate: annotateHeadlessResult }
		);
	});

	return server;
}

export async function main(): Promise<void> {
	const dataDir = resolveDataDirOverride() ?? getDefaultDataDir();
	const router = new ModeRouter(dataDir);

	try {
		await router.start();
	} catch (error) {
		if (error instanceof HeadlessRefusal) {
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}

	const server = createStdioServer(router);
	const transport = new StdioServerTransport();
	await server.connect(transport);

	const shutdown = (): void => {
		void router.close().finally(() => process.exit(0));
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	// The client closing the pipe is the end of the session. Set on the Server
	// rather than the transport: `connect` installs the transport's `onclose`
	// itself, and overwriting it would cut the chain that fires this.
	server.onclose = shutdown;
}

// `import.meta.url` vs argv[1] — self-start only when run directly, so tests can
// import the module without launching a server on their stdio.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error(
			`whatsagent: ${error instanceof Error ? error.message : 'failed to start'}`
		);
		process.exit(1);
	});
}
