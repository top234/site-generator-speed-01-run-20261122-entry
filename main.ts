// Driver for the site-generator-speed-01 entry: the harness runs
// `node /bot/main.ts` (node 22). It reads every case from /input/cases.json,
// answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// (or INPUT_DIR / OUTPUT_DIR) stand in for /input and /output. The
// repository directory is read-only when graded, so everything this program
// writes goes to the output directory, never beside the sources.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the same tuning the house baseline runs with).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? process.env.INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? process.env.OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
if (!Array.isArray(cases)) throw new Error('cases.json must hold an array of cases');
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
