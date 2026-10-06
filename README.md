# dsh-auto-archive

[![tests](https://github.com/SolidiFact/dsh-auto-archive/actions/workflows/tests.yml/badge.svg)](https://github.com/SolidiFact/dsh-auto-archive/actions/workflows/tests.yml)

A [DeepSeek Harness (dsh)](https://www.npmjs.com/package/@deepseek-ai/dsh) web plugin that
archives sessions which are finished and have not been used for three weeks, once a night,
without getting in your way.

> A community plugin from SolidiFact. Not an official DeepSeek product.

## What it archives

A session is archived only when **all** of these are true:

- it has had no activity for 21 days (dsh's own last-activity time);
- its goal, if it has one, is **complete**: an active, paused or blocked goal keeps it;
- every to-do item is **completed**;
- nothing is queued for its next turn;
- it is not open, not running, not pinned, not in a folder you excluded, and not starred in
  [`@michengai/dsh-archive-manager`](https://github.com/MichengAI/dsh-archive-manager)
  (starring is respected when that plugin is installed);
- it is a top-level session (a sub-agent's session follows its parent).

A session whose state cannot be read is kept. An empty session (opened, never used) has
nothing unfinished, so it is archived once idle.

## Why it is safe to leave running

- **Archiving deletes nothing.** In dsh it hides a session, and it is restored with one
  click (for example from the archive manager's page).
- **Once a night, in a quiet window** (03:30 to 05:30 local by default). If any session is
  running, it skips that check and tries again ten minutes later.
- **Each session is re-checked just before it is archived**, and dsh is never asked to stop
  work: dsh itself refuses to archive a session with running activity.
- **Starred sessions it cannot read mean no archiving that night**, not "no stars".
- **No more than 200 a night**, oldest first.
- **Everything it does is written down**: one JSON line per night in
  `~/.dsh/auto-archive/ledger.jsonl`, naming every archived session with its title and last
  activity, plus how many were kept and why.

## What it found on one install

A dry run on a real install with 769 sessions (dsh 0.1.7-rc.2):

| | Sessions |
|---|---|
| Would archive (finished, idle 21+ days) | 105 |
| Kept: used in the last 21 days | 442 |
| Kept: sub-agent sessions | 186 |
| Kept: already archived | 21 |
| Kept: unfinished to-dos | 11 |
| Kept: blocked goal | 1 |
| Kept: state could not be read | 2 |
| Kept: open | 1 |

## Install

Tested with dsh 0.1.7-rc.2 and 0.2.1-alpha.1; every change and a weekly run check it
still attaches to dsh's `latest` and `alpha` releases. It needs dsh's web profile (the `web`
examples below) and, like any dsh plugin install, `pnpm` on your PATH.

```bash
dsh plugin --profile web add @solidifact/dsh-auto-archive
```

**See what it would do first.** Before restarting dsh, put this in the profile's own
`~/.dsh/profiles/web/cordis.patch.yml` (replacing the empty `[]` if that is all it holds):

```yaml
- id: auto-archive
  config:
    dryRun: true
    passOnStart: true
```

Restart dsh web, wait a minute, and read the last line of
`~/.dsh/auto-archive/ledger.jsonl`. It lists every session it would archive and how many it
kept, and why. When the list looks right, remove those lines; from then on it archives
each night.

To remove it:

```bash
dsh plugin --profile web remove @solidifact/dsh-auto-archive
```

**Without npm:** copy `index.mjs` into the profile folder as `auto-archive.mjs` and add it
to that profile's `cordis.patch.yml` (drop the `config:` lines once the dry run looks right):

```yaml
- insert:
    - id: auto-archive
      name: './auto-archive.mjs'
      config:
        dryRun: true
        passOnStart: true
```

## Settings

Set any of these under the plugin's id in your profile's `cordis.patch.yml`; dsh picks up the
change without a restart.

```yaml
- id: auto-archive
  config:
    idleDays: 30
    excludeFolders: ['~/work/client-a']
```

| Setting | Default | |
|---|---|---|
| `idleDays` | `21` | days without activity before a finished session is archived |
| `excludeFolders` | `[]` | project folders whose sessions are never archived (a folder inside one counts too) |
| `archiveEmpty` | `true` | archive sessions that were opened and never used |
| `runAt` | `"03:30"` | local time the nightly window opens |
| `windowHours` | `2` | how long the window stays open |
| `maxPerRun` | `200` | most sessions archived in one night (oldest first; the rest wait) |
| `dryRun` | `false` | decide and record, archive nothing |
| `passOnStart` | `false` | one extra pass a minute after dsh starts |
| `restore` | none | `"last"` or a night as `"YYYY-MM-DD"`: put back what that night archived (below) |
| `ledger` | `~/.dsh/auto-archive/ledger.jsonl` | where each night is recorded |

## Getting sessions back

- **A whole night:** set `restore: "last"` (or the night's date). Within a few seconds every session
  that night archived is back, and the ledger records it. Each night is restored once, so leaving
  the setting in place does nothing more. A restored session is never archived again until you have
  used it; after that the normal rules apply.
- **One session:** dsh's own **Settings → Archived sessions** page, or the Archived tab of
  `@michengai/dsh-archive-manager` if you use it.

## Tests

```bash
node --test
```

## License

Copyright 2026 SolidiFact. Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE).
