ALTER TABLE contacts ADD COLUMN lid_jid TEXT;
ALTER TABLE contacts ADD COLUMN phone_jid TEXT;

UPDATE contacts SET lid_jid = jid WHERE jid LIKE '%@lid';
UPDATE contacts SET phone_jid = jid WHERE jid LIKE '%@s.whatsapp.net';

CREATE INDEX IF NOT EXISTS idx_contacts_lid_jid ON contacts(lid_jid);
CREATE INDEX IF NOT EXISTS idx_contacts_phone_jid ON contacts(phone_jid);
