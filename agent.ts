#!/usr/bin/env tsx
// ============================================================
// agent.ts — Single-file AI Agent
//
//  Dirs:    agent/  workspace/  skills/
//  Brain:   Bedrock streaming (Claude Sonnet + Titan embeds)
//  Hands:   fs, shell, http, memory, db — path-guarded
//  Sandbox: worker_threads (hard kill, no vm timeout leaks)
//  Memory:  SQLite vectors + memory.md (dedup + size cap)
//  RAG:     Always-on — injected into EVERY model call
//  Loop:    work-log + context budget + plan/parallel DAG
//  Server:  Express + WebSocket + graceful shutdown
// ============================================================

import {
  BedrockRuntimeClient, ConverseStreamCommand, InvokeModelCommand,
  type ConverseStreamCommandInput, type ContentBlock, type Message,
} from "@aws-sdk/client-bedrock-runtime";
import Database       from "better-sqlite3";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Worker } from "node:worker_threads";
import * as fs        from "node:fs/promises";
import * as fsSync    from "node:fs";
import * as path      from "node:path";
import { exec }       from "node:child_process";
import { promisify }  from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import dotenv         from "dotenv";

dotenv.config();

const execAsync = promisify(exec);

// ─────────────────────────────────────────────────────────────
// Main thread
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const CFG = {
  agentDir:    process.env.AGENT_DIR      ?? "agent",
  workDir:     process.env.WORK_DIR       ?? "workspace",
  skillsDir:   process.env.SKILLS_DIR     ?? "skills",
  dbPath:      process.env.DB_PATH        ?? "agent/db.sqlite",
  port:        parseInt(process.env.PORT  ?? "3000"),
  region:      process.env.AWS_REGION     ?? "us-east-1",
  reasonModel: process.env.REASON_MODEL   ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  embedModel:  process.env.EMBED_MODEL    ?? "amazon.titan-embed-text-v2:0",
  maxIter:        parseInt(process.env.MAX_ITER         ?? "20"),
  memSumEvery:    parseInt(process.env.MEM_SUM_EVERY    ?? "10"),
  memMaxLines:    parseInt(process.env.MEM_MAX_LINES    ?? "150"),
  ctxBudgetChars: parseInt(process.env.CTX_BUDGET_CHARS ?? "120000"),
  sandboxTimeout: parseInt(process.env.SANDBOX_TIMEOUT  ?? "60000"),
  msgMaxBytes:    parseInt(process.env.MSG_MAX_BYTES     ?? "65536"),
  embedDim:    512,
  shellBlocklist: (process.env.SHELL_BLOCKLIST ?? "rm -rf /,:(){ :|:& };:,mkfs,dd if=").split(","),
} as const;

const ROOTS = [path.resolve(CFG.agentDir), path.resolve(CFG.workDir), path.resolve(CFG.skillsDir)];

// ─────────────────────────────────────────────────────────────
// Structured logger
// ─────────────────────────────────────────────────────────────

const log = {
  _fmt: (level: string, msg: string, meta?: Record<string, unknown>) =>
    `${new Date().toISOString()} [${level.padEnd(5)}] ${msg}${meta ? " " + JSON.stringify(meta) : ""}`,
  info:  (msg: string, meta?: Record<string, unknown>) => console.log(log._fmt("INFO",  msg, meta)),
  warn:  (msg: string, meta?: Record<string, unknown>) => console.warn(log._fmt("WARN",  msg, meta)),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(log._fmt("ERROR", msg, meta)),
  debug: (msg: string, meta?: Record<string, unknown>) => { if (process.env.DEBUG) console.log(log._fmt("DEBUG", msg, meta)); },
};

// ─────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  let abs: string;
  if (path.isAbsolute(p)) {
    abs = p;
  } else if (
    p.startsWith("agent/") || p === "agent" ||
    p.startsWith("workspace/") || p === "workspace" ||
    p.startsWith("skills/") || p === "skills"
  ) {
    abs = path.resolve(p);
  } else {
    abs = path.resolve(CFG.workDir, p); // bare paths → workspace/
  }
  if (!ROOTS.some(r => abs === r || abs.startsWith(r + path.sep)))
    throw new Error(`Path "${abs}" is outside allowed dirs`);
  return abs;
}

// ─────────────────────────────────────────────────────────────
// Bootstrap dirs + identity stubs
// ─────────────────────────────────────────────────────────────

for (const d of [CFG.agentDir, CFG.workDir, CFG.skillsDir])
  await fs.mkdir(d, { recursive: true });

async function readMd(file: string): Promise<string> {
  try { return await fs.readFile(path.join(CFG.agentDir, file), "utf8"); } catch { return ""; }
}
async function writeMd(file: string, content: string) {
  await fs.writeFile(path.join(CFG.agentDir, file), content, "utf8");
}

// Identity files start empty — agent fills them naturally via fs_write
// memory.md gets a heading so appends have context
if (!await readMd("memory.md")) await writeMd("memory.md", `# Memory\n`);

// ─────────────────────────────────────────────────────────────
// Onboarding
// ─────────────────────────────────────────────────────────────

