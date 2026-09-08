#!/usr/bin/env node
/**
 * Verify the atlas against the argent repo at the pinned commit.
 *
 * Reads the graph data straight out of src/atlas.html and checks it against
 * `git show <ref>:<path>` in a local argent checkout - the committed blobs, not
 * a working tree, so an uncommitted edit can never make a check pass.
 *
 *   1. line map   - every conditional maps to a line that exists at the ref and
 *                   is not blank
 *   2. edge set   - the skill-to-skill references in the atlas match the ones a
 *                   grep of the real files finds, in both directions
 *   3. integrity  - unique node ids, resolvable ref targets, declared line
 *                   counts matching the blobs
 *
 * Usage:  node scripts/verify.mjs [--checkout ~/dev/argent] [--report]
 * Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SOURCE = JSON.parse(readFileSync(join(ROOT, "data/source.json"), "utf8"));
const expand = p => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
const CHECKOUT = resolve(expand(flag("--checkout", SOURCE.localCheckout)));
const WANT_REPORT = argv.includes("--report");

let failures = 0;
const fail = msg => { failures++; console.log("  FAIL  " + msg); };
const ok = msg => console.log("  ok    " + msg);

/* ---- load the graph out of the page source ------------------------------ */
const html = readFileSync(join(ROOT, "src/atlas.html"), "utf8");
const slice = (startMarker, endMarker) => {
  const a = html.indexOf(startMarker);
  const b = html.indexOf(endMarker, a);
  if (a === -1 || b === -1) throw new Error(`cannot locate ${startMarker} in src/atlas.html`);
  return html.slice(a, b);
};
const { SKILLS, TYPES } = new Function(
  slice("const TYPES = {", "const SOURCE=__SOURCE__") + "\n return { SKILLS, TYPES };"
)();
const LINES = JSON.parse(readFileSync(join(ROOT, "data/lines.json"), "utf8"));

const nodes = SKILLS.flatMap(s => s.nodes.map(n => ({ s, n })));
console.log(`atlas: ${SKILLS.length} skills, ${nodes.length} conditionals`);
console.log(`ref:   ${SOURCE.refShort}  (${CHECKOUT})\n`);

/* ---- the checkout has to be able to serve that commit ------------------- */
if (!existsSync(join(CHECKOUT, ".git"))) {
  console.log(`  FAIL  no git checkout at ${CHECKOUT} - pass --checkout <path>`);
  process.exit(1);
}
const git = (...a) => execFileSync("git", ["-C", CHECKOUT, ...a], { maxBuffer: 1 << 28 }).toString();
try {
  git("cat-file", "-e", SOURCE.ref + "^{commit}");
} catch {
  console.log(`  FAIL  commit ${SOURCE.refShort} not found in ${CHECKOUT} (try: git -C ${CHECKOUT} fetch origin)`);
  process.exit(1);
}

const blobs = new Map();
const blob = file => {
  if (!blobs.has(file)) {
    const p = `${SOURCE.path}/${file}/SKILL.md`;
    blobs.set(file, git("show", `${SOURCE.ref}:${p}`).replace(/\n$/, "").split("\n"));
  }
  return blobs.get(file);
};

