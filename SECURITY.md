# Security policy

## Privacy (how this software handles your data)

These are architectural facts, not aspirations:

- **There is no whatsagent server.** The app does not phone home, collect telemetry, require an account, or send crash reports or analytics to the maintainer.
- **The maintainer cannot read your data.** Nothing you store — messages, contacts, drafts, or WhatsApp session material — is transmitted to the project author or any infrastructure they operate. Everything runs on your machine against a local SQLite database.
- **The only network egress you opt into is your chosen LLM provider.** Drafting sends recent conversation text to whichever provider you configured (`claude`, `codex`, or `ollama`). With **`ollama`**, the model runs locally and drafting produces **zero network egress** for LLM traffic.
- **WhatsApp traffic goes to WhatsApp**, as it must for any linked-device client. That is separate from LLM egress and is under your existing WhatsApp account.

For the full privacy table and provider implications, see [README.md § Privacy](README.md#privacy).

## Scope (what we can and cannot protect)

**In scope for this project:**

- Structural guarantee that the agent never sends autonomously (only the outbox pacer can call WhatsApp send, and only for owner-approved or owner-composed messages). See [README.md § Safety and risk](README.md#safety-and-risk).
- Local storage permissions (`0700` data directory, `0600` database file) and macOS keychain encryption for WhatsApp auth blobs.

**Honest limits:**

- The SQLite database holds message history in plaintext on disk.
- WhatsApp auth and signal key blobs in that database are **account-hijack credentials**. Anyone who obtains a copy of the database **and** the keychain key can impersonate your WhatsApp session.
- At-rest encryption protects against offline exposure (synced folders, unencrypted backups, disk images without FileVault). It does **not** protect against malware already running as your user: the keychain item authorizes `/usr/bin/security` without a password prompt, so any process under your account can read the key. See [README.md § Safety and risk](README.md#safety-and-risk) for the full threat model.
- Using Baileys (an unofficial WhatsApp Web client) carries **account-ban risk**. That is a product risk, not a CVE in the traditional sense, but you should understand it before pairing.

## Supported versions

Security fixes are applied to the latest release on the default branch. There is no long-term support matrix for older tags until the project publishes versioned releases.

## Reporting a vulnerability

**Do not open a public GitHub issue for security-sensitive reports.**

Use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred once the repository is published): open the repository's **Security** tab → **Report a vulnerability**. GitHub delivers the report only to maintainers with triage access.
2. If private reporting is not yet enabled on the repository, contact the maintainer through the contact method listed on the repository profile or in the initial release notes, and mark the message **SECURITY**.

Include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept if you have one
- Affected versions or commits, if known

We aim to acknowledge reports within a week and will coordinate disclosure timing with you. We appreciate responsible disclosure.

## What belongs in a security report

Examples of in-scope reports:

- A code path that sends WhatsApp messages without owner approval (violates R9)
- Local API or WebSocket endpoints that bypass localhost origin checks and allow remote mutation
- Credential leakage (auth blobs, keychain material, or draft content) to unexpected third parties beyond the LLM provider the user selected
- Path traversal or arbitrary file read/write in the local server

Out of scope:

- WhatsApp banning your account for using an unofficial client (documented product risk)
- Compromise of your machine by unrelated malware that can already read your keychain
- Issues in third-party dependencies without a demonstrable exploit in whatsagent's usage (report upstream, but tell us if you believe we are uniquely exposed)
