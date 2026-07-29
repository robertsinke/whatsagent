import type { ServerResponse } from 'node:http';
import type { ActionResult } from './types.js';

/**
 * Map an action outcome onto the same HTTP helpers routes.ts already uses.
 * Kept tiny so adapters stay one-liners.
 */
export function writeActionResult(
	res: ServerResponse,
	result: ActionResult,
	helpers: {
		json: (res: ServerResponse, status: number, body: unknown) => void;
		error: (
			res: ServerResponse,
			status: number,
			message: string,
			extra?: Record<string, unknown>
		) => void;
	}
): void {
	if (result.kind === 'error') {
		helpers.error(res, result.status, result.error, result.extra);
		return;
	}
	helpers.json(res, result.status, result.body);
}
