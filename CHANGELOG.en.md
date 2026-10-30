# Changelog

All notable changes to this project are documented here. Versioning is semantic.

## 0.1.0

First usable release: **a first-person experience entry store plus dual-lane instant recall**.

### Added

- **Experience entry store (the source of truth)**: `node:sqlite` (Node builtin, zero native deps);
  `experience` / `experience_cues` / `mood_state` / `meta`. Append-only — a correction inserts a new
  row and marks the old one via `superseded_by`; **there is no DELETE path anywhere** (a grep
  assertion holds the line in CI). Rows carry `lane` (`live` / `drsc`) and `source_ref` (traceable to
  a collector segment).
- **Persona as the record selector**: `salience` decides whether an event is worth recording at all
  (`0` means don't record — what a character *doesn't* write down is also characterisation),
  `focus` decides which side of the same event gets written (a failed tool call can land as
  "I got it wrong" or as "my tools are being difficult"), `voice` decides the phrasing. The persona
  section enters the system prompt via `systemPrompt.section` (order 20), cached by `revision`.
- **Derived mood tier**: entries → a 3×3 grid (valence × arousal), recency-weighted by half-life,
  with a **per-turn step cap** (no personality whiplash) and **stale → neutral** (a restart never
  treats three-day-old feelings as current). Externally only tier words and behavioural tendency are
  exposed — **no floating-point emotion values anywhere**.
- **Recall card injected at the tail**: `agent/pre-step` appends one `user/message` at the **end** of
  the returned array, attributed `source:{kind:'plugin:spirit', form:'snapshot'}` — `snapshot` is
  host-defined as "a later snapshot from the same producer supersedes an earlier one", so nothing
  rewrites history and no hand-rolled "previous row is void" sentence is needed. Four segments
  (state / just now / recalled / opening) are budgeted **line by line against the assembled bytes**,
  with a fixed drop order.
- **Dual-lane recall**: lane A recency (live hooks, zero lag, always on); lane B history (own older
  entries + DRSC search, under a timeout budget). The two lanes are **never rank-merged** — each owns
  its own segment, because "just happened" and "got reminded" mean different things.
- **Consumes DRSC instead of rebuilding delivered capability**: session enumeration, JSONL decoding,
  turn segmentation, CJK retrieval and surface reconciliation are not re-implemented. Only its `op`
  surface is called (`status` / `session` / `search`), always with `redact=1`; `session:null` is
  treated as empty rather than as an error; **its database file is never read**; when it is not
  installed the history lane is omitted entirely.
- **Observability**: an in-memory stats registry (injected / bypassed / off turns, card bytes,
  recall hits, confirmed injections) plus the prefix route `POST /dsh-spirit/rpc/<method>`
  (deliberately not `connection.rpc`, see below). The client half mounts exactly two seats: the
  input-bar pill (`on / record-only / off`) and a read-only top-level **Journal** section in Settings.
- **Bypass is orthogonal to off**: bypass keeps recording and deriving and only stops the
  injection — the only shape that can answer "is the immersion actually caused by this mechanism".
- **Cross-session tone**: the first turn of a new session reads the previous session's last few
  **own entries** (no DRSC query, and no reading of anyone else's store).
- **Gates**: `npm run check` = typecheck (3 configs) → lint → vitest → build → **dist smoke**;
  plus `npm run compat`, which double-checks every target host line against `engines.dsh`
  *and* `peerDependencies`.

### Key decisions (and why not the alternative)

- **No dependency on prime-memory or its store**: experience and objective fact are different
  semantic domains. Attributing rows `plugin:spirit` means prime-memory's L0 capture (which accepts
  only `kind:'user'`) cannot distil them into "facts" — decoupling goes both ways.
- **Mood inputs are structural only**: any signal bag carrying free text is rejected wholesale.
  Otherwise scraped pages and file bodies could steer the character's state, and the drift would look
  exactly like the character's own reaction.
- **No fabricated specificity**: an early design draft said "when you interrupted me for the third
  time" — mechanical capture cannot know "third", so writing it would be fiction that later recall
  quotes as fact.
