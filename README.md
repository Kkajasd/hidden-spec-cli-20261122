# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kkajasd/hidden-spec-cli-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kkajasd/hidden-spec-cli-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies AI-written edits to a tree of text files, exactly as SPEC.md
version 1 says. One command, Node 22 and its standard library alone, no
dependencies, no network, deterministic.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a file, or `-` / absent for standard input. The formats are
`unified`, `search-replace`, `v4a`, `json`, and `auto` (the default, which
detects the format). `--check` does everything but write. `--strict` matches
at tier 0 only.

## The files

- `main.ts`: the CLI. Run it as `node main.ts [options] [PATCH]`.
- `runner.ts`: the kit's trial runner, kept as it is.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

## How it works

Edits are parsed into a list, then applied in patch order to the tree as
earlier edits left it. A failed edit changes nothing and the edits after it
still run, so every failure is reported; when any edit failed, no file is
written. Matching is at three tiers: exact lines first, then lines equal
once trailing spaces and tabs are removed, then lines equal once leading and
trailing spaces and tabs are removed. Context lines are written as the file's
own matched lines, and at tier 2 the added lines are re-indented to the
file's indentation. Unified hunks are placed at the occurrence nearest the
line number the diff gives; SEARCH/REPLACE blocks need exactly one
occurrence; V4A chunks walk a cursor through the file from their anchors.
A changed file keeps its own line break and its final line break, unless the
format says otherwise for a unified hunk or a created file.