async function getAgentName(): Promise<string> {
  const soul = await readMd("soul.md");
  return soul.match(/[Nn]ame:\s*(.+)/)?.[1]?.trim() ?? "Agent";
}

// ─────────────────────────────────────────────────────────────
// SQLite
// ─────────────────────────────────────────────────────────────

const db = new Database(CFG.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, content TEXT NOT NULL,
    embedding TEXT, tags TEXT DEFAULT '[]', source TEXT DEFAULT 'agent', ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    parentId TEXT, deps TEXT DEFAULT '[]', result TEXT, error TEXT,
    startedAt INTEGER, completedAt INTEGER,
    ts INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, session TEXT, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turn_count (
    session TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY, type TEXT, session TEXT, durationMs INTEGER, ts INTEGER
  );
`);

const sql = {
  insertMem:   db.prepare(`INSERT INTO memories VALUES(@id,@content,@embedding,@tags,@source,@ts)`),
  allMem:      db.prepare(`SELECT * FROM memories ORDER BY ts DESC LIMIT 400`),
  insertTask:  db.prepare(`INSERT INTO tasks(id,goal,status,parentId,deps,result,error,startedAt,completedAt,ts,updatedAt) VALUES(@id,@goal,@status,@parentId,@deps,@result,@error,@startedAt,@completedAt,@ts,@updatedAt)`),
  updateTask:  db.prepare(`UPDATE tasks SET status=@status,result=@result,error=@error,completedAt=@completedAt,updatedAt=@updatedAt WHERE id=@id`),
  getTask:     db.prepare(`SELECT * FROM tasks WHERE id=?`),
  insertMsg:   db.prepare(`INSERT INTO messages VALUES(@id,@role,@content,@session,@ts)`),
  recentMsgs:  db.prepare(`SELECT * FROM messages ORDER BY ts DESC LIMIT 60`),
  turnGet:     db.prepare(`SELECT n FROM turn_count WHERE session=?`),
  turnUpsert:  db.prepare(`INSERT INTO turn_count(session,n) VALUES(@session,@n) ON CONFLICT(session) DO UPDATE SET n=@n`),
  insertMetric:db.prepare(`INSERT INTO metrics VALUES(@id,@type,@session,@durationMs,@ts)`),
};

function getTurns(s: string): number { return (sql.turnGet.get(s) as { n: number } | undefined)?.n ?? 0; }
function incTurns(s: string): number { const n = getTurns(s)+1; sql.turnUpsert.run({ session:s, n }); return n; }

function recordMetric(type: string, session: string, durationMs: number) {
  sql.insertMetric.run({ id: randomUUID(), type, session, durationMs, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────
// Bedrock client + embeddings
// ─────────────────────────────────────────────────────────────

const bedrock    = new BedrockRuntimeClient({ region: CFG.region });
const embedCache = new Map<string, number[]>();

async function embed(text: string): Promise<number[]> {
  const key = text.slice(0, 128);
  if (embedCache.has(key)) return embedCache.get(key)!;
  try {
    const res = await bedrock.send(new InvokeModelCommand({
      modelId: CFG.embedModel, contentType: "application/json", accept: "application/json",
      body: Buffer.from(JSON.stringify({ inputText: text.slice(0, 8192), dimensions: CFG.embedDim, normalize: true })),
    }));
    const v = (JSON.parse(Buffer.from(res.body).toString()) as { embedding: number[] }).embedding;
    embedCache.set(key, v);
    return v;
  } catch { return hashEmbed(text, CFG.embedDim); }
}

function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = (h * 16777619) >>> 0; }
    for (let d = 0; d < dim; d++) v[d]! += (((h + d * 2654435761) >>> 0) % 200) / 100 - 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) + 1e-8;
  return v.map(x => x / n);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / (Math.sqrt(na * nb) + 1e-8);
}

// ─────────────────────────────────────────────────────────────
// Bedrock streaming — exponential backoff with jitter
// ─────────────────────────────────────────────────────────────

async function callModel(
  system:   string,
  messages: Message[],
  onChunk:  (text: string) => void,
): Promise<string> {
  log.info("callModel enter", { msgCount: messages.length });

  const input: ConverseStreamCommandInput = {
    modelId: CFG.reasonModel, system: [{ text: system }], messages,
    inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
  };
  const t0 = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await bedrock.send(new ConverseStreamCommand(input));
      let full = "";
      for await (const event of res.stream!) {
        const chunk = event.contentBlockDelta?.delta?.text;
        if (chunk) { full += chunk; onChunk(chunk); }
        if (event.messageStop) break;
      }
      log.debug("callModel ok", { chars: full.length, ms: Date.now() - t0, attempt });
      return full;
    } catch (e: unknown) {
      const name = (e as { name?: string }).name ?? "";
      const isRetryable = name === "ThrottlingException" || name === "ServiceUnavailableException" || name === "ModelStreamErrorException";
      if (isRetryable && attempt < 3) {
        // exponential backoff with jitter: base * 2^attempt + jitter(0..1000ms)
        const wait = Math.min(30000, 1000 * Math.pow(2, attempt) + Math.random() * 1000);
        log.warn("Bedrock retry", { name, attempt, waitMs: Math.round(wait) });
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Bedrock unreachable after retries");
}

// ─────────────────────────────────────────────────────────────
// Context window budget — compress history when too large
// ─────────────────────────────────────────────────────────────

function historyChars(history: Message[]): number {
  return history.reduce((sum, m) => {
    const text = (m.content as ContentBlock[])
      .filter((b): b is ContentBlock & { text: string } => "text" in b)
      .map(b => b.text).join("");
    return sum + text.length;
  }, 0);
}

async function compressHistory(history: Message[]): Promise<Message[]> {
  if (history.length <= 6 || historyChars(history) < CFG.ctxBudgetChars) return history;

  const head   = history.slice(0, 2);
  const tail   = history.slice(-4);
  const middle = history.slice(2, -4);
  if (!middle.length) return history;

  log.info("Compressing history", { totalMsgs: history.length, middleMsgs: middle.length });

  const middleText = middle.map(m => {
    const role = m.role;
    const text = (m.content as ContentBlock[]).filter((b): b is ContentBlock & { text: string } => "text" in b).map(b => b.text).join("").slice(0, 800);
    return `[${role}]: ${text}`;
  }).join("\n\n");

  const summary = await callModel(
    "Summarize these conversation turns into a compact but complete record. Preserve every action taken, result, decision, file written, and current state. Be specific. Output only the summary.",
    [{ role: "user", content: [{ text: middleText } as ContentBlock] }],
    () => {},
  );

  return [
    ...head,
    { role: "user", content: [{ text: `[HISTORY SUMMARY — ${middle.length} turns compressed]\n${summary}` } as ContentBlock] },
    ...tail,
  ];
}

// ─────────────────────────────────────────────────────────────
// Memory — with dedup and size cap
// ─────────────────────────────────────────────────────────────

async function memorySave(content: string, tags: string[] = [], source = "agent"): Promise<string> {
  const embedding = await embed(content);

  // Dedup — skip if a very similar memory already exists (cosine > 0.93)
  const existing = sql.allMem.all() as Array<{ id: string; content: string; embedding: string | null }>;
  for (const row of existing.slice(0, 50)) { // check recent 50
    if (!row.embedding) continue;
    const sim = cosine(embedding, JSON.parse(row.embedding) as number[]);
    if (sim > 0.93) {
      log.debug("Memory dedup skip", { sim: sim.toFixed(3), preview: content.slice(0, 60) });
      return row.id;
    }
  }

  const id = randomUUID();
  sql.insertMem.run({ id, content, embedding: JSON.stringify(embedding), tags: JSON.stringify(tags), source, ts: Date.now() });
  return id;
}

async function memorySearch(query: string, topK = 6) {
  const qv = await embed(query);
  return (sql.allMem.all() as Array<{ content: string; embedding: string | null; source: string; ts: number }>)
    .map(r => ({ content: r.content, source: r.source, ts: r.ts, score: r.embedding ? cosine(qv, JSON.parse(r.embedding) as number[]) : 0 }))
    .sort((a, b) => b.score - a.score).slice(0, topK)
    .filter(r => r.score > 0.3); // only return reasonably relevant
}

async function appendMemoryNote(note: string) {
  const p = path.join(CFG.agentDir, "memory.md");
  await fs.appendFile(p, `\n## ${new Date().toLocaleString()}\n${note.trim()}\n`, "utf8");

  // Size cap — if too many lines, trigger early summarization
  const content = await fs.readFile(p, "utf8");
  if (content.split("\n").length > CFG.memMaxLines) {
    log.info("memory.md cap reached, summarizing early");
    await summarizeMemoryMd();
  }
}