- **The primary recall path is automatic injection, not a tool**: relying on the model to go look
  turns this into "read the diary, then think back" — the failure mode dsh-soul documents itself
  (when the model doesn't search, the mechanism might as well not exist).
- **Settings form left to the host**: volatile fields auto-generate it; the custom section is
  read-only, so there can never be two settings entry points for one plugin.
- **RPC avoids `connection.rpc`**: that prefix channel silently 405s at the webServer dispatch layer,
  and the `/api` interceptor slot is single-owner and gets grabbed. An own exact prefix route coexists.

### Fixed (the silently-broken kind)

- `live.bypass` (global bypass) and `live.cardEnabled` (card master switch) **were never read by the
  orchestrator** — the settings toggle was decorative
- the "card already sent" credential was not reset after compaction/clear ⇒ the `unchanged` gate
  blocked re-injection forever = **compact once and the character has no feelings**, silently
- `failedTools` was cleared every turn ⇒ cross-turn "same tool recovered" could never be detected
- `noteInjected` silently dropped registrations when no runtime existed ⇒ the first card's
  fingerprint never committed
- card budget used "one separator per line" estimates that do not match `join('\n')`, so the drop
  order diverged from the design
- entry and cue writes were not in one transaction (a crash mid-way left cue rows pointing at a
  nonexistent entry); 20k appends also went 92s → 35s
- detail phrasing printed `pathBases` verbatim ⇒ a caller passing full paths would leak directories
  into cards and the store (now normalised to basename)
- `ENOENT` was detected via `err.name` instead of `err.code`, reporting "missing file" as
  "unreadable" — a failure that does not exist
- migration direction checks had their two messages swapped

### Real-host defects (found on a live 0.2.0-rc.2 web install)

- **wrong route root**: `SPIRIT_RPC_ROUTE` built `/dsh-spiritrpc` while the browser half fetched
  `/dsh-spirit/rpc/…` ⇒ the panel only ever saw the host's 404. The root is now a single shared
  constant, with three gate assertions plus two dist-smoke checks behind it
- **wrong optional-service lookup**: `ctx.get('webServer')` returns undefined without a top-level
  inject declaration, and `internal/service` does not re-fire on a normal start ⇒ the route was never
  registered. The main path is now scoped injection, `ctx.inject(['webServer'], …)`
- **seat label frozen in the default language**: client apply runs before the host writes
  `<html lang>`, so a string label pinned the nav entry to English. Labels are thunks now
  (host contract: thunks follow the active locale)
- **journal and export hung off the in-memory registry**: after a host restart the registry is empty,
  so the section went blank and export said "no session to export" while every row sat in the store.
  Both now fall back to the newest session in the library, and the empty-state copy no longer
  contradicts the rows below it
- also closed the missing test cases for the "turn already cancelled" gate

### Limits

- `engines.dsh` declares **only the six verified 0.2.x lines** (`form:'snapshot'`, producer-owned
  kinds and `systemPrompt.section` do not exist before 0.1.7). Verified locally: the 0.2.0-rc.2 host
  tree adjudicates compatibility from `peerDependencies` — its README says outright "not
  `engines.dsh`" — so both are declared and pre-checked per line.
- Retention **archives only; it deletes no rows** (real deletion needs snapshot + verification +
  restore, deferred to v0.2 behind explicit consent).
- Local unit tests, dist smoke and a **real-host web smoke pass** (host half loads, six endpoints,
  pill write/read across a restart, section renders, export lands on disk). **End-to-end injection is now
  verified** against a local mock provider: the card is the last block of the message track, a second turn
  in the same session still carries exactly one card (`snapshot` supersession), same-tier turns are not
  re-sent, and a card is re-issued after `/compact`. **A/B cost numbers** still need a real provider and
  long sessions; mock figures are not passed off as a result.
- Two more silent defects surfaced on-host: the persona section was **always empty** because the hook read
  `config.live` raw (that is a `VolatileRef`), and the history lane's base URL did not follow the host's
  own port (`drscVerdict` was permanently `warn` off port 8080). Both fixed, with gates.
- The 0.2.0-rc.2 web shell **renders no automatic volatile form** (no client package reads
  `autoGenerate`) ⇒ `live.*` keys are hot-edited through the deployment layer, not the settings page.
- Out of scope: long-range emotion retrieval, knowledge graph, conflict adjudication, persona
  self-evolution, taking over the compaction backend.
