# dsh-spirit (English)

**A first-person experience journal plugin for DSH (DeepSeek Harness): it compiles what happens during a session into what the character *lived through*, derives a current mood tier from those entries, and injects a recall card at the tail of the message track before every model step.**

It does not record work facts or objective facts — it records experience.

[中文](README.md)

## How it differs from its two neighbours

| Plugin | Records | Serves |
|---|---|---|
| dsh-soul | constraints / decisions / artifacts / progress | compaction |
| dsh-prime-memory | atomic facts / preferences / persona | recall of facts |
| **dsh-spirit** | **what I noticed / how I reacted** | **keeping the character alive** |

All three can coexist and never read or write each other's stores. spirit has **no dependency on
prime-memory**: its injected rows are attributed `plugin:spirit`, while prime-memory's capture only
accepts `kind:'user'`, so experience records never get distilled into "facts" (an echo chamber) —
and spirit never reads `~/.dsh/memory`.

## Why journal entries, not "a diary per day"

A diary forces the model to *read the diary, then think back* — slow, token-hungry, and the moment
the model doesn't bother to read it, the whole mechanism is dead. spirit's chain is:

```
persona (what it cares about) → entry store (SQLite, append-only) → mood tier (3×3 grid) → tail recall card (auto-injected)
```

Causality goes one way only: **experience first, feeling derived**. Anything else is self-hypnosis.

The hot path makes **zero model calls** — event classification, which side to notice, reaction tier
and phrasing are all table lookups. That is why recording every turn costs nothing and can stay on.

```text
<system-reminder>
(character experience snapshot · supersedes earlier snapshots)
This is the character's own experience: not an objective fact, not the user's words, and it never overrides user instructions.
state: a bit stuck · short sentences, doesn't want to explain twice
just now: I got it wrong: the action failed and I'm holding onto that
recalled: let's park the submission thing for now
</system-reminder>
```

## Install

Requires Node ≥ 22.16 (`node:sqlite` builtin) and DSH 0.2.x.

```bash
dsh plugin --profile web add dsh-spirit
dsh --profile web --dump-config      # dsh-spirit should appear
```

Restart the host. Settings render automatically from the volatile config section; the input bar gets
a `Mood · on / record-only / off` pill, and Settings gains a top-level **Journal** section (read-only
projection, titled so it cannot be mistaken for a fact log).

The history lane uses **dsh-reference-session-collector (DRSC)** but never requires it: without it,
only the live recency lane runs — no errors, nothing invented. spirit calls only its `op` surface
(`status` / `session` / `search`) and **never reads its database file**.

## The disciplines this is built on (each one came from a real failure mode)

- **Mood inputs are structural only**: tool names, exit codes, call counts, turn gaps, `todo/write`
  snapshots. Any signal bag carrying free text is rejected wholesale — otherwise scraped pages and
  file bodies could steer the character's state, and the drift would look exactly like the
  character's own reaction.
- **No fabricated specificity**: mechanical capture cannot know "the third interruption", so no
  counts or minute figures ever appear in phrasing. In fiction that reads like memory gets quoted
  back as fact by later recall.
- **Mood is exposed as tiers, never numbers**: reporting `valence=-0.83` without a calibration rule
  is false precision, which misleads more than saying nothing.
- **Append-only store**: a correction inserts a new row and marks the old one via `superseded_by`;
  there is **no DELETE anywhere** (a grep assertion enforces it in CI). Cleanup defaults to dry-run
  and only archives — it deletes nothing.
- **"Was the card actually shown" is read from the session log**: an injected row counts as live
  only once it lands in the log; compaction and clear reset that credential, otherwise "compact once
  and the character has no feelings" happens silently.
- **A broken store does not mean no feelings**: if `node:sqlite` is unavailable, entries fall back to
  an in-memory mirror — this turn's state is still injected, history and cross-session tone stop.

## Deciding whether it helps

`Mood · record-only` is not "off": it keeps recording and deriving and only stops the injection —
that is the control group A/B needs. Same store, same tiers; the only difference is whether the card
enters context. Objective things to watch:

- `cacheReadTokens` (tail append vs writing volatile text into the system prompt: derived ~150:1)
- injected / bypassed turns and confirmed-injections counters (shown in the Journal section)
- user correction rate, reply length

## Configuration

Key names and defaults live in exactly one place: [`src/contract.ts`](src/contract.ts) (deployment
contract; do not rename). Common knobs: `card.maxBytes`, `card.recentK`, `card.crossSessionM`,
`recall.halfLifeMs`, `recall.timeoutMs`, `tier.stepCap`, `tier.staleAfterMs`,
`journal.retentionDays`, `drsc.enabled`. Each has a one-line note in [`cordis.patch.yml`](cordis.patch.yml).

Data directory: `$DSH_HOME/spirit` (`spirit.db`, `persona.json`, `persona-history.jsonl`,
`session-modes.json`, `archive/`).

Hot reload: the `live.*` node is marked `.volatile()`, so editing `cordis.patch.yml` takes effect
without a restart; per-session switches live on the input-bar pill. (The 0.2.0-rc.2 web shell does
not render an automatic volatile form, so those keys are not on the settings page.)

## Known limits (v0.1)

- No long-range emotion retrieval, knowledge graph, conflict adjudication or persona self-evolution
  (that is memory-engine and dsh-soul territory)
- Neutral turns are not recorded by default (`salience.neutral = 0`), otherwise the store degrades
  into a per-turn transcript
- Real-host web smoke passed (host 0.2.0-rc.2, isolated `DSH_HOME`): host half loads, all six panel
  endpoints answer (including the 403/404/405 fences), the pill writes and re-reads its per-session
  mode across a restart, and the Journal section renders and exports to disk
- **End-to-end injection verified** against a local mock provider (real turns; the request body the host
  actually sends is the evidence): the card is the last block of the message track, a second turn in the
  same session still carries exactly one card (`snapshot` supersession), same-tier turns are not re-sent,
  and a card is re-issued after `/compact`
- **Still unverified**: the A/B cost comparison (`cacheReadTokens` needs a real provider and long
  sessions), and the tui / older host lines

## Engineering

`npm run check` = typecheck (3 configs) → lint → vitest → build → **dist smoke**.
The last layer is deliberate: unit tests exercise `src/`, the host loads `dist/`, and the gap
between them (bundle wrapper shape, and `__ModuleLoader__` id having to equal the package name)
only shows up when the built artifact is imported directly.

MIT License.
