# PL-S1 MCP spike (throwaway)

Disposable proof that a harness can run with **built-in tools disabled** while
**MCP tools remain callable**, against a **temp fixture dataDir only**.

Nothing here is production quality. Prefer deleting this directory after the
findings are harvested into a plan — keep only the execution-report answers.

## Safety

- `--dataDir` is **required**. No default. No home/app-support fallback.
- `--token` is **required**. HTTP mode refuses missing/wrong `Authorization: Bearer`.
- Stdio mode requires `WHATSAGENT_MCP_TOKEN` to match `--token`.
- Paths resembling live `Application Support/whatsagent` are refused.

## Run

```bash
# 1. Seed a throwaway fixture DB
npx tsx spike/prepare-fixture.ts   # prints absolute temp dataDir

# 2. Install spike-local MCP SDK deps (once)
cd spike && npm install && cd ..

# 3. Start HTTP MCP (keep this process alive)
WHATSAGENT_MCP_TOKEN=… npx tsx spike/mcp-server.ts \
  --dataDir "$DATADIR" --token "$TOKEN" --transport http --port 9412

# 4. Drive a harness — see execution-report.md for the verbatim invocations that worked
```

## Worth keeping?

The three-tool shape + required `dataDir`/`token` are useful design notes.
The hand-rolled Express bearer gate and this directory layout are not.
