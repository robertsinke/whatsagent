import type { AppDatabase } from './db.js';

export type Contact = {
	jid: string;
	channel: string;
	name: string | null;
	push_name: string | null;
	lid_jid: string | null;
	phone_jid: string | null;
};

export type ContactInput = {
	jid: string;
	channel?: string;
	name?: string | null;
	push_name?: string | null;
	lid_jid?: string | null;
	phone_jid?: string | null;
};

export function upsertContact(db: AppDatabase, contact: ContactInput): void {
	db.prepare(
		`INSERT INTO contacts (jid, channel, name, push_name, lid_jid, phone_jid)
		 VALUES (@jid, @channel, @name, @push_name, @lid_jid, @phone_jid)
		 ON CONFLICT(jid) DO UPDATE SET
		   channel = excluded.channel,
		   name = COALESCE(excluded.name, contacts.name),
		   push_name = COALESCE(excluded.push_name, contacts.push_name),
		   lid_jid = COALESCE(excluded.lid_jid, contacts.lid_jid),
		   phone_jid = COALESCE(excluded.phone_jid, contacts.phone_jid)`
	).run({
		jid: contact.jid,
		channel: contact.channel ?? 'whatsapp',
		name: contact.name ?? null,
		push_name: contact.push_name ?? null,
		lid_jid: contact.lid_jid ?? null,
		phone_jid: contact.phone_jid ?? null
	});
}

export function getContact(db: AppDatabase, jid: string): Contact | undefined {
	return db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid) as Contact | undefined;
}

export function listContacts(db: AppDatabase): Contact[] {
	return db.prepare('SELECT * FROM contacts ORDER BY name ASC, jid ASC').all() as Contact[];
}

/** Resolve either side of a LID/phone identity pair without rewriting messages. */
export function resolveContact(db: AppDatabase, jid: string): Contact | undefined {
	return db
		.prepare(
			`SELECT * FROM contacts
			 WHERE jid = ? OR lid_jid = ? OR phone_jid = ?
			 ORDER BY CASE WHEN name IS NOT NULL THEN 0 ELSE 1 END,
			          CASE WHEN push_name IS NOT NULL THEN 0 ELSE 1 END,
			          CASE WHEN jid = ? THEN 0 ELSE 1 END
			 LIMIT 1`
		)
		.get(jid, jid, jid, jid) as Contact | undefined;
}

export type ContactIdentity = {
	lidJid: string;
	phoneJid: string;
	name?: string | null;
	pushName?: string | null;
};

/** Keep both WhatsApp aliases addressable while sharing the best known contact metadata. */
export function linkContactIdentity(db: AppDatabase, identity: ContactIdentity): void {
	const lid = getContact(db, identity.lidJid);
	const phone = getContact(db, identity.phoneJid);
	const name = identity.name ?? phone?.name ?? lid?.name ?? null;
	const pushName = identity.pushName ?? phone?.push_name ?? lid?.push_name ?? null;

	for (const jid of new Set([identity.lidJid, identity.phoneJid])) {
		upsertContact(db, {
			jid,
			channel: 'whatsapp',
			name,
			push_name: pushName,
			lid_jid: identity.lidJid,
			phone_jid: identity.phoneJid
		});
	}
}
