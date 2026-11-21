import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINES = 300;
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '..');
const SRC_DIR = join(FRONTEND_DIR, 'src');
const EXTS = new Set(['.svelte', '.ts', '.css', '.html', '.mjs']);

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if ([...EXTS].some((e) => ent.name.endsWith(e))) out.push(full);
  }
  return out;
}

const files = [join(FRONTEND_DIR, 'index.html'), ...walk(SRC_DIR)];
const violations = [];
for (const file of files) {
  if (!statSync(file).isFile()) continue;
  const lineCount = readFileSync(file, 'utf-8').split(/\r?\n/).length;
  if (lineCount > MAX_LINES) {
    violations.push({ file, lineCount });
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    process.stderr.write(`Line budget exceeded (${v.lineCount} > ${MAX_LINES}): ${v.file}\n`);
  }
  process.exit(1);
}
process.stdout.write(`Line budget OK: ${files.length} file(s) <= ${MAX_LINES} lines.\n`);
