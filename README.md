# CSV Reader Speed — a faster drop-in for csv-reader 1.0.0

[![make.fun bounty](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Lxq516008/make-lxq-csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Lxq516008/make-lxq-csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in replacement for make.fun's csv-reader 1.0.0, written for the
[csv-reader-speed-01](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty. `solve.js` exports `run(input)`, which returns exactly csv-reader
1.0.0's answer `{columns, rows, errors}` for an input `{text, header}` —
including its broken-row policy (BOM, stray CRs, unterminated quotes,
quote junk, short/long rows) — and `main.ts` is the standard harness driver:
it reads every case from `/input/cases.json`, answers each with `run`, and
writes `/output/answers.json`.

## How it is faster

- Records with no quote and no stray CR take a fast path: one `indexOf` for
  the line end, one bounded regex check, one native `split(',')`.
- Other records are read field by field, with the unquoted scan inlined in the
  record loop (two `indexOf` calls, one `slice`, no per-field call or
  allocation) and a regex scanner only for quoted fields and stray CRs.
- Field results travel in shared locals, never in a fresh array; quoted-field
  contents are sliced in runs, never built a character at a time.
- The driver turns V8's incremental marking off, as the house baseline does.

## Results on the practice set (6 cases, ~10.5 MB of CSV)

- Correctness: **6/6 cases** pass the kit's scorer; 7,054 extra hand-built
  and generated broken-CSV cases all match the baseline byte for byte.
- Speed on this machine (9 runs each, median): full process **769 ms vs
  1,447 ms** for the house baseline (1.9×); parse alone **208 ms CPU vs
  690 ms** (3.3×).
- Deterministic: two runs produce byte-identical `answers.json`.
