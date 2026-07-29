/**
 * PL-S1 throwaway MCP server — READ-ONLY tools over an explicit fixture dataDir.
 *
 * Safety by construction:
 *   --dataDir  REQUIRED, no default, no fallback to home/app-support
 *   --token    REQUIRED; HTTP Bearer must match; stdio requires env match
 */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/store/db.js';
import { listChats, getChat } from '../server/store/chats.js';
import { listMessagesPage } from '../server/store/messages.js';
import { VoiceFiles, GLOBAL_VOICE_STEM } from '../server/agent/memory/voice-files.js';

const spikeDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(spikeDir, 'package.json'));

function argValue(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return undefined;
	const value = process.argv[idx + 1];
	if (!value || value.startsWith('--')) return undefined;
	return value;
}

function requireArg(flag: string): string {
	const value = argValue(flag);
	if (!value) {
		throw new Error(
			`Missing required ${flag}. Refusing to start — no default dataDir/token is allowed.\n` +
				`Usage: npx tsx spike/mcp-server.ts --dataDir <temp-path> --token <secret> [--transport stdio|http] [--port N]`
		);
	}
	return value;
}

async function main(): Promise<void> {
	const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
	const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
	const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
	const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
	const z = require('zod');

	const dataDir = requireArg('--dataDir');
	const token = requireArg('--token');
	const transportMode = argValue('--transport') ?? 'stdio';
	const port = Number(argValue('--port') ?? '9412');

	if (dataDir.includes('Application Support/whatsagent') || dataDir.includes('whatsagent-desktop')) {
		throw new Error(`Refusing dataDir that looks like live account data: ${dataDir}`);
	}

	const db = openDatabase({ dataDir });
	const voice = new VoiceFiles(dataDir);

	function createServer() {
		const server = new McpServer({
			name: 'whatsagent-spike',
			version: '0.0.0-spike'
		});

		server.registerTool(
			'list_chats',
			{
				description: 'List chats: jid, display name, kind, unread count. Read-only.'
			},
			async () => {
				const chats = listChats(db).map((c) => ({
					jid: c.jid,
					name: c.name,
					kind: c.kind,
					unread: c.unread
				}));
				return { content: [{ type: 'text' as const, text: JSON.stringify(chats, null, 2) }] };
			}
		);

		server.registerTool(
			'get_messages',
			{
				description: 'Recent messages for a chat jid. Read-only.',
				inputSchema: {
					jid: z.string().describe('Chat jid'),
					limit: z.number().int().min(1).max(50).optional().describe('Max messages (default 10)')
				}
			},
			async ({ jid, limit }: { jid: string; limit?: number }) => {
				const chat = getChat(db, jid);
				if (!chat) {
					return {
						content: [
							{ type: 'text' as const, text: JSON.stringify({ error: 'chat_not_found', jid }) }
						],
						isError: true
					};
				}
				const messages = listMessagesPage(db, jid, { limit: limit ?? 10 }).map((m) => ({
					id: m.id,
					from_me: m.from_me,
					ts: m.ts,
					type: m.type,
					text: m.text,
					sender: m.sender
				}));
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ jid, name: chat.name, messages }, null, 2)
						}
					]
				};
			}
		);

		server.registerTool(
			'get_voice',
			{
				description: 'Return the global voice document. Read-only.'
			},
			async () => {
				const content = voice.read(GLOBAL_VOICE_STEM);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ stem: GLOBAL_VOICE_STEM, content }, null, 2)
						}
					]
				};
			}
		);

		return server;
	}

	if (transportMode === 'stdio') {
		const envToken = process.env.WHATSAGENT_MCP_TOKEN;
		if (envToken !== token) {
			throw new Error(
				'Stdio auth failed: set WHATSAGENT_MCP_TOKEN to the same value as --token (harness env).'
			);
		}
		const server = createServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		return;
	}

	if (transportMode !== 'http') {
		throw new Error(`Unknown --transport ${transportMode} (use stdio|http)`);
	}

	const app = createMcpExpressApp({ host: '127.0.0.1' });

	app.use((req: { headers: { authorization?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
		const header = req.headers.authorization ?? '';
		if (header !== `Bearer ${token}`) {
			res.status(401).json({
				jsonrpc: '2.0',
				error: { code: -32001, message: 'unauthorized: bearer token required' },
				id: null
			});
			return;
		}
		next();
	});

	app.post('/mcp', async (req: { body?: unknown }, res: { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void }; on: (ev: string, cb: () => void) => void }) => {
		const server = createServer();
		try {
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
			res.on('close', () => {
				void transport.close();
				void server.close();
			});
		} catch (error) {
			console.error('[spike-mcp] request error', error);
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: '2.0',
					error: { code: -32603, message: 'internal error' },
					id: null
				});
			}
		}
	});

	app.get('/mcp', (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
		res.status(405).json({
			jsonrpc: '2.0',
			error: { code: -32000, message: 'Method not allowed' },
			id: null
		});
	});

	await new Promise<void>((resolve) => {
		app.listen(port, '127.0.0.1', () => {
			console.error(`[spike-mcp] http://127.0.0.1:${port}/mcp (Bearer required)`);
			console.error(`[spike-mcp] dataDir=${dataDir}`);
			resolve();
		});
	});
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
