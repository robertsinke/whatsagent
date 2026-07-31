/**
 * Google Calendar App Password storage.
 *
 * The password is a durable Google-account credential — treat it like the
 * WhatsApp auth blobs. AES-256-GCM with the key in the macOS login keychain,
 * under a calendar-specific service so a calendar credential can never unlock
 * WhatsApp account credentials (`whatsagent.whatsapp-auth`).
 *
 * Odysseus trap (binding): that app decrypts on its READ path and not its WRITE
 * path, so writes 401 while the agent reports success. Decrypt in EVERY path
 * that uses the credential. The only accessor that returns a usable password is
 * {@link getCalendarCredentials} — connect, list, and (later) confirm-gated
 * writes must all go through it. Do not add a second reader.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import type { AppDatabase } from '../store/db.js';
import { deleteSetting, getSetting, setSetting } from '../store/settings.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Distinct from `whatsagent.whatsapp-auth` — never share the WhatsApp key. */
const KEYCHAIN_SERVICE = 'whatsagent.google-calendar';

export const CALENDAR_SERVER_URL_SETTING = 'calendar_server_url';
export const CALENDAR_EMAIL_SETTING = 'calendar_email';
/** Base64(iv || tag || ciphertext). Never returned by listEffectiveSettings. */
export const CALENDAR_PASSWORD_ENC_SETTING = 'calendar_password_enc';

export type CalendarCredentials = {
	serverUrl: string;
	email: string;
	/** Always plaintext after {@link getCalendarCredentials}. */
	password: string;
};

function assertEncryptionKey(key: Buffer): void {
	if (key.byteLength !== KEY_BYTES) {
		throw new Error(`Calendar encryption key must be ${KEY_BYTES} bytes`);
	}
}

function encryptPassword(plaintext: string, key: Buffer): string {
	assertEncryptionKey(key);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decryptPassword(encoded: string, key: Buffer): string {
	assertEncryptionKey(key);
	const blob = Buffer.from(encoded, 'base64');
	if (blob.byteLength < IV_BYTES + TAG_BYTES) {
		throw new Error('Encrypted calendar password is truncated');
	}
	const iv = blob.subarray(0, IV_BYTES);
	const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Load the calendar master key from the macOS login keychain, creating it once
 * if absent. Separate service from WhatsApp auth — see module header.
 */
export function loadCalendarEncryptionKey(
	service = KEYCHAIN_SERVICE,
	account = userInfo().username
): Buffer {
	if (process.platform !== 'darwin') {
		throw new Error('Calendar credential keychain storage currently requires macOS');
	}

	let encoded: string;
	try {
		encoded = execFileSync(
			'security',
			['find-generic-password', '-s', service, '-a', account, '-w'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		).trim();
	} catch {
		encoded = randomBytes(KEY_BYTES).toString('base64');
		execFileSync(
			'security',
			['add-generic-password', '-U', '-s', service, '-a', account, '-w', encoded],
			{ stdio: 'ignore' }
		);
	}

	const key = Buffer.from(encoded, 'base64');
	assertEncryptionKey(key);
	return key;
}

/**
 * THE credential accessor. Always decrypts. Callers that need a password for
 * CalDAV — read or write — must use this function and no other.
 */
export function getCalendarCredentials(
	db: AppDatabase,
	encryptionKey?: Buffer
): CalendarCredentials | null {
	const key = encryptionKey ?? loadCalendarEncryptionKey();
	const serverUrl = getSetting(db, CALENDAR_SERVER_URL_SETTING)?.trim();
	const email = getSetting(db, CALENDAR_EMAIL_SETTING)?.trim();
	const enc = getSetting(db, CALENDAR_PASSWORD_ENC_SETTING)?.trim();
	if (!serverUrl || !email || !enc) return null;
	return {
		serverUrl,
		email,
		password: decryptPassword(enc, key)
	};
}

/** Encrypt and persist. After this, only {@link getCalendarCredentials} may read the password. */
export function saveCalendarCredentials(
	db: AppDatabase,
	creds: CalendarCredentials,
	encryptionKey?: Buffer
): void {
	const key = encryptionKey ?? loadCalendarEncryptionKey();
	const serverUrl = creds.serverUrl.trim();
	const email = creds.email.trim();
	const password = creds.password;
	if (!serverUrl || !email || !password) {
		throw new Error('Calendar credentials require serverUrl, email, and password');
	}
	setSetting(db, CALENDAR_SERVER_URL_SETTING, serverUrl);
	setSetting(db, CALENDAR_EMAIL_SETTING, email);
	setSetting(db, CALENDAR_PASSWORD_ENC_SETTING, encryptPassword(password, key));
}

export function clearCalendarCredentials(db: AppDatabase): void {
	deleteSetting(db, CALENDAR_SERVER_URL_SETTING);
	deleteSetting(db, CALENDAR_EMAIL_SETTING);
	deleteSetting(db, CALENDAR_PASSWORD_ENC_SETTING);
}

/** Public (non-secret) view for Settings / listEffectiveSettings. */
export function calendarConnectionPublicView(db: AppDatabase): {
	calendar_configured: 'true' | 'false';
	calendar_server_url: string;
	calendar_email: string;
} {
	const serverUrl = getSetting(db, CALENDAR_SERVER_URL_SETTING)?.trim() ?? '';
	const email = getSetting(db, CALENDAR_EMAIL_SETTING)?.trim() ?? '';
	const enc = getSetting(db, CALENDAR_PASSWORD_ENC_SETTING)?.trim();
	return {
		calendar_configured: enc ? 'true' : 'false',
		calendar_server_url: serverUrl,
		calendar_email: email
	};
}

/**
 * Strip the ciphertext from a settings map before it leaves the process.
 * Ciphertext is not the password, but the Settings GET must never carry it.
 */
export function redactCalendarSecrets(
	settings: Record<string, string>
): Record<string, string> {
	const { [CALENDAR_PASSWORD_ENC_SETTING]: _drop, ...rest } = settings;
	return rest;
}
