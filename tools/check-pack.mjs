#!/usr/bin/env node
// Checks a Sandflow pack without installing anything: node tools/check-pack.mjs [pack-folder]
// Catches broken JSON, bad ids, references to blocks/flows/skills that don't exist and missing script files.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const errors = [];
const warn = [];
const err = (m) => errors.push(m);

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ITEM = /^[\w-]{1,96}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;
const CORE = new Set(["sandflow/subflow", "sandflow/flow-input", "sandflow/flow-output", "sandflow/script"]);

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8").replace(/^﻿/, ""));
  } catch (e) {
    err(`${rel}: ${e.code === "ENOENT" ? "missing" : `invalid JSON (${e.message})`}`);
    return undefined;
  }
}
const list = (dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".json")).sort() : []);
const exists = (rel) => fs.existsSync(path.join(root, ...rel.split("/")));

const m = readJson("manifest.json") ?? {};
if (!ID.test(m.id ?? "")) err(`manifest.json: "id" must be lowercase letters, digits and dashes`);
if (m.id === "sandflow") err(`manifest.json: "sandflow" is reserved`);
if (!m.name) err(`manifest.json: "name" is required`);
if (!SEMVER.test(m.version ?? "")) err(`manifest.json: "version" must be semver, e.g. 1.0.0`);
const pack = m.id;
const deps = new Set((m.requires ?? []).map((r) => r.id));
for (const [name, plats] of Object.entries(m.bin ?? {})) for (const p of Object.values(plats)) if (!exists(p)) err(`manifest.json: bin ${name} → ${p} doesn't exist`);
if (m.sandbox?.dockerfile && !exists(m.sandbox.dockerfile)) err(`manifest.json: sandbox.dockerfile ${m.sandbox.dockerfile} doesn't exist`);

const q = (id) => (id.includes("/") ? id : `${pack}/${id}`);
const blocks = new Map();
for (const f of list("boxes")) {
  const v = readJson(`boxes/${f}`);
  for (const b of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
    if (!ITEM.test(b?.id ?? "")) { err(`boxes/${f}: block without a valid id`); continue; }
    if (blocks.has(q(b.id))) err(`boxes/${f}: duplicate block id "${b.id}"`);
    if (!b.name || typeof b.config !== "object") err(`boxes/${f}: "${b.id}" needs a name and a config`);
    blocks.set(q(b.id), { ...b, file: `boxes/${f}` });
  }
}
const flows = new Map();
for (const f of list("flows")) {
  const v = readJson(`flows/${f}`);
  for (const fl of v === undefined ? [] : Array.isArray(v) ? v : [v]) {
    if (!ITEM.test(fl?.id ?? "")) { err(`flows/${f}: flow without a valid id`); continue; }
    if (!Array.isArray(fl.nodes) || !Array.isArray(fl.edges)) err(`flows/${f}: "${fl.id}" needs nodes and edges`);
    flows.set(q(fl.id), { ...fl, file: `flows/${f}` });
  }
}

const known = (id, what, where) => {
  const full = q(id);
  const owner = full.slice(0, full.indexOf("/"));
  if (owner === pack) { if (!(what === "block" ? blocks : flows).has(full)) err(`${where}: unknown ${what} "${id}"`); }
  else if (owner === "sandflow") { if (what === "block" && !CORE.has(full)) err(`${where}: unknown Sandflow block "${id}"`); }
  else if (!deps.has(owner)) err(`${where}: uses "${id}" but "${owner}" isn't in manifest requires`);
};

for (const [id, b] of blocks) {
  if (b.extends) known(b.extends, "block", `${b.file} (${id})`);
  for (const s of b.config?.skills ?? []) if (s.file?.store === "pack" && !exists(`skills/${s.file.dir}/SKILL.md`)) err(`${b.file}: skill folder skills/${s.file.dir} has no SKILL.md`);
  const run = b.config?.script?.run;
  if (run) for (const ref of run.matchAll(/\$PACK_DIR\/([\w./-]+)/g)) if (!exists(ref[1])) err(`${b.file}: script uses $PACK_DIR/${ref[1]}, which doesn't exist`);
}
for (const [id, f] of flows) {
  const ids = new Set(f.nodes.map((n) => n.id));
  for (const n of f.nodes) {
    known(n.data?.blockId ?? "", "block", `${f.file} (${id}, node ${n.id})`);
    const sub = n.data?.overrides?.subflow?.flowId;
    if (sub) known(sub, "flow", `${f.file} (${id}, node ${n.id})`);
  }
  for (const e of f.edges) if (!ids.has(e.source) || !ids.has(e.target)) err(`${f.file} (${id}): edge ${e.id} connects a node that doesn't exist`);
  if (!f.nodes.length) warn.push(`${f.file}: "${id}" is empty`);
}

for (const w of warn) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`ok: ${m.name} ${m.version} — ${blocks.size} blocks, ${flows.size} flows`);
