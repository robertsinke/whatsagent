import { spawnProcess, type ChildProcessLike, type SpawnProcess } from '../../providers/provider.js';

/**
 * A streaming JSONL child process, for panel turns.
 *
 * WHY NOT `runJsonLinesProcess`. The drafting runner in
 * `server/providers/provider.ts` is the right shape for drafting and the wrong
 * shape here, in three ways that are not cosmetic:
 *
 * 1. It returns `Promise<void>` and pushes events into a callback. A harness
 *    adapter has to hand parts back as they arrive, so this yields instead.
 * 2. It has no `AbortSignal`. Panel turns are cancellable by the owner.
 * 3. **A single unparseable line kills the run.** `processLine` there kills the
 *    child and rejects with `invalid_response`. That is correct for drafting,
 *    where the entire contract is one JSON verdict and a stray line means the
 *    provider misbehaved. It is wrong for a panel turn: a harness with MCP
 *    attached prints banners, hook chatter and warnings, and losing an
 *    otherwise-good turn to one noisy line would be a bug that only shows up on
 *    someone else's machine. Here a non-JSON line is skipped.
 *
 * What IS reused: `sanitizedEnv` (at the call sites, so subscription login is
 * used and no token is billed), `spawnProcess`, and the kill discipline —
 * SIGTERM, then SIGKILL after a grace window.
 *
 * STDIN IS ALWAYS CLOSED. `opencode run` does not begin work until stdin
 * reaches EOF: with an inherited open stdin it sits silently past five minutes
 * having logged `init` and nothing else, which reads exactly like the
 * short-tools-block hang and is not it. `claude -p` is the mirror image — it
 * refuses a positional prompt when stdin is redirected from /dev/null and wants
 * the prompt written to stdin instead. So `stdin` below is written and ended
 * unconditionally, and the adapters differ only in what they put in it.
 */

export type StreamProcessOptions = {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	/** Written then closed. Empty string still closes — see the note above. */
	stdin: string;
	cwd?: string;
	timeoutMs: number;
	killGraceMs?: number;
	spawn?: SpawnProcess;
	signal: AbortSignal;
};

export class PanelTurnError extends Error {
	constructor(
		public readonly code: 'spawn_failed' | 'process_exit' | 'timeout' | 'cancelled',
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'PanelTurnError';
	}
}

type SpawnWithCwd = (
	command: string,
	args: readonly string[],
	options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; cwd?: string }
) => ChildProcessLike;

/**
 * Yield each parseable JSON line of the child's stdout. Non-JSON lines are
 * skipped. Resolves when the child exits 0; throws {@link PanelTurnError}
 * otherwise, including cancellation.
 */
export async function* streamJsonLines(
	options: StreamProcessOptions
): AsyncGenerator<Record<string, unknown>, void, undefined> {
	let child: ChildProcessLike;
	try {
		child = (options.spawn ?? (spawnProcess as SpawnWithCwd))(options.command, options.args, {
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			...(options.cwd === undefined ? {} : { cwd: options.cwd })
		});
	} catch (cause) {
		throw new PanelTurnError('spawn_failed', `Failed to spawn ${options.command}`, { cause });
	}

	const queue: Record<string, unknown>[] = [];
	let done = false;
	let failure: PanelTurnError | undefined;
	let stderr = '';
	let pending = '';
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	/** Resolver for the consumer's wait; replaced each time it is awaited. */
	let notify: (() => void) | undefined;

	const wake = () => {
		notify?.();
		notify = undefined;
	};

	const settle = (error?: PanelTurnError) => {
		if (done) return;
		done = true;
		if (error) failure = error;
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		options.signal.removeEventListener('abort', onAbort);
		wake();
	};

	/**
	 * SIGTERM, then SIGKILL after the grace window — the draft providers'
	 * discipline. A harness that ignores SIGTERM (a shell wrapper around a real
	 * binary is the usual reason) must not leave a process behind holding a
	 * model connection.
	 */
	const killWithGrace = (error: PanelTurnError) => {
		if (done) return;
		child.kill('SIGTERM');
		killTimer = setTimeout(() => {
			child.kill('SIGKILL');
			settle(error);
		}, options.killGraceMs ?? 1_000);
		// Do not settle yet: a graceful exit inside the window still flushes the
		// tail of stdout, and a partial turn is worth more to the owner than none.
		failure = error;
	};

	const onAbort = () => {
		killWithGrace(new PanelTurnError('cancelled', 'Turn cancelled'));
	};

	const timeout = setTimeout(() => {
		killWithGrace(new PanelTurnError('timeout', `${options.command} timed out`));
	}, options.timeoutMs);

	const takeLine = (line: string) => {
		const trimmed = line.trim();
		// Skip blank and non-JSON lines rather than failing the turn. See the
		// module comment: harness stdout is noisier than a drafting response.
		if (!trimmed || !trimmed.startsWith('{')) return;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				queue.push(parsed as Record<string, unknown>);
				wake();
			}
		} catch {
			// Truncated or non-JSON — ignore.
		}
	};

	child.stdout.on('data', (chunk) => {
		pending += chunk.toString();
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';
		for (const line of lines) takeLine(line);
	});
	child.stderr.on('data', (chunk) => {
		// Bounded: a chatty harness must not grow this without limit for the whole
		// turn. Only the tail is ever used, in an exit message.
		stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
	});
	child.on('error', (cause) => {
		settle(new PanelTurnError('spawn_failed', `Failed to run ${options.command}`, { cause }));
	});
	child.on('close', (code, signal) => {
		if (pending) takeLine(pending);
		pending = '';
		if (failure) {
			settle(failure);
			return;
		}
		if (code !== 0) {
			const detail = stderr.trim() || `signal ${signal ?? 'unknown'}`;
			settle(
				new PanelTurnError(
					'process_exit',
					`${options.command} exited with code ${code ?? 'null'}: ${detail}`
				)
			);
			return;
		}
		settle();
	});

	if (options.signal.aborted) onAbort();
	else options.signal.addEventListener('abort', onAbort);

	try {
		child.stdin.write(options.stdin);
		child.stdin.end();
	} catch (cause) {
		settle(
			new PanelTurnError('process_exit', `Failed to write to ${options.command} stdin`, { cause })
		);
	}

	try {
		for (;;) {
			while (queue.length > 0) yield queue.shift()!;
			if (done) break;
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
		// Drain anything that landed alongside the final close.
		while (queue.length > 0) yield queue.shift()!;
		if (failure) throw failure;
	} finally {
		// The consumer may abandon the iterator early (an outer `break`, or the
		// session manager tearing down). Without this the child would outlive the
		// turn holding a model connection open.
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		options.signal.removeEventListener('abort', onAbort);
		if (!done) {
			done = true;
			child.kill('SIGTERM');
		}
	}
}
