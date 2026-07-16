#!/usr/bin/env node
// check-migration-ledger — assert supabase/migrations/*.sql matches the reviewed reference ledger
// (supabase/migrations.ledger). Wired into .github/workflows/ci.yml so migration drift fails the
// build at PR time instead of being found by an audit.
//
// The ledger is the reviewed source of truth for WHICH migrations exist. This check compares the
// filename stems (<version>_<name>) of every migration against the ledger; ANY divergence — a file
// added/removed/renamed without a matching ledger edit — is a hard failure. See the ledger header
// for WHY (the MCP-apply-vs-committed-.sql version-drift trap) and the discipline it enforces.
//
//   node scripts/check-migration-ledger.mjs            # verify (CI). exit 1 on drift.
//   node scripts/check-migration-ledger.mjs --write    # regenerate the ledger data (keeps header).
//
// A migration filename MUST be <14-digit-version>_<name>.sql. The 14-digit version is what live
// supabase_migrations.schema_migrations stores; after applying via the Supabase MCP, verify the
// live row's `version` equals your filename's version (re-stamp if the MCP auto-generated a
// different one) BEFORE regenerating this ledger — else you are papering over live drift.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const ledgerPath = join(repoRoot, 'supabase', 'migrations.ledger');

const VERSION_RE = /^(\d{14})_[^/]+$/;

// --- migration filename stems (sorted, validated) -------------------------------------------
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
const malformed = files.filter((f) => !VERSION_RE.test(f.replace(/\.sql$/, '')));
if (malformed.length) {
  console.error('✗ migration filenames must be <14-digit-version>_<name>.sql — offenders:');
  for (const f of malformed) console.error(`    ${f}`);
  process.exit(1);
}
const stems = files.map((f) => f.replace(/\.sql$/, '')).sort();

// duplicate-version guard (two files sharing one 14-digit version silently shadow on replay)
const seen = new Map();
for (const s of stems) {
  const v = s.slice(0, 14);
  if (seen.has(v)) {
    console.error(`✗ duplicate migration version ${v}: ${seen.get(v)} and ${s}`);
    process.exit(1);
  }
  seen.set(v, s);
}

// --- ledger (strip comments + blank lines) ---------------------------------------------------
const rawLedger = readFileSync(ledgerPath, 'utf8').split('\n');
const header = [];
let inHeader = true;
for (const line of rawLedger) {
  if (inHeader && (line.trim() === '' || line.startsWith('#'))) header.push(line);
  else inHeader = false;
}
const ledgerStems = rawLedger
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'))
  .sort();

// --- --write: regenerate data section, preserve header --------------------------------------
if (process.argv.includes('--write')) {
  // keep the leading comment block exactly, drop trailing blank lines from it, then one blank line
  while (header.length && header[header.length - 1].trim() === '') header.pop();
  const out = [...header, '', ...stems, ''].join('\n');
  writeFileSync(ledgerPath, out);
  console.log(`✓ wrote ${stems.length} migrations to supabase/migrations.ledger`);
  process.exit(0);
}

// --- compare ---------------------------------------------------------------------------------
const fileSet = new Set(stems);
const ledgerSet = new Set(ledgerStems);
const inFilesNotLedger = stems.filter((s) => !ledgerSet.has(s));
const inLedgerNotFiles = ledgerStems.filter((s) => !fileSet.has(s));

if (inFilesNotLedger.length === 0 && inLedgerNotFiles.length === 0) {
  console.log(`✓ migration ledger in sync — ${stems.length} migrations`);
  process.exit(0);
}

console.error('✗ migration ledger DRIFT — supabase/migrations/ and supabase/migrations.ledger disagree.\n');
if (inFilesNotLedger.length) {
  console.error('  Migration files NOT in the ledger (added/renamed without updating it):');
  for (const s of inFilesNotLedger) console.error(`    + ${s}`);
}
if (inLedgerNotFiles.length) {
  console.error('  Ledger entries with NO migration file (removed/renamed):');
  for (const s of inLedgerNotFiles) console.error(`    - ${s}`);
}
console.error(
  '\n  Fix: reconcile intentionally, then `node scripts/check-migration-ledger.mjs --write` and commit.\n' +
    '  If a version differs because the Supabase MCP auto-generated it on apply, RE-STAMP the live\n' +
    '  supabase_migrations.schema_migrations row to your filename version FIRST (see supabase/migrations.ledger).',
);
process.exit(1);
