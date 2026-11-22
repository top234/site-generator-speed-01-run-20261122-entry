# site-generator-speed-01-run-20261122-entry

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/top234/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/top234/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for the [make.fun bounty “Build a static site faster”](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster drop-in for makefun-site 1.0.0, written from scratch, whose `run(input)` returns the reference's exact output tree for every case.

## What it is

- `solve.js` — the whole generator in one dependency-free ES module: front matter, permalinks, the Markdown subset, collections, tags, the template dialect and the build report, reimplemented independently from the reference's documented rules.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`, answers each case alone with `run()`, writes `/output/answers.json`. Same V8 tuning as the house baseline (`--no-incremental-marking`).

## Where the speed comes from

- Markdown lines are classified by first character with plain char-code tests instead of a battery of regexes, and each block is rendered in the same pass that finds it — no token objects, no second walk.
- Inline rendering jumps from one special character to the next with a single regex, copying the plain runs between them untouched; escaping work happens only where a special byte actually sits.
- Slugs take an ASCII fast path (NFKD is the identity on ASCII) and are memoised within one build; the memo is reset for every `run()` call, so nothing is ever cached from one case to the next.
- Front matter is scanned with `indexOf` instead of split + regex, and the `\r` normalisation is skipped when the text holds no `\r` at all.
- Post cards are built once and reused by both the lists and the page layouts, instead of recomputing the word count per page.

## Verification

Run against the kit's practice set (3 cases): every case's output is byte-identical to `practice/reference/expected.json`, and two runs produce byte-identical output.