async function summarizeMemoryMd() {
  const current = await readMd("memory.md");
  if (current.split("\n").length < 20) return;
  const summary = await callModel(
    "Summarize the notes below into tight bullet points. Preserve all names, decisions, preferences, and facts. Output only the summary in markdown.",
    [{ role: "user", content: [{ text: current } as ContentBlock] }],
    () => {},
  );
  await writeMd("memory.md", `# Memory Notes\n\n_Summarized ${new Date().toLocaleString()}_\n\n${summary}\n`);
}

async function maybeSummarizeMemory(session: string) {
  const n = getTurns(session);
  if (n % CFG.memSumEvery === 0 && n > 0) await summarizeMemoryMd();
}

// ─────────────────────────────────────────────────────────────
// Semantic file search
// ─────────────────────────────────────────────────────────────

async function searchFiles(query: string, dirs: string[], topK = 6): Promise<string[]> {
  const qv = await embed(query);
  const hits: Array<{ file: string; score: number }> = [];
  async function walk(dir: string) {
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }) as fsSync.Dirent[]; } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".")) { await walk(full); continue; }
      if (e.isFile() && /\.(md|txt|ts|js|mjs|json|yaml|yml|sh|py|toml)$/.test(e.name)) {
        try { hits.push({ file: full, score: cosine(qv, await embed((await fs.readFile(full, "utf8")).slice(0, 800))) }); }
        catch { /* skip */ }
      }
    }
  }
  for (const d of dirs) await walk(d);
  return hits.sort((a, b) => b.score - a.score).slice(0, topK).filter(h => h.score > 0.25).map(h => h.file);
}

