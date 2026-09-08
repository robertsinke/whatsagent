#!/usr/bin/env node
/**
 * Small scriptable read client for WhatsAgent's stdio MCP surface.
 *
 * This intentionally speaks MCP instead of opening the SQLite database. That
 * keeps callers on the same read-only action contract as Claude/Cursor and
 * preserves headless/attached routing inside the server.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'whatsagent-desktop');

function usage() {
	console.error(`Usage:
  whatsagent-cli.mjs chats [--filter all|needs-reply|groups] [--limit N] [--offset N]
  whatsagent-cli.mjs messages --chat-jid JID [--limit N] [--before-ts N] [--before-id ID] [--after-ts N] [--after-id ID]

Common options:
  --data-dir PATH       WhatsAgent data directory (default: macOS app directory)
  --entrypoint PATH     MCP entrypoint (defaults to dist, then TypeScript source)
  --app-binary PATH     Launch PATH as Electron's Node runtime instead of node/tsx
  --help                Show this help

Output is one JSON object on stdout. Diagnostics go to stderr.`);
}

function parseArgs(argv) {
	if (argv.length === 0 || argv.includes('--help')) {
		usage();
		process.exit(argv.length === 0 ? 2 : 0);
	}
	const command = argv.shift();
	if (command !== 'chats' && command !== 'messages') {
		throw new Error(`Unknown command: ${command}`);
	}
	const options = { command };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
		const key = flag.slice(2).replaceAll('-', '_');
		if (key === 'help') continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
		options[key] = value;
		index += 1;
	}
	return options;
}

function numberOption(options, name) {
	if (options[name] === undefined) return undefined;
	const value = Number(options[name]);
	if (!Number.isInteger(value) || value < 0) throw new Error(`Expected a non-negative integer for --${name.replaceAll('_', '-')}`);
	return value;
}

function expandPath(value) {
	if (!value) return value;
	return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function resolveEntrypoint(options) {
	if (options.entrypoint) return resolve(expandPath(options.entrypoint));
	const compiled = join(REPO_ROOT, 'dist', 'server', 'server', 'mcp', 'stdio.js');
	if (existsSync(compiled)) return compiled;
	return join(REPO_ROOT, 'server', 'mcp', 'stdio.ts');
}

function serverProcess(options, entrypoint) {
	const isTypeScript = entrypoint.endsWith('.ts');
	const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
	if (options.app_binary) {
		return {
			command: resolve(expandPath(options.app_binary)),
			args: [entrypoint, ...(options.data_dir ? ['--data-dir', resolve(expandPath(options.data_dir))] : [])],
			env: { ELECTRON_RUN_AS_NODE: '1' }
	};
	}
	if (isTypeScript && !existsSync(tsx)) {
		throw new Error(`TypeScript entrypoint requires ${tsx}`);
	}
	return {
		command: isTypeScript ? tsx : process.execPath,
		args: [entrypoint, ...(options.data_dir ? ['--data-dir', resolve(expandPath(options.data_dir))] : [])],
		env: {}
	};
}

function toolArguments(options) {
	if (options.command === 'chats') {
		return {
			filter: options.filter ?? 'all',
			...(numberOption(options, 'limit') !== undefined ? { limit: numberOption(options, 'limit') } : {}),
			...(numberOption(options, 'offset') !== undefined ? { offset: numberOption(options, 'offset') } : {})
		};
	}
	if (!options.chat_jid) throw new Error('messages requires --chat-jid JID');
	return {
		chatJid: options.chat_jid,
		...(numberOption(options, 'limit') !== undefined ? { limit: numberOption(options, 'limit') } : {}),
		...(numberOption(options, 'before_ts') !== undefined ? { beforeTs: numberOption(options, 'before_ts') } : {}),
		...(options.before_id ? { beforeId: options.before_id } : {}),
		...(numberOption(options, 'after_ts') !== undefined ? { afterTs: numberOption(options, 'after_ts') } : {}),
		...(options.after_id ? { afterId: options.after_id } : {})
	};
}

function jsonFromToolResult(result) {
	if (result?.isError) {
		const message = (result.content ?? []).map((item) => item.text ?? '').join(' ').trim();
		throw new Error(message || 'WhatsAgent MCP tool failed');
	}
	const text = (result?.content ?? []).map((item) => item.text ?? '').join('').trim();
	if (!text) throw new Error('WhatsAgent MCP tool returned no JSON');
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`WhatsAgent MCP tool returned invalid JSON: ${text.slice(0, 200)}`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const entrypoint = resolveEntrypoint(options);
	const child = serverProcess(options, entrypoint);
	const client = new Client({ name: 'whatsagent-cli', version: '0.1.0' });
	const transport = new StdioClientTransport({
		command: child.command,
		args: [...child.args, ...(options.data_dir ? [] : ['--data-dir', DEFAULT_DATA_DIR])],
		cwd: REPO_ROOT,
		env: { ...process.env, ...child.env },
		stderr: 'inherit'
	});
	try {
		await client.connect(transport);
		const tool = options.command === 'chats' ? 'list-chats' : 'get-messages';
		const result = await client.callTool({ name: tool, arguments: toolArguments(options) });
		process.stdout.write(`${JSON.stringify(jsonFromToolResult(result))}\n`);
	} finally {
		await client.close().catch(() => {});
	}
}

main().catch((error) => {
	console.error(`whatsagent-cli: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
