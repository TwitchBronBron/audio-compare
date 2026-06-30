# Audio Comparison Tool — project guide

A blind A/B audio-ranking web app. The user (Bronley) compares guitar tones (or
any audio set) two at a time; the app builds a ranking from those head-to-head
picks and shows how confident it is. Served as static files via nginx (autoindex
JSON) at `dev.bronley.com:8080/compare/`, often over plain HTTP off a network
share.

## Files

- **`preference-rating.js`** — the pure ranking engine (no DOM). Single source of
  truth for the math. Has a built-in zero-dependency test suite: run
  `node preference-rating.js` (currently **144/144 green** — keep it that way).
  Exposes `window.PreferenceCore` in the browser.
- **`index.html`** — the entire UI (inline `<script>`), audio engine, waveforms,
  router, and rendering. Loads the core via a timestamped `document.write` so the
  browser can never serve a stale copy.
- **`DESIGN.md`** — the full rationale for the ranking model and UX decisions.
  Read it before changing ranking/confidence/matchmaking behavior. update it when changing behavior.
- **`audio/<set>/*.mp3`** — the comparison sets (gitignored).

## Ranking, matchmaking & confidence — DESIGN.md owns the "why"

**`DESIGN.md` is the source of truth for ranking/confidence/matchmaking
rationale.** Read it before changing any of that behavior; update it when you do.
What follows here is only the operational surface — the invariants you must not
break and the names you'll touch. For *why* it's this way (the Bradley–Terry and
Copeland post-mortems, the margins-vs-flavor argument), go to DESIGN.md.

Invariants (do not break without updating DESIGN.md):

- **Vote log is the source of truth.** `wins[i][j]` grid is rebuilt by replaying
  the persisted log; ranking is derived, never the stored authority.
- **Ranking = TOTAL WINS.** `score(i) = Σ_j wins[i][j]` (every pick it won),
  highest first, equal counts tie. NOT Bradley–Terry, NOT Copeland — both were
  removed (BT overrode direct picks; Copeland disagreed with the on-screen picks
  count). Because games are equal, total wins == win rate == win/loss order; we
  use the count because it's the most explainable and equals the picks readout.
  NOT cycle-aware — that's an accepted trade-off (see DESIGN.md).
- **Ranking only exists after a FULL round-robin.** Win-count is unfair on a
  partial cycle (unequal games). Results are gated on `status().ready`
  (`roundsComplete ≥ 1`).
- **Matchmaking (`nextPair`) is pure round-robin** — always a least-played pair,
  uniform random among ties. Finishes each round before any pair repeats. No
  closeness/adjacency/cycle nudges.
- **Confidence tier follows ROUNDS COMPLETED:**
  0→building, 1→Pretty sure, 2→Confident, 3→Very confident, 4+→Rock solid.
- No ranking threshold constants anymore (`MEET_FLOOR`/`DECIDE_FRAC`/`WIN_MARGIN`
  are gone).

Status API: `status()` exposes `ready / roundsComplete / roundProgress /
roundJustDone / dots / fill / votesToRound / currentRound / tier / ties /
hasTies`. The progress bar = round-robin progress (1/3 per completed round, ≥3
dots, monotonic within a fixed dot count); SEPARATE from the confidence tier.

## Round-complete flow

When a vote completes a full round (`status().roundJustDone`), voting PAUSES and
`onRoundComplete` shows a modal: "Round N complete — vote more / view results,"
flagging any ties ("a 3-way tie for 2nd place"). "Vote more" resumes
`_serveNext`; "View results" calls `rater.finish()`. This is the ONLY way to
reach results mid-grind besides the gated "Show results" button.

## Voting-screen readout wording

`statusParts` in index.html; always shows vote count:

  - before round 1 done: `"N votes · +K to your first ranking"`
  - round just completed: `"N votes · Ranking ready ✓ · <tier> · vote more to refine"`
  - mid-round: `"N votes · Ranking ready ✓ · <tier> · +K to finish round X"`
- **BLIND TEST**: the voting screen must NEVER reveal track names — not in the
  status line, NOT in the round-complete modal (ties name the rank only, never
  the track). Names appear only on the results screen.

## Routing (hashbang)

`#!/` home · `#!/<set>` test · `#!/<set>/ranking` your results ·
`#!/<set>/listen` neutral shareable listen view. A `Router` object parses
`location.hash`; `hashchange` re-renders. Old `?set=&view=` links migrate to the
hash on load. `syncUrl` is a thin shim over `Router.sync`. NOTE: routing is a
functional checkpoint — not every button is wired through `Router.go` yet (some
call `startSet` directly). Reload works; deep back/forward polish is deferred.

## Results page

- Heading is static **"Results"** (the #1 lane shows the winner, not the title).
- Breadcrumb "← All sets" at top of the card; actions ("Keep refining" primary,
  "Rank again from scratch") sit below the player, above the deep-dive table.
- **"Why this ranking?"** table (`PreferenceCore.explain()` → `renderExplain`):
  per item, every head-to-head with W–L, a plain-English outcome, and the picks
  it won there (`+N`); a "Total wins" row that SUMS to the item's score (= its
  rank). `table-layout:fixed` so columns align across cards.
- **Picks readout under each rank pill is clickable** (`.score-btn` →
  `openScoreBreakdown`): opens a per-track step-by-step modal (record vs each
  rival → total wins → rank). The "N/M picks" number IS the ranking basis now
  (total wins / total games), so it can never disagree with the rank.

## Persistence

`Store` (localStorage, key `audiocompare:v2:<folder>`). State = `{files, votes,
done, ranking, scores}`. On "Keep refining" we set `done:false` AND persist it,
so a refresh resumes the test rather than re-showing results.

## Conventions / gotchas

- **Always run `node preference-rating.js` after touching the core** — keep
  the suite green (currently **144/144**). After touching index.html,
  sanity-check the inline script parses.
- The core is cache-busted automatically (timestamp). No manual version bump.
- Bronley dislikes approval prompts — prefer the dedicated Read/Grep/Edit tools
  over shell; one simple command per Bash call; avoid compound commands.
- Commit messages: end with `Co-Authored-By: Claude Opus 4.8 (1M context)
  <noreply@anthropic.com>`. Use a heredoc (`git commit -F -`) — message bodies
  contain apostrophes/parens that break inline `-m` quoting.
- NEVER merge a PR (human-only).
- The repo lives on a network share (`//TRUENAS/...`); run git from inside
  `z:/html/compare`, not with `-C`.

## Open / deferred

- Router cleanup: route every navigation through `Router.go` for perfect
  back/forward (currently some direct `startSet` calls).
- Dead code: `copyShareLink` / `Router.link` have no callers since the
  copy-link buttons were removed.
- Ranking is NOT cycle-aware (accepted trade-off of win-count). If users start
  caring about rock-paper-scissors loops, that's where to revisit the model.