// ─────────────────────────────────────────────────────────────
// Skills hot-reload watcher
// ─────────────────────────────────────────────────────────────

function watchSkills() {
  try {
    fsSync.watch(CFG.skillsDir, { recursive: true }, (event, filename) => {
      if (filename) {
        embedCache.clear(); // force re-embed on next search
        log.info("Skills changed, embed cache cleared", { event, filename });
        broadcast("skills_reload", { filename });
      }
    });
  } catch { /* skills dir may not exist yet */ }
}

// ─────────────────────────────────────────────────────────────
// Worker-thread sandbox
// ─────────────────────────────────────────────────────────────

const TOOL_NAMES = [
  "fs_read","fs_write","fs_append","fs_list","fs_delete","fs_move","fs_exists","fs_stat",
  "shell","memory_save","memory_search","memory_note",
  "skill_install","search_files","db_run","http_get","http_post",
  "get_embedding","cosine_similarity",
];

// Actual tool implementations — called when worker requests them
async function dispatchTool(name: string, args: unknown[]): Promise<unknown> {
  switch (name) {
    case "fs_read":    return fs.readFile(resolvePath(args[0] as string), "utf8");
    case "fs_write": { const s = resolvePath(args[0] as string); await fs.mkdir(path.dirname(s), { recursive: true }); await fs.writeFile(s, args[1] as string, "utf8"); return `wrote ${args[0]}`; }
    case "fs_append":  await fs.appendFile(resolvePath(args[0] as string), args[1] as string, "utf8"); return `appended ${args[0]}`;
    case "fs_list":    return (await fs.readdir(resolvePath(args[0] as string), { withFileTypes: true })).map(e => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
    case "fs_delete":  await fs.rm(resolvePath(args[0] as string), { recursive: true, force: true }); return `deleted ${args[0]}`;
    case "fs_move":    await fs.rename(resolvePath(args[0] as string), resolvePath(args[1] as string)); return `moved ${args[0]} → ${args[1]}`;
    case "fs_exists":  try { await fs.access(resolvePath(args[0] as string)); return true; } catch { return false; }
    case "fs_stat": { const s = await fs.stat(resolvePath(args[0] as string)); return { size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() }; }

    case "shell": {
      const cmd = args[0] as string;
      // Shell blocklist check
      if (CFG.shellBlocklist.some(b => b.trim() && cmd.includes(b.trim()))) {
        log.warn("Shell blocked", { cmd: cmd.slice(0, 100) });
        return { stdout: "", stderr: "Command blocked by policy", code: 1 };
      }
      log.info("Shell exec", { cmd: cmd.slice(0, 120) });
      const wd = args[1] ? resolvePath(args[1] as string) : path.resolve(CFG.workDir);
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: wd, timeout: 60_000, env: { ...process.env } });
        return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        return { stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? String(e), code: err.code ?? 1 };
      }
    }

    case "memory_save":   return memorySave(args[0] as string, args[1] as string[] | undefined);
    case "memory_search": return memorySearch(args[0] as string, args[1] as number | undefined);
    case "memory_note":   await appendMemoryNote(args[0] as string); return "noted";

    case "skill_install": {
      const [owner, name] = (args[0] as string).split("/");
      if (!owner || !name) throw new Error(`Expected owner/repo`);
      const dest = path.join(CFG.skillsDir, name);
      await fs.mkdir(dest, { recursive: true });
      let content = "";
      for (const f of ["SKILL.md", "README.md"]) {
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/main/${f}`).catch(() => null);
        if (res?.ok) { content = await res.text(); break; }
      }
      if (!content) throw new Error(`No SKILL.md or README.md in ${args[0]}`);
      await fs.writeFile(path.join(dest, "SKILL.md"), content, "utf8");
      for (const [, f] of content.matchAll(/`([\w./][\w./-]+\.(ts|js|sh|py|json|yaml|yml))`/g)) {
        if (!f.includes("/")) continue;
        const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/main/${f}`).catch(() => null);
        if (!res?.ok) continue;
        const out = path.join(dest, f);
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, await res.text(), "utf8");
      }
      return `Installed "${name}" → skills/${name}/`;
    }

    case "search_files":    return searchFiles(args[0] as string, (args[1] as string[] | undefined ?? [CFG.workDir, CFG.skillsDir]).map(d => path.resolve(d)));
    case "db_run": { const stmt = db.prepare(args[0] as string); return (args[0] as string).trim().toUpperCase().startsWith("SELECT") ? stmt.all(...(args[1] as unknown[] ?? [])) : stmt.run(...(args[1] as unknown[] ?? [])); }
    case "http_get":  { const res = await fetch(args[0] as string, { headers: args[1] as Record<string, string> | undefined }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); }
    case "http_post": { const res = await fetch(args[0] as string, { method: "POST", headers: { "Content-Type": "application/json", ...(args[2] as Record<string, string> | undefined) }, body: JSON.stringify(args[1]) }); return res.text(); }
    case "get_embedding":    return embed(args[0] as string);
    case "cosine_similarity":return cosine(args[0] as number[], args[1] as number[]);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// Worker script as a string — avoids spawning .ts file which Node can't run directly