/* ---- 1. structural integrity ------------------------------------------- */
console.log("[1] structure");
{
  const ids = nodes.map(({ n }) => n.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  dupes.length ? fail(`duplicate node ids: ${dupes.join(", ")}`) : ok(`${ids.length} node ids unique`);

  const known = new Set(SKILLS.map(s => s.id));
  const badRefs = nodes.flatMap(({ n }) => (n.refs || []).filter(r => !known.has(r)).map(r => `${n.id}->${r}`));
  badRefs.length ? fail(`unresolvable refs: ${badRefs.join(", ")}`) : ok("every ref target resolves");

  const badTypes = [...new Set(nodes.map(({ n }) => n.t).filter(t => !TYPES[t]))];
  badTypes.length ? fail(`unknown branch kinds: ${badTypes.join(", ")}`) : ok(`branch kinds all declared (${Object.keys(TYPES).length})`);

  let mismatch = 0;
  for (const s of SKILLS) if (blob(s.file).length !== s.lines) {
    fail(`${s.file}: declared ${s.lines} lines, blob has ${blob(s.file).length}`); mismatch++;
  }
  if (!mismatch) ok("declared line counts match the committed blobs");
}

/* ---- 2. line anchors ---------------------------------------------------- */
console.log("[2] line anchors at " + SOURCE.refShort);
{
  const missing = nodes.filter(({ n }) => !(n.id in LINES)).map(({ n }) => n.id);
  const extra = Object.keys(LINES).filter(k => !nodes.some(({ n }) => n.id === k));
  missing.length ? fail(`no line for: ${missing.join(", ")}`) : ok(`all ${nodes.length} conditionals have a line`);
  extra.length ? fail(`line map has unknown ids: ${extra.join(", ")}`) : ok("no orphan entries in the line map");

  let bad = 0;
  for (const { s, n } of nodes) {
    const ln = LINES[n.id], src = blob(s.file);
    if (!(Number.isInteger(ln) && ln >= 1 && ln <= src.length)) { fail(`${n.id}: line ${ln} outside ${s.file} (1-${src.length})`); bad++; }
    else if (!src[ln - 1].trim()) { fail(`${n.id}: line ${ln} is blank in ${s.file}`); bad++; }
  }
  if (!bad) ok(`every anchor lands on a non-blank line that exists at ${SOURCE.refShort}`);
}

/* ---- 3. edge set vs. a grep of the real files -------------------------- */
console.log("[3] reference edges");
{
  const files = git("ls-tree", "-r", "--name-only", SOURCE.ref, "--", SOURCE.path + "/")
    .split("\n").filter(f => f.endsWith(".md"));
  const names = new Map(SKILLS.map(s => [s.file, s.id]));

  const truth = new Set();
  for (const f of files) {
    const owner = [...names.keys()].find(k => f.startsWith(`${SOURCE.path}/${k}/`));
    if (!owner) continue;
    const text = git("show", `${SOURCE.ref}:${f}`);
    for (const [name, id] of names) {
      if (name !== owner && text.includes(name)) truth.add(`${names.get(owner)}|${id}`);
    }
  }
  const atlas = new Set();
  for (const { s, n } of nodes) for (const r of n.refs || []) atlas.add(`${s.id}|${r}`);
  // file-level edges carry a `note` and belong to the card, not a conditional
  const noteEdges = (html.match(/\{from:"(\w+)",\s*to:"(\w+)"/g) || [])
    .map(m => m.match(/\{from:"(\w+)",\s*to:"(\w+)"/).slice(1, 3).join("|"));
  noteEdges.forEach(e => atlas.add(e));

  const only = (a, b) => [...a].filter(x => !b.has(x)).sort();
  const phantom = only(atlas, truth), missed = only(truth, atlas);
  console.log(`      grep finds ${truth.size}, atlas draws ${atlas.size}`);
  phantom.length ? fail(`atlas draws an edge grep cannot find: ${phantom.join(", ")}`) : ok("no invented edges");
  missed.length ? fail(`grep finds an edge the atlas omits: ${missed.join(", ")}`) : ok("no missed edges");
}

/* ---- optional: the human-readable alignment table ---------------------- */
if (WANT_REPORT) {
  const rows = nodes.map(({ s, n }) => {
    const ln = LINES[n.id];
    return [
      n.id.padEnd(6),
      String(ln).padStart(4),
      s.file.padEnd(34),
      n.l.replace(/~/g, "").slice(0, 50).padEnd(50),
      "| " + (blob(s.file)[ln - 1] || "").replace(/[`*]/g, "").trim().slice(0, 96),
    ].join(" ");
  });
  const out = join(ROOT, "dist/alignment.txt");
  writeFileSync(out, `# each conditional beside the source line it links to, at ${SOURCE.refShort}\n` + rows.join("\n") + "\n");
  console.log(`\nwrote ${out}`);
}

console.log(failures ? `\nFAILED - ${failures} problem(s)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
