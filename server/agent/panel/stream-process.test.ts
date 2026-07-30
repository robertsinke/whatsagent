import { describe, expect, it, vi } from 'vitest';
import { FakeChild } from '../../providers/fake-spawn.js';
import type { ChildProcessLike, SpawnProcess } from '../../providers/provider.js';
import { PanelTurnError, streamJsonLines } from './stream-process.js';

type SpawnCall = {
	command: string;
	args: readonly string[];
	options: { env: NodeJS.ProcessEnv; cwd?: string };
};

function spawnOf(child: ChildProcessLike, calls: SpawnCall[] = []): SpawnProcess {
	return ((command, args, options) => {
		calls.push({ command, args, options: options as SpawnCall['options'] });
		return child;
	}) as SpawnProcess;
}

async function drain(iter: AsyncIterable<Record<string, unknown>>) {
	const out: Record<string, unknown>[] = [];
	for await (const event of iter) out.push(event);
	return out;
}

describe('streamJsonLines', () => {
	it('yields each JSON line', async () => {
		const child = new FakeChild('{"a":1}\n{"a":2}\n');
		const events = await drain(
			streamJsonLines({
				command: 'harness',
				args: [],
				env: {},
				stdin: '',
				timeoutMs: 5_000,
				spawn: spawnOf(child),
				signal: new AbortController().signal
			})
		);
		expect(events).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('SKIPS a non-JSON line instead of killing the run', async () => {
		// The whole reason this exists rather than reusing `runJsonLinesProcess`:
		// there, one stray line kills the child and fails the turn. A harness with
		// MCP attached prints banners and warnings, and losing a good turn to one
		// noisy line is a bug that only appears on someone else's machine.
		const child = new FakeChild('Loading plugins...\n{"a":1}\nwarning: something\n{"a":2}\n');
		const events = await drain(
			streamJsonLines({
				command: 'harness',
				args: [],
				env: {},
				stdin: '',
				timeoutMs: 5_000,
				spawn: spawnOf(child),
				signal: new AbortController().signal
			})
		);
		expect(events).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('flushes a final line with no trailing newline', async () => {
		const child = new FakeChild('{"a":1}');
		expect(
			await drain(
				streamJsonLines({
					command: 'harness',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 5_000,
					spawn: spawnOf(child),
					signal: new AbortController().signal
				})
			)
		).toEqual([{ a: 1 }]);
	});

	it('ignores a JSON array line — events are objects', async () => {
		const child = new FakeChild('[1,2]\n{"a":1}\n');
		expect(
			await drain(
				streamJsonLines({
					command: 'harness',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 5_000,
					spawn: spawnOf(child),
					signal: new AbortController().signal
				})
			)
		).toEqual([{ a: 1 }]);
	});

	it('always closes stdin, even when it is empty', async () => {
		// `opencode run` does not begin work until stdin reaches EOF: with an
		// inherited open stdin it sits past five minutes having logged `init` and
		// nothing else, which reads exactly like the short-tools-block hang.
		const child = new FakeChild('{"a":1}\n');
		let ended = false;
		child.stdin = {
			write: () => undefined,
			end: () => {
				ended = true;
			},
			on: () => undefined
		};
		await drain(
			streamJsonLines({
				command: 'harness',
				args: [],
				env: {},
				stdin: '',
				timeoutMs: 5_000,
				spawn: spawnOf(child),
				signal: new AbortController().signal
			})
		);
		expect(ended).toBe(true);
	});

	it('writes the prompt to stdin when given one', async () => {
		const child = new FakeChild('{"a":1}\n');
		await drain(
			streamJsonLines({
				command: 'claude',
				args: [],
				env: {},
				stdin: 'the prompt\n',
				timeoutMs: 5_000,
				spawn: spawnOf(child),
				signal: new AbortController().signal
			})
		);
		expect(child.stdinText).toBe('the prompt\n');
	});

	it('passes cwd and env through to spawn', async () => {
		const calls: SpawnCall[] = [];
		const child = new FakeChild('{"a":1}\n');
		await drain(
			streamJsonLines({
				command: 'harness',
				args: ['run'],
				env: { WHATSAGENT_MCP_TOKEN: 'tok' },
				stdin: '',
				cwd: '/tmp/config-dir',
				timeoutMs: 5_000,
				spawn: spawnOf(child, calls),
				signal: new AbortController().signal
			})
		);
		expect(calls[0]).toMatchObject({
			command: 'harness',
			args: ['run'],
			options: { cwd: '/tmp/config-dir', env: { WHATSAGENT_MCP_TOKEN: 'tok' } }
		});
	});

	it('throws with the stderr tail on a non-zero exit', async () => {
		const child = new FakeChild('', 1, 'boom: config invalid');
		await expect(
			drain(
				streamJsonLines({
					command: 'harness',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 5_000,
					spawn: spawnOf(child),
					signal: new AbortController().signal
				})
			)
		).rejects.toThrow(/boom: config invalid/);
	});

	it('reports a spawn failure as spawn_failed', async () => {
		const spawn = (() => {
			throw new Error('ENOENT');
		}) as unknown as SpawnProcess;
		await expect(
			drain(
				streamJsonLines({
					command: 'nope',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 5_000,
					spawn,
					signal: new AbortController().signal
				})
			)
		).rejects.toMatchObject({ code: 'spawn_failed' });
	});

	it('kills the child and throws cancelled on abort', async () => {
		const child = new FakeChild('', 0, '', false);
		const controller = new AbortController();
		const iter = streamJsonLines({
			command: 'harness',
			args: [],
			env: {},
			stdin: '',
			timeoutMs: 60_000,
			killGraceMs: 5,
			spawn: spawnOf(child),
			signal: controller.signal
		});
		const pending = drain(iter);
		await vi.waitFor(() => expect(child.stdinText).toBe(''));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		expect(child.killed).toBe(true);
	});

	it('yields the parts that arrived before an abort', async () => {
		// A partial turn is worth more to the owner than none, so a graceful exit
		// inside the grace window still flushes the tail of stdout.
		const child = new FakeChild('', 0, '', false);
		const controller = new AbortController();
		const iter = streamJsonLines({
			command: 'harness',
			args: [],
			env: {},
			stdin: '',
			timeoutMs: 60_000,
			killGraceMs: 5,
			spawn: spawnOf(child),
			signal: controller.signal
		});
		const seen: Record<string, unknown>[] = [];
		const pending = (async () => {
			for await (const event of iter) seen.push(event);
		})();
		child.stdout.emit('data', Buffer.from('{"early":true}\n'));
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		expect(seen).toEqual([{ early: true }]);
	});

	it('refuses immediately when the signal is already aborted', async () => {
		const child = new FakeChild('', 0, '', false);
		const controller = new AbortController();
		controller.abort();
		await expect(
			drain(
				streamJsonLines({
					command: 'harness',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 60_000,
					killGraceMs: 5,
					spawn: spawnOf(child),
					signal: controller.signal
				})
			)
		).rejects.toBeInstanceOf(PanelTurnError);
		expect(child.killed).toBe(true);
	});

	it('times out and kills the child', async () => {
		const child = new FakeChild('', 0, '', false);
		await expect(
			drain(
				streamJsonLines({
					command: 'harness',
					args: [],
					env: {},
					stdin: '',
					timeoutMs: 5,
					killGraceMs: 5,
					spawn: spawnOf(child),
					signal: new AbortController().signal
				})
			)
		).rejects.toMatchObject({ code: 'timeout' });
		expect(child.killed).toBe(true);
	});

	it('kills the child when the consumer abandons the iterator early', async () => {
		// Without the generator's `finally`, an outer `break` would leave a harness
		// process alive holding a model connection open.
		const child = new FakeChild('', 0, '', false);
		const iter = streamJsonLines({
			command: 'harness',
			args: [],
			env: {},
			stdin: '',
			timeoutMs: 60_000,
			spawn: spawnOf(child),
			signal: new AbortController().signal
		});
		const loop = (async () => {
			for await (const _event of iter) break;
		})();
		child.stdout.emit('data', Buffer.from('{"a":1}\n'));
		await loop;
		expect(child.killed).toBe(true);
	});
});
