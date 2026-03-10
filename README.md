# 🦞 singleclaw
### *fuck around and find out*

> A self-improving AI agent in ~1000 lines of TypeScript. One file. No frameworks. No bullshit.

---

## What is this?

**singleclaw** is a single-file agentic AI that thinks, writes code, runs it, remembers what happened, and gets smarter over time — all powered by AWS Bedrock (Claude Sonnet) and a SQLite brain.

It has a shell. It has memory. It has a plan/parallel task DAG. It will write files, run commands, install its own skills from GitHub, and search the web. It will also summarize its own memory when it gets too long.

You give it a goal. It figures the rest out.

---

## Architecture (the 30-second version)

```
User message
    ↓
Express /chat  →  session queue (no interleaved chaos)
    ↓
Agent loop (up to 20 iterations)
    ├── Build system prompt  (soul.md + user.md + memory.md + tool catalog)
    ├── RAG inject           (always-on semantic context)
    ├── Bedrock stream       (Claude Sonnet, exponential backoff)
    ├── Parse decision JSON  (action: code | plan | reply | done)
    │
    ├── code   → Worker thread sandbox → tool dispatch → result
    ├── plan   → Parallel sub-task DAG → recursive runAgent()
    └── reply  → Stream to WebSocket → done
    ↓
Memory dedup + SQLite + memory.md size cap
```

---

## Features

### 🧠 Self-Improving Memory
- SQLite vector store with Titan embeddings (cosine similarity dedup at 0.93 threshold)
- `memory.md` auto-summarized every N turns or when it hits the line cap
- Agent writes its own `soul.md` (identity) and `user.md` (who you are) naturally through conversation — never asks all at once

### 🛠️ Tool Suite
| Category | Tools |
|---|---|
| **Filesystem** | `fs_read`, `fs_write`, `fs_append`, `fs_list`, `fs_delete`, `fs_move`, `fs_exists`, `fs_stat` |
| **Shell** | `shell(cmd, cwd?)` — blocklist protected |
| **Memory** | `memory_save`, `memory_search`, `memory_note` |
| **Skills** | `skill_install("owner/repo")` — fetches from GitHub |
| **RAG** | `search_files(query, dirs?)` — semantic, ranked |
| **Database** | `db_run(sql, params?)` |
| **HTTP** | `http_get`, `http_post` |
| **Embeddings** | `get_embedding`, `cosine_similarity` |

### ⚡ Sandboxed Code Execution
- Runs agent-generated JS in `worker_threads` (not `eval` in main thread)
- Hard kill timeout (default 60s) — no VM timeout leaks
- Tools bridged via message-passing: worker requests → main thread dispatches → result returned

### 📋 Parallel Task DAG
- Agent can decompose goals into sub-tasks with explicit dependencies
- Ready tasks run in parallel (`Promise.all`), respecting dep order
- Each sub-task is a recursive `runAgent()` call, queued per-session

### 🔌 Skills System
- Agent can `skill_install("owner/repo")` to pull `SKILL.md` + referenced files from GitHub
- Hot-reload watcher clears embed cache on skill changes
- Agent checks for existing skills before reinventing the wheel

### 📡 Real-time WebSocket
- Streams thinking, code execution, and replies chunk-by-chunk
- Events: `thinking_start/end`, `stream_chunk`, `code_start/end`, `decision`, `plan`, `subtask`, `reply_start/end`, `skills_reload`

### 🛡️ Security
- All paths resolved and jail-checked against `agent/`, `workspace/`, `skills/`
- Shell blocklist: `rm -rf /`, fork bombs, `mkfs`, `dd`, etc.
- Secrets → `.env` only, never in code blocks
- Message size limit (64KB), context budget compression at 120K chars

---

## Quick Start

### Prerequisites
- Node.js 20+
- AWS credentials with Bedrock access (Claude Sonnet + Titan Embed)
- `tsx` installed globally or via npx

### Install

```bash
git clone https://github.com/yourname/singleclaw
cd singleclaw
npm install
```

### Dependencies

```bash
npm install @aws-sdk/client-bedrock-runtime better-sqlite3 express ws dotenv
npm install -D @types/node @types/express @types/ws @types/better-sqlite3 tsx typescript
```

### Configure

```bash
cp .env.example .env
```

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret

# Optional overrides
PORT=3000
MAX_ITER=20
SANDBOX_TIMEOUT=60000
CTX_BUDGET_CHARS=120000
MEM_MAX_LINES=150
MEM_SUM_EVERY=10
DEBUG=true
```

### Run

```bash
npx tsx agent.ts
```

Open `http://localhost:3000` and start talking.

---

## Directory Structure

```
singleclaw/
├── agent.ts          ← the whole thing
├── public/
│   └── index.html    ← chat UI
├── agent/            ← agent identity + memory (auto-created)
│   ├── soul.md       ← agent's name, personality (written by agent)
│   ├── user.md       ← your name, preferences (written by agent)
│   ├── memory.md     ← running notes, auto-summarized
│   └── db.sqlite     ← vector store + tasks + messages
├── workspace/        ← agent's working directory (sandboxed)
└── skills/           ← installed skills from GitHub
```

---

## API

```
POST /chat           { message, session? }  →  { reply }
GET  /memories       → all stored memories
GET  /tasks          → recent 100 tasks + sub-tasks
GET  /messages       → recent 60 messages
GET  /identity       → soul.md + user.md + memory.md
GET  /metrics        → avg turn latency, memory count, task count
GET  /health         → status, model, dirs, active sessions
```

---

## How the Agent Thinks

Every turn, the agent returns a single raw JSON object — no markdown, no preamble:

```json
{
  "reasoning":  "step-by-step thinking",
  "action":     "code | plan | reply | done",
  "code":       "JS — await supported, console.log() captures output",
  "plan":       [{"goal": "sub-task", "deps": ["0"]}],
  "reply":      "message to user",
  "note":       "short note for memory.md (optional)",
  "confidence": 0.85
}
```

The loop runs up to `MAX_ITER` times (default 20). A `work_log` is maintained across iterations so the agent never forgets what it already did mid-task.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `REASON_MODEL` | `global.anthropic.claude-sonnet-4-5-...` | Claude model ID |
| `EMBED_MODEL` | `amazon.titan-embed-text-v2:0` | Embedding model |
| `PORT` | `3000` | HTTP port |
| `MAX_ITER` | `20` | Max agent iterations per turn |
| `MEM_SUM_EVERY` | `10` | Summarize memory.md every N turns |
| `MEM_MAX_LINES` | `150` | Force early summarization above this |
| `CTX_BUDGET_CHARS` | `120000` | Compress history above this |
| `SANDBOX_TIMEOUT` | `60000` | Worker kill timeout (ms) |
| `MSG_MAX_BYTES` | `65536` | Max incoming message size |
| `SHELL_BLOCKLIST` | `rm -rf /,...` | Comma-separated blocked commands |
| `DEBUG` | — | Enable debug logging |

---

## Caveats

- The agent **will** run shell commands. Point it at a VM or container if you're paranoid (you should be).
- SQLite is single-writer. Fine for local use; not for multi-node.
- The worker sandbox is `worker_threads`, not a proper VM. Don't feed it untrusted user input directly.
- Bedrock costs real money. Watch your token usage.

---

## Name

A **singleclaw** is a crab that lost one claw and learned to be more dangerous with the one it kept.

This agent has one file. That's the claw. Fuck around and find out.

---

## License

MIT