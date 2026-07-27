# Contributing to whatsagent

Thank you for your interest in contributing. This project is a local, single-user WhatsApp client with an AI drafting agent. Before you run or pair anything, read the risk and privacy sections in [README.md](README.md):

- [Privacy](README.md#privacy) — no server, no telemetry, no maintainer access to your data; the only egress is the LLM provider you choose (zero egress with Ollama).
- [Safety and risk](README.md#safety-and-risk) — Baileys account-ban risk, the no-autonomous-send invariant (R9), outbox pacing, and honest limits of at-rest encryption.

## Prerequisites

- **Node.js 20+** and **npm**
- **macOS** for WhatsApp auth encryption (login keychain). Other platforms are not supported for the encrypted auth store yet.
- At least one draft provider you intend to use: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [Ollama](https://ollama.com).

## Development setup

```bash
git clone <repository-url>
cd whatsagent
npm install
npm run dev
```

Open `http://localhost:5173` for the SPA; the backend listens on `http://127.0.0.1:8787`.

## Quality gates

Before opening a pull request, run:

```bash
npm run check
npm test
npm run build
```

CI runs `npm run check` and `npm test` on every pull request.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep changes focused; match existing code style and conventions in `CLAUDE.md`.
3. Add or update tests when behavior changes.
4. Fill out the pull request template, including how you verified the change.

Do not commit secrets, app-data SQLite files, WhatsApp auth blobs, screenshots of live chats, or real phone numbers in fixtures. Use the shared test fixtures module for synthetic identifiers.

## Security issues

Do not open public GitHub issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for the private disclosure process.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.