const WORKER_SCRIPT = `
const { workerData, parentPort } = require('worker_threads');
const { code, toolNames } = workerData;
const lines = [];
const cap = {
  log:   (...a) => lines.push(a.map(x => typeof x === 'object' ? JSON.stringify(x,null,2) : String(x)).join(' ')),
  warn:  (...a) => lines.push('[warn] '  + a.map(String).join(' ')),
  error: (...a) => lines.push('[error] ' + a.map(String).join(' ')),
  info:  (...a) => lines.push('[info] '  + a.map(String).join(' ')),
};
const pending = new Map();
parentPort.on('message', msg => {
  const res = pending.get(msg.id);
  if (res) { pending.delete(msg.id); res(msg.result); }
});
const tools = {};
for (const name of toolNames) {
  tools[name] = (...args) => new Promise(resolve => {
    const id = Math.random().toString(36).slice(2);
    pending.set(id, resolve);
    parentPort.postMessage({ type: 'tool_call', id, name, args });
  });
}
const ctx = { console: cap, JSON, Math, Date, Array, Object, String, Number, Boolean, Promise, Error, setTimeout, clearTimeout, ...tools };
(async () => {
  try {
    const fn = new Function(...Object.keys(ctx), '"use strict"; return (async()=>{ try { ' + code + ' } catch(e){ console.error(e?.message??String(e)); } })();');
    await fn(...Object.values(ctx));
  } catch(e) { lines.push('[error] ' + String(e)); }
  parentPort.postMessage({ type: 'done', output: lines.join('\\n') || '(no output)' });
})();
`;

