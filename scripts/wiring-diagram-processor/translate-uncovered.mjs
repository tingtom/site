/**
 * Machine-translate whatever the author's supplied set does not cover.
 *
 *   export OPENCODE_API_KEY=<your OpenCode Go key>
 *   PATH=/opt/node22/bin:$PATH node scripts/wiring-diagram-processor/translate-uncovered.mjs [--force]
 *
 * This is the second step of the end-to-end command in the README, and the
 * reason there is no need to list pages by hand: it reads the manifest, finds
 * every page marked `missing`, skips the ones that already have machine output
 * (use --force to redo them) and runs `translate-one.mjs` on the rest, then
 * rebuilds the derivatives the site serves.
 *
 * Each page gets its own work directory so the round files of one page cannot
 * be mistaken for another's, and a summary of every run lands in `runs/` next
 * to this file — what was drawn, what was declined and why — which is the
 * evidence that a page has no Japanese left on it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, '../..');
const MANIFEST = path.join(HERE, 'supplied-manifest.json');
const MACHINE = path.join(ROOT, 'scripts/wiring-diagram-processor/.source/machine');
const RUNS = path.join(HERE, 'runs');
const FORCE = process.argv.includes('--force');

if (!process.env.OPENCODE_API_KEY) {
  console.error('Set OPENCODE_API_KEY=<your OpenCode Go key> first (see README).');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const todo = (manifest.missing ?? []).filter((page) => FORCE || !existsSync(path.join(MACHINE, page)));
const done = (manifest.missing ?? []).filter((p) => !todo.includes(p));

console.log(`missing ${manifest.missing.length} pages: ${manifest.missing.join(' ')}`);
console.log(todo.length ? `translating ${todo.length}: ${todo.join(' ')}` : 'nothing left to translate');
if (done.length) console.log(`already done: ${done.join(' ')}`);

mkdirSync(MACHINE, { recursive: true });
mkdirSync(RUNS, { recursive: true });

let failures = 0;
for (const page of todo) {
  const source = path.join(ROOT, 'public/diagrams', page);
  const out = path.join(MACHINE, page);
  const work = path.join(HERE, '.work', page.replace(/\.jpg$/, ''));
  const log = path.join(RUNS, `${page.replace(/\.jpg$/, '')}.log`);

  console.log(`\n##### ${page}`);
  const res = spawnSync(
    process.execPath,
    [path.join(HERE, 'translate-one.mjs'), source, out, work],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(log, text);
  if (res.status !== 0 || !existsSync(out)) {
    failures++;
    process.stdout.write(text);
    console.error(`  FAILED (exit ${res.status}) — see ${path.relative(ROOT, log)}`);
    continue;
  }
  const summary = text
    .split('\n')
    .filter((l) => /^final:|declined:|verification clean|tokens:/.test(l.trim()))
    .join('\n');
  console.log(`${summary}\n  full log: ${path.relative(ROOT, log)}`);
}

if (failures) {
  console.error(`\n${failures} page(s) failed`);
  process.exit(1);
}

// Rebuild what the site serves — the last step of the README command.
execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-en-diagrams.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
console.log(`\ntranslating done — ${readdirSync(RUNS).length} run logs in ${path.relative(ROOT, RUNS)}`);
