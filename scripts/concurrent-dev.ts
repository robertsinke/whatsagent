/**
 * One-command development runner: persistent Node backend + Vite SPA.
 * Forwards SIGINT/SIGTERM to both process groups and waits for clean exit.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => ChildProcess;

export type ConcurrentChildSpec = {
	name: string;
	command: string;
	args: readonly string[];
};

export type ConcurrentDevOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnFn;
	children?: readonly ConcurrentChildSpec[];
	/** Grace period after SIGTERM before SIGKILL (ms). */
	killGraceMs?: number;
	signal?: AbortSignal;
	exit?: (code: number) => void;
	log?: (message: string) => void;
};

export type StartedChild = {
	name: string;
	process: ChildProcess;
};

export type ConcurrentDevHandle = {
	children: readonly StartedChild[];
	stop: (signal?: NodeJS.Signals) => Promise<void>;
	done: Promise<number>;
};

const DEFAULT_CHILDREN: readonly ConcurrentChildSpec[] = [
	{ name: 'server', command: 'tsx', args: ['watch', 'server/index.ts'] },
	{ name: 'web', command: 'vite', args: ['dev'] }
];

function useProcessGroups(): boolean {
	return process.platform !== 'win32';
}

export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode) return;
	const pid = child.pid;
	if (pid === undefined) return;

	if (useProcessGroups()) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// Fall through to direct kill if the group is already gone.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Already exited.
	}
}

export function startConcurrentDev(options: ConcurrentDevOptions = {}): ConcurrentDevHandle {
	const spawnFn = options.spawn ?? spawn;
	const specs = options.children ?? DEFAULT_CHILDREN;
	const killGraceMs = options.killGraceMs ?? 5_000;
	const log = options.log ?? ((message) => console.error(message));
	const exitFn = options.exit;

	const started: StartedChild[] = [];
	let stopping = false;
	let resolveDone!: (code: number) => void;
	const done = new Promise<number>((resolve) => {
		resolveDone = resolve;
	});

	const exits = new Map<string, { code: number | null; signal: NodeJS.Signals | null }>();

	function finishIfComplete(): void {
		if (exits.size < started.length) return;
		let code = 0;
		for (const result of exits.values()) {
			if (result.signal && result.signal !== 'SIGINT' && result.signal !== 'SIGTERM') {
				code = 1;
			} else if (typeof result.code === 'number' && result.code !== 0) {
				code = result.code;
			}
		}
		resolveDone(code);
		exitFn?.(code);
	}

	for (const spec of specs) {
		const child = spawnFn(spec.command, [...spec.args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: 'inherit',
			// Own process group on POSIX so Ctrl+C is handled by this runner
			// and forwarded cleanly to the whole tree (tsx watch → children).
			detached: useProcessGroups(),
			shell: false
		});

		started.push({ name: spec.name, process: child });

		child.on('error', (error) => {
			log(`[dev] failed to start ${spec.name}: ${error.message}`);
			if (!exits.has(spec.name)) {
				exits.set(spec.name, { code: 1, signal: null });
				if (!stopping) void stop('SIGTERM');
				finishIfComplete();
			}
		});

		child.on('exit', (code, signal) => {
			if (!exits.has(spec.name)) {
				exits.set(spec.name, { code, signal });
			}
			if (!stopping) {
				log(`[dev] ${spec.name} exited (${signal ?? code}); stopping siblings`);
				void stop('SIGTERM');
			}
			finishIfComplete();
		});
	}

	async function stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
		if (stopping) return;
		stopping = true;
		log(`[dev] shutting down (${signal})…`);

		for (const { process: child } of started) {
			signalChild(child, signal);
		}

		const grace = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, killGraceMs);
			void done.finally(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		await grace;

		if (exits.size < started.length) {
			for (const { process: child } of started) {
				signalChild(child, 'SIGKILL');
			}
		}
	}

	const onAbort = () => {
		void stop('SIGTERM');
	};
	options.signal?.addEventListener('abort', onAbort, { once: true });

	void done.finally(() => {
		options.signal?.removeEventListener('abort', onAbort);
	});

	return {
		children: started,
		stop,
		done
	};
}

export function installSignalHandlers(
	handle: ConcurrentDevHandle,
	hooks: {
		on?: (event: NodeJS.Signals, listener: () => void) => void;
		off?: (event: NodeJS.Signals, listener: () => void) => void;
	} = {}
): () => void {
	const on = hooks.on ?? ((event, listener) => process.on(event, listener));
	const off = hooks.off ?? ((event, listener) => process.off(event, listener));

	const onSigInt = () => {
		void handle.stop('SIGINT');
	};
	const onSigTerm = () => {
		void handle.stop('SIGTERM');
	};

	on('SIGINT', onSigInt);
	on('SIGTERM', onSigTerm);

	return () => {
		off('SIGINT', onSigInt);
		off('SIGTERM', onSigTerm);
	};
}

async function main(): Promise<void> {
	const handle = startConcurrentDev();
	const uninstall = installSignalHandlers(handle);
	const code = await handle.done;
	uninstall();
	process.exit(code);
}

const entry = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (
	typeof entry === 'string' &&
	(thisFile === entry ||
		entry.replace(/\\/g, '/').endsWith('/scripts/concurrent-dev.ts') ||
		entry.replace(/\\/g, '/').endsWith('/scripts/concurrent-dev.js'))
) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