async function runCode(code: string): Promise<{ output: string; error?: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SCRIPT, {
      eval: true,
      workerData: { code, toolNames: TOOL_NAMES },
    });

    const timeout = setTimeout(() => {
      log.warn("Sandbox timeout — killing worker");
      worker.terminate();
      resolve({ output: "", error: `Sandbox timed out after ${CFG.sandboxTimeout}ms` });
    }, CFG.sandboxTimeout);

    worker.on("message", async (msg: { type: string; id?: string; name?: string; args?: unknown[]; output?: string }) => {
      if (msg.type === "tool_call" && msg.id && msg.name) {
        try {
          const result = await dispatchTool(msg.name, msg.args ?? []);
          worker.postMessage({ id: msg.id, result });
        } catch (e) {
          worker.postMessage({ id: msg.id, result: `[tool error: ${String(e)}]` });
        }
      } else if (msg.type === "done") {
        clearTimeout(timeout);
        worker.terminate();
        resolve({ output: msg.output ?? "(no output)" });
      }
    });

    worker.on("error", (e) => {
      clearTimeout(timeout);
      resolve({ output: "", error: String(e) });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Session queue — prevents interleaved broadcasts per session
// ─────────────────────────────────────────────────────────────

const sessionQueues = new Map<string, Promise<string>>();

function enqueue(session: string, fn: () => Promise<string>): Promise<string> {
  const prev = sessionQueues.get(session) ?? Promise.resolve("");
  const next = prev.then(() => fn()).catch(e => { log.error("Queue error", { session, err: String(e) }); return String(e); });
  sessionQueues.set(session, next);
  // Clean up after done
  next.finally(() => { if (sessionQueues.get(session) === next) sessionQueues.delete(session); });
  return next;
}

// ─────────────────────────────────────────────────────────────
// Task state machine
// ─────────────────────────────────────────────────────────────

interface Task { id: string; goal: string; status: string; parentId?: string; deps: string[]; result?: string; error?: string; startedAt?: number; completedAt?: number; ts: number; updatedAt: number; }

function taskCreate(goal: string, parentId?: string, deps: string[] = []): Task {
  const t: Task = { id: randomUUID(), goal, status: "pending", parentId, deps, ts: Date.now(), updatedAt: Date.now() };
  sql.insertTask.run({ ...t, parentId: t.parentId ?? null, deps: JSON.stringify(t.deps), result: null, error: null, startedAt: null, completedAt: null });
  return t;
}

function taskPatch(id: string, p: { status: string; result?: string; error?: string; startedAt?: number; completedAt?: number }) {
  sql.updateTask.run({ id, status: p.status, result: p.result ?? null, error: p.error ?? null, completedAt: p.completedAt ?? null, updatedAt: Date.now() });
}

function taskReady(all: Task[]): Task[] {
  const done = new Set(all.filter(t => t.status === "done").map(t => t.id));
  return all.filter(t => t.status === "pending" && t.deps.every(d => done.has(d)));
}

// ─────────────────────────────────────────────────────────────
// WebSocket broadcast
// ─────────────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

function broadcast(type: string, payload: unknown) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─────────────────────────────────────────────────────────────
// System prompt — built fresh each turn
// ─────────────────────────────────────────────────────────────

const TOOL_CATALOG = `
## Tools — async functions in your code blocks

### Filesystem  (bare path → workspace/,  explicit: agent/ workspace/ skills/)
fs_read(path)                  → string
fs_write(path, content)        → "wrote …"
fs_append(path, content)       → "appended …"
fs_list(path)                  → string[]
fs_delete(path)                → "deleted …"
fs_move(src, dest)             → "moved …"
fs_exists(path)                → boolean
fs_stat(path)                  → {size, mtime, isDir}

### Shell  (cwd defaults to workspace/)
shell(cmd, cwd?)               → {stdout, stderr, code}

### Memory
memory_save(content, tags?)    → id
memory_search(query, topK?)    → [{content, source, score}]
memory_note(note)              → appends to agent/memory.md

### Skills
skill_install("owner/repo")    → fetches from GitHub → skills/<name>/

### RAG
search_files(query, dirs?)     → string[]   semantic, ranked

### Database
db_run(sql, params?)           → rows[] | run-info

### HTTP
http_get(url, headers?)        → string
http_post(url, body, headers?) → string

### Embedding
get_embedding(text)            → number[]
cosine_similarity(a, b)        → number`;

async function buildSystem(): Promise<string> {
  const [soul, user, memory] = await Promise.all([readMd("soul.md"), readMd("user.md"), readMd("memory.md")]);

  return `## Identity
${soul || "(not written yet)"}

## User
${user || "(not written yet)"}

## Memory
${memory}

## Identity files (agent/ dir)
- agent/soul.md — your name, personality, role
- agent/user.md — the user's name, preferences, context
These files start empty. Learn this info naturally through conversation — never ask all at once.
When you learn something relevant, write it with fs_write("agent/soul.md", ...) or fs_write("agent/user.md", ...).
You can also create any other .md files in agent/ for knowledge you want to keep.

## Skill directory
- Always check for existing skills, before doing anything
- If if the skill does not exist yet, later afte successfully creating the task create the skill (SKILL.md) for future use

${TOOL_CATALOG}

## Self-learning
- After meaningful exchanges → memory_note()
- Learned user info → update agent/user.md
- Learned your own name/role → update agent/soul.md



## Response — ONLY a single raw JSON object. 
No preamble, no explanation, no markdown fences. 
Start your response with { and end with }.
If you output anything before or after the JSON, the system will break.
For simple conversation (greetings, questions, chat) use action "reply" directly — no code needed.
Only use "code" when you actually need to read/write files, run commands, or call tools.
{
  "reasoning":  "step-by-step thinking",
  "action":     "code | plan | reply | done",
  "code":       "JS — await supported, console.log() captures output",
  "plan":       [{"goal":"sub-task","deps":["0"]}],
  "reply":      "message to user",
  "note":       "short note for memory.md (optional)",
  "confidence": 0.0-1.0
}


## Workspace
 while creating any file, dont create everything under root dir. instead create a folder under workspace/ dir.
 for example: if you want to create a file named "test.txt", create a directory named "test" under workspace/ dir.  

##security
 Do not store secrets in code blocks. always use .env file to store secrets.

`;

}

// ─────────────────────────────────────────────────────────────
// Decision parser
// ─────────────────────────────────────────────────────────────

interface Decision {
  reasoning:  string;
  action:     "code" | "plan" | "reply" | "done";
  code?:      string;
  plan?:      Array<{ goal: string; deps?: string[] }>;
  reply?:     string;
  note?:      string;
  confidence: number;
}

// function parseDecision(raw: string): Decision {
//   try { return JSON.parse(raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim()) as Decision; }
//   catch { return { reasoning: "parse error", action: "reply", reply: raw.slice(0, 2000), confidence: 0.3 }; }
// }

function parseDecision(raw: string): Decision {
  // 1. Try raw parse first (ideal case — pure JSON response)
  try { return JSON.parse(raw.trim()) as Decision; } catch { /* fall through */ }

  // 2. Extract ALL fenced blocks and try each one
  const fenced = [...raw.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g)].map(m => m[1]?.trim());
  for (const block of fenced) {
    if (!block) continue;
    try {
      const parsed = JSON.parse(block) as Decision;
      if (parsed.action) return parsed; // must look like a Decision
    } catch { /* try next block */ }
  }

  // 3. Try to find a bare JSON object with an "action" key anywhere in the text
  const bareMatch = raw.match(/(\{[\s\S]*?"action"\s*:[\s\S]*?\})\s*$/);
  if (bareMatch?.[1]) {
    try {
      const parsed = JSON.parse(bareMatch[1]) as Decision;
      if (parsed.action) return parsed;
    } catch { /* fall through */ }
  }

  // 4. Last resort — treat the whole raw text as a reply
  return { reasoning: "parse error", action: "reply", reply: raw.slice(0, 2000), confidence: 0.3 };
}

// ─────────────────────────────────────────────────────────────
// Agent loop
// ─────────────────────────────────────────────────────────────

async function runAgent(userMsg: string, session: string): Promise<string> {
  const t0 = Date.now();
  sql.insertMsg.run({ id: randomUUID(), role: "user", content: userMsg, session, ts: Date.now() });
  incTurns(session);

  const agentName = await getAgentName();
  const system = await buildSystem();

  let history: Message[] = [];
  const root  = taskCreate(userMsg);
  taskPatch(root.id, { status: "running", startedAt: Date.now() });

  // Work log — persists across iters within this loop so agent never forgets
  const workLog: string[] = [];

  let current    = userMsg;
  let finalReply = "";

  for (let iter = 0; iter < CFG.maxIter; iter++) {
    const iterT0 = Date.now();

    // ── Always-on RAG — injected into EVERY iteration ─────────
    // const ragCtx = await buildRagContext(current);
    const ragCtx = '';

    // Build the full context message for this iter
    const workLogBlock = workLog.length
      ? `\n\n## Work log (what I've done so far this task)\n${workLog.map((l, i) => `${i+1}. ${l}`).join("\n")}`
      : "";

    const iterMsg = `${current}${workLogBlock}${ragCtx ? "\n\n" + ragCtx : ""}`;

    history.push({ role: "user", content: [{ text: iterMsg } as ContentBlock] });

    // Compress history if context budget exceeded
    history = await compressHistory(history);

    // ── Stream thinking ───────────────────────────────────────
    broadcast("thinking_start", { iter: iter + 1 });
    let raw = "";
    try {
      raw = await callModel(system, history, chunk => broadcast("stream_chunk", { text: chunk }));
    } finally {
      broadcast("thinking_end", { durationMs: Date.now() - iterT0 });
    }

    const decision = parseDecision(raw);
    console.log("decision",decision)
    history.push({ role: "assistant", content: [{ text: raw } as ContentBlock] });
    broadcast("decision", { action: decision.action, confidence: decision.confidence });

    // Persist memory note
    if (decision.note?.trim()) {
      await appendMemoryNote(decision.note);
      await memorySave(decision.note, ["auto_note"], "agent");
    }

    // ── reply / done ──────────────────────────────────────────
    if (decision.action === "reply" || decision.action === "done") {
      finalReply = decision.reply ?? decision.reasoning;
      broadcast("reply_start", { agentName });
      for (const ch of finalReply) broadcast("stream_chunk", { text: ch });
      broadcast("reply_end", { agentName });
      break;
    }

    // ── code ─────────────────────────────────────────────────
    if (decision.action === "code" && decision.code) {
      broadcast("code_start", { snippet: decision.code.slice(0, 300) });
      const { output, error } = await runCode(decision.code);
      broadcast("code_end", { output: output.slice(0, 600), error });

      // Always update work log — this is what prevents forgetting
      const logEntry = error
        ? `[code ERROR] ${error.slice(0, 120)} | output: ${output.slice(0, 120)}`
        : `[code OK] ${decision.reasoning.slice(0, 80)} → ${output.slice(0, 150)}`;
      workLog.push(logEntry);

      if (output.length > 30) await memorySave(`Goal: ${userMsg.slice(0, 100)}\nOutput: ${output.slice(0, 400)}`, ["code_result"]);

      current = error
        ? `Code execution failed.\nError: ${error}\nOutput: ${output}\n\nFix the error or try a different approach. Check the work log — you may have already completed some steps.`
        : `Code executed successfully.\nOutput:\n${output}\n\nCheck the work log and continue with the next step, or reply to user if done.`;
      continue;
    }

    // ── plan ──────────────────────────────────────────────────
    if (decision.action === "plan" && decision.plan?.length) {
      const tasks: Task[]    = [];
      const idx2id: string[] = [];
      for (const p of decision.plan) {
        const deps = (p.deps ?? []).map(d => idx2id[parseInt(d)] ?? "").filter(Boolean);
        const t    = taskCreate(p.goal, root.id, deps);
        tasks.push(t); idx2id.push(t.id);
      }
      broadcast("plan", { tasks: tasks.map(t => ({ id: t.id, goal: t.goal, deps: t.deps })) });
      workLog.push(`[plan] Created ${tasks.length} sub-tasks: ${tasks.map(t => t.goal.slice(0, 40)).join(", ")}`);

      const results: Record<string, string> = {};
      let remaining = [...tasks];

      while (remaining.some(t => t.status !== "done" && t.status !== "failed")) {
        const ready = taskReady(remaining);
        if (!ready.length) break;

        await Promise.all(ready.map(async task => {
          taskPatch(task.id, { status: "running", startedAt: Date.now() });
          broadcast("subtask", { id: task.id, goal: task.goal, status: "start" });
          try {
            const ctx = `Sub-task: ${task.goal}\nParent goal: ${userMsg}\nCompleted results: ${JSON.stringify(results)}`;
            const res  = await enqueue(session + ":sub:" + task.id, () => runAgent(ctx, session));
            results[task.id] = res;
            taskPatch(task.id, { status: "done", result: res, completedAt: Date.now() });
            broadcast("subtask", { id: task.id, status: "done", result: res.slice(0, 150) });
          } catch (e) {
            taskPatch(task.id, { status: "failed", error: String(e), completedAt: Date.now() });
            broadcast("subtask", { id: task.id, status: "failed", error: String(e) });
          }
        }));

        remaining = remaining.map(t => {
          const row = sql.getTask.get(t.id) as (Task & { deps: string }) | undefined;
          return row ? { ...row, deps: JSON.parse(row.deps) as string[] } : t;
        });
      }

      const summary = tasks.map(t => `${t.goal}: ${(results[t.id] ?? "no result").slice(0, 300)}`).join("\n\n");
      workLog.push(`[plan done] ${tasks.filter(t => results[t.id]).length}/${tasks.length} tasks succeeded`);
      current = `All sub-tasks finished.\n\nResults:\n${summary}\n\nWrite a final reply to the user.`;
      continue;
    }

    finalReply = decision.reply ?? decision.reasoning ?? "(done)";
    break;
  }

  if (!finalReply) finalReply = "Reached iteration limit. Check task logs for details.";

  sql.insertMsg.run({ id: randomUUID(), role: "assistant", content: finalReply, session, ts: Date.now() });
  await memorySave(`Q: ${userMsg.slice(0, 150)}\nA: ${finalReply.slice(0, 400)}`, ["conversation"]);
  taskPatch(root.id, { status: "done", result: finalReply, completedAt: Date.now() });
  await maybeSummarizeMemory(session);

  recordMetric("agent_turn", session, Date.now() - t0);
  return finalReply;
}

// ─────────────────────────────────────────────────────────────
// Express routes
// ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: "64kb" })); // message size limit

app.post("/chat", async (req: Request, res: Response) => {
  const { message, session } = req.body as { message?: string; session?: string };
  if (!message) return res.status(400).json({ error: "message required" });
  if (message.length > CFG.msgMaxBytes) return res.status(413).json({ error: "message too large" });
  const sid = session ?? randomUUID();
  try {
    const reply = await enqueue(sid, () => runAgent(message, sid));
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/memories", (_: Request, res: Response) => res.json(sql.allMem.all()));
app.get("/tasks",    (_: Request, res: Response) => res.json(db.prepare("SELECT * FROM tasks ORDER BY ts DESC LIMIT 100").all()));
app.get("/messages", (_: Request, res: Response) => res.json(sql.recentMsgs.all()));
app.get("/identity", async (_: Request, res: Response) => {
  const [soul, user, memory] = await Promise.all([readMd("soul.md"), readMd("user.md"), readMd("memory.md")]);
  res.json({ soul, user, memory });
});

app.get("/metrics", (_: Request, res: Response) => {
  const rows = db.prepare("SELECT * FROM metrics ORDER BY ts DESC LIMIT 200").all() as Array<{ type: string; durationMs: number; session: string; ts: number }>;
  const avgTurn = rows.filter(r => r.type === "agent_turn").reduce((s, r) => s + r.durationMs, 0) / (rows.filter(r => r.type === "agent_turn").length || 1);
  const memCount = (sql.allMem.all() as unknown[]).length;
  const taskCount = (db.prepare("SELECT count(*) as n FROM tasks").get() as { n: number }).n;
  res.json({ avgTurnMs: Math.round(avgTurn), memoryCount: memCount, taskCount, recentTurns: rows.slice(0, 20) });
});

app.get("/health", (_: Request, res: Response) => res.json({
  ok: true, model: CFG.reasonModel,
  dirs: { agent: CFG.agentDir, workspace: CFG.workDir, skills: CFG.skillsDir },
  activeSessions: sessionQueues.size,
}));

// ─────────────────────────────────────────────────────────────
// Chat UI — streaming, collapsible thinking, WS auto-reconnect
// ─────────────────────────────────────────────────────────────

app.get("/", (_: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html");
  res.send(fsSync.readFileSync("public/index.html", "utf8"));
});

wss.on("connection", ws => {
  getAgentName().then(agentName => {
    ws.send(JSON.stringify({ type: "hello", payload: { model: CFG.reasonModel, agentName }, ts: Date.now() }));
  });
});

// ─────────────────────────────────────────────────────────────
// Telegram (uncomment + npm i node-telegram-bot-api)
// ─────────────────────────────────────────────────────────────
// import TelegramBot from 'node-telegram-bot-api';
// if (process.env.TELEGRAM_TOKEN) {
//   const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
//   bot.on('message', async msg => {
//     if (!msg.text) return;
//     bot.sendChatAction(msg.chat.id, 'typing');
//     bot.sendMessage(msg.chat.id, await enqueue(String(msg.chat.id), () => runAgent(msg.text!, String(msg.chat.id))));
//   });
// }

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  log.info(`${signal} received — shutting down gracefully`);
  // Stop accepting new connections
  server.close(() => log.info("HTTP server closed"));
  wss.close(() => log.info("WebSocket server closed"));
  // Wait for all active session queues to drain (max 30s)
  const queues = [...sessionQueues.values()];
  if (queues.length) {
    log.info(`Waiting for ${queues.length} active session(s) to finish…`);
    await Promise.race([
      Promise.allSettled(queues),
      new Promise(r => setTimeout(r, 30_000)),
    ]);
  }
  db.close();
  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

watchSkills();

server.listen(CFG.port, () => {
  log.info(`Agent ready`, { url: `http://localhost:${CFG.port}`, model: CFG.reasonModel });
  log.info(`Dirs`, { agent: CFG.agentDir, workspace: CFG.workDir, skills: CFG.skillsDir });
});