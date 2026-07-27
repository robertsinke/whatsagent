import { EventEmitter } from 'node:events';
import type { ChildProcessLike, SpawnProcess } from './provider.js';

export class FakeChild extends EventEmitter implements ChildProcessLike {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdinText = '';
	killed = false;
	stdin = {
		write: (data: string) => {
			this.stdinText += data;
		},
		end: () => undefined,
		on: () => undefined
	};

	constructor(
		stdout: string,
		private readonly exitCode: number | null = 0,
		stderr = '',
		autoClose = true
	) {
		super();
		if (autoClose) {
			setTimeout(() => {
				if (stdout) this.stdout.emit('data', Buffer.from(stdout));
				if (stderr) this.stderr.emit('data', Buffer.from(stderr));
				this.emit('close', this.exitCode, null);
			}, 0);
		}
	}

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

export type FakeTranscript = {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	autoClose?: boolean;
};

export function fakeSpawn(transcripts: FakeTranscript[]): {
	spawn: SpawnProcess;
	calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
	children: FakeChild[];
} {
	const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
	const children: FakeChild[] = [];
	const spawn: SpawnProcess = (command, args, options) => {
		const transcript = transcripts.shift();
		if (!transcript) throw new Error('No fake transcript queued');
		calls.push({ command, args, env: options.env });
		const child = new FakeChild(
			transcript.stdout ?? '',
			transcript.exitCode === undefined ? 0 : transcript.exitCode,
			transcript.stderr,
			transcript.autoClose ?? true
		);
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

export type SpawnHandler = (
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv
) => FakeTranscript | FakeChild;

/** Route-by-command spawn for discovery tests that probe several binaries. */
export function fakeSpawnHandler(handler: SpawnHandler): {
	spawn: SpawnProcess;
	calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
	children: FakeChild[];
} {
	const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
	const children: FakeChild[] = [];
	const spawn: SpawnProcess = (command, args, options) => {
		calls.push({ command, args, env: options.env });
		const result = handler(command, args, options.env);
		const child =
			result instanceof FakeChild
				? result
				: new FakeChild(
						result.stdout ?? '',
						result.exitCode === undefined ? 0 : result.exitCode,
						result.stderr,
						result.autoClose ?? true
					);
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}
