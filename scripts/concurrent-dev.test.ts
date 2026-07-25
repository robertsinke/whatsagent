import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	installSignalHandlers,
	signalChild,
	startConcurrentDev,
	type SpawnFn
} from './concurrent-dev.js';

class FakeChild extends EventEmitter {
	pid: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	readonly kill = vi.fn((signal?: NodeJS.Signals) => {
		if (this.exitCode !== null || this.signalCode) return true;
		this.killed = true;
		this.signalCode = signal ?? 'SIGTERM';
		this.emit('exit', null, this.signalCode);
		return true;
	});

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('concurrent-dev runner', () => {
	it('starts the server and web children with inherited stdio', () => {
		const children: FakeChild[] = [];
		const spawn: SpawnFn = (command, args, options) => {
			const child = new FakeChild(1000 + children.length);
			children.push(child);
			expect(options.stdio).toBe('inherit');
			expect(command === 'tsx' || command === 'vite').toBe(true);
			if (command === 'tsx') expect([...args]).toEqual(['watch', 'server/index.ts']);
			if (command === 'vite') expect([...args]).toEqual(['dev']);
			return child as unknown as ReturnType<SpawnFn>;
		};

		const handle = startConcurrentDev({
			spawn,
			exit: () => undefined,
			log: () => undefined
		});

		expect(handle.children.map((c) => c.name)).toEqual(['server', 'web']);
		expect(children).toHaveLength(2);
	});

	it('forwards shutdown to remaining siblings when one child exits', async () => {
		const children: FakeChild[] = [];
		const spawn: SpawnFn = () => {
			const child = new FakeChild(2000 + children.length);
			children.push(child);
			return child as unknown as ReturnType<SpawnFn>;
		};

		const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
			pid: number,
			signal?: NodeJS.Signals | number
		) => {
			const child = children.find((c) => c.pid === Math.abs(pid));
			if (child && typeof signal === 'string') child.kill(signal);
			return true;
		}) as typeof process.kill);

		const handle = startConcurrentDev({
			spawn,
			killGraceMs: 50,
			exit: () => undefined,
			log: () => undefined
		});

		children[0]!.exit(1, null);
		const code = await handle.done;

		expect(code).toBe(1);
		expect(killSpy).toHaveBeenCalled();
		expect(children[1]!.killed || children[1]!.signalCode).toBeTruthy();
	});

	it('treats SIGINT shutdown as a clean zero exit', async () => {
		const children: FakeChild[] = [];
		const spawn: SpawnFn = () => {
			const child = new FakeChild(3000 + children.length);
			children.push(child);
			return child as unknown as ReturnType<SpawnFn>;
		};

		vi.spyOn(process, 'kill').mockImplementation(((
			pid: number,
			signal?: NodeJS.Signals | number
		) => {
			const child = children.find((c) => c.pid === Math.abs(pid));
			if (child && typeof signal === 'string') child.kill(signal);
			return true;
		}) as typeof process.kill);

		const handle = startConcurrentDev({
			spawn,
			killGraceMs: 50,
			exit: () => undefined,
			log: () => undefined
		});

		await handle.stop('SIGINT');
		const code = await handle.done;
		expect(code).toBe(0);
	});

	it('installSignalHandlers wires SIGINT and SIGTERM to stop', async () => {
		const children: FakeChild[] = [];
		const spawn: SpawnFn = () => {
			const child = new FakeChild(4000 + children.length);
			children.push(child);
			return child as unknown as ReturnType<SpawnFn>;
		};

		vi.spyOn(process, 'kill').mockImplementation(((
			pid: number,
			signal?: NodeJS.Signals | number
		) => {
			const child = children.find((c) => c.pid === Math.abs(pid));
			if (child && typeof signal === 'string') child.kill(signal);
			return true;
		}) as typeof process.kill);

		const handle = startConcurrentDev({
			spawn,
			killGraceMs: 50,
			exit: () => undefined,
			log: () => undefined
		});

		const handlers = new Map<string, () => void>();
		const uninstall = installSignalHandlers(handle, {
			on: (event, listener) => {
				handlers.set(event, listener);
			},
			off: (event) => {
				handlers.delete(event);
			}
		});

		expect(handlers.has('SIGINT')).toBe(true);
		expect(handlers.has('SIGTERM')).toBe(true);
		handlers.get('SIGINT')!();
		await handle.done;
		uninstall();
		expect(handlers.size).toBe(0);
	});

	it('signalChild no-ops once a child has already exited', () => {
		const child = new FakeChild(5000);
		child.exit(0, null);
		const killSpy = vi.spyOn(process, 'kill');
		signalChild(child as unknown as import('node:child_process').ChildProcess, 'SIGTERM');
		expect(killSpy).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
	});
});
