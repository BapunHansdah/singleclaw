#!/usr/bin/env tsx
// ============================================================
// skills.ts  —  standalone skill installer
//
// Works without the agent running. The agent calls this via:
//   await shell("skills add coreyhaines31/marketingskills --yes")
//
// Usage:
//   skills add <owner/repo> [--yes]
//   skills list
//   skills remove <name>
// ============================================================

import * as fs   from "node:fs/promises";
import * as path from "node:path";

const SKILLS_DIR = process.env.SKILLS_DIR ?? "skills";
const [,, cmd, target, ...flags] = process.argv;
const yes = flags.includes("--yes") || flags.includes("-y");

async function add(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) { console.error(`Bad format — expected owner/repo`); process.exit(1); }

  if (!yes) {
    process.stdout.write(`Install "${name}" from ${owner}/${name}? (y/N) `);
    const answer = await new Promise<string>(r => {
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", d => { process.stdin.pause(); r(String(d).trim()); });
    });
    if (answer.toLowerCase() !== "y") { console.log("Cancelled."); return; }
  }

  const dest = path.join(SKILLS_DIR, name);
  await fs.mkdir(dest, { recursive: true });

  // Try SKILL.md then README.md
  let content = "";
  for (const file of ["SKILL.md", "README.md"]) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/main/${file}`).catch(() => null);
    if (res?.ok) { content = await res.text(); break; }
  }
  if (!content) { console.error(`No SKILL.md or README.md found in ${repo}`); process.exit(1); }

  await fs.writeFile(path.join(dest, "SKILL.md"), content, "utf8");

  // Best-effort: grab extra files mentioned in SKILL.md
  for (const [, file] of content.matchAll(/`([\w./][\w./-]+\.(ts|js|sh|py|json|yaml|yml))`/g)) {
    if (!file.includes("/")) continue;
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${name}/main/${file}`).catch(() => null);
    if (!res?.ok) continue;
    const out = path.join(dest, file);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, await res.text(), "utf8");
    console.log(`  + ${file}`);
  }

  console.log(`✓ Installed "${name}" → ${dest}/`);
}

async function list() {
  let entries: string[] = [];
  try { entries = (await fs.readdir(SKILLS_DIR, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch { /* empty */ }
  if (!entries.length) { console.log("No skills installed."); return; }
  console.log(`Skills (${entries.length}):`);
  for (const e of entries) console.log(`  • ${e}`);
}

async function remove(name: string) {
  const dest = path.join(SKILLS_DIR, name);
  await fs.rm(dest, { recursive: true, force: true });
  console.log(`✓ Removed "${name}"`);
}

switch (cmd) {
  case "add":    if (!target) { console.error("Usage: skills add <owner/repo>"); process.exit(1); } await add(target); break;
  case "list":   await list(); break;
  case "remove": if (!target) { console.error("Usage: skills remove <name>"); process.exit(1); } await remove(target); break;
  default: console.log(`skills add <owner/repo> [--yes]\nskills list\nskills remove <name>`);
}