import type { AppDatabase } from './db.js';

export type Contact = {
	jid: string;
	channel: string;
	name: string | null;
	push_name: string | null;
};

export type ContactInput = {
	jid: string;
	channel?: string;
	name?: string | null;
	push_name?: string | null;
};

export function upsertContact(db: AppDatabase, contact: ContactInput): void {
	db.prepare(
		`INSERT INTO contacts (jid, channel, name, push_name)
		 VALUES (@jid, @channel, @name, @push_name)
		 ON CONFLICT(jid) DO UPDATE SET
		   channel = excluded.channel,
		   name = excluded.name,
		   push_name = excluded.push_name`
	).run({
		jid: contact.jid,
		channel: contact.channel ?? 'whatsapp',
		name: contact.name ?? null,
		push_name: contact.push_name ?? null
	});
}

export function getContact(db: AppDatabase, jid: string): Contact | undefined {
	return db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid) as Contact | undefined;
}

export function listContacts(db: AppDatabase): Contact[] {
	return db.prepare('SELECT * FROM contacts ORDER BY name ASC, jid ASC').all() as Contact[];
}
