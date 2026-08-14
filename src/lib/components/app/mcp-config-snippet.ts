/**
 * MCPX-5 — copy-paste config for an external MCP client.
 *
 * The visible snippet carries no secret. The stdio entry reads `mcp.token` (and
 * `mcp-runtime.json`) itself at runtime; putting a Bearer header or the hex
 * token in this config would re-create the rotation problem the discovery file
 * exists to end.
 */

export type ExternalMcpSnippetInput = {
	command: string;
	entryPath: string;
	dataDir: string;
};

export function buildExternalMcpConfig(input: ExternalMcpSnippetInput): string {
	return `${JSON.stringify(
		{
			mcpServers: {
				whatsagent: {
					command: input.command,
					env: { ELECTRON_RUN_AS_NODE: '1' },
					args: [input.entryPath, '--data-dir', input.dataDir]
				}
			}
		},
		null,
		2
	)}\n`;
}

/**
 * `claude mcp add` equivalent of {@link buildExternalMcpConfig}.
 * Paths that need a shell are single-quoted; `--data-dir` stays a flag.
 */
export function buildClaudeMcpAddCommand(input: ExternalMcpSnippetInput): string {
	return [
		'claude mcp add --transport stdio -e ELECTRON_RUN_AS_NODE=1 whatsagent --',
		quoteShellArg(input.command),
		quoteShellArg(input.entryPath),
		'--data-dir',
		quoteShellArg(input.dataDir)
	].join(' ');
}

export function quoteShellArg(value: string): string {
	if (value.length === 0) return `''`;
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
