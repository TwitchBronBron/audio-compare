# Audio Comparison Tool — project guide

A blind A/B audio-ranking web app. The user (Bronley) compares guitar tones (or
any audio set) two at a time; the app builds a ranking from those head-to-head
picks and shows how confident it is. Served as static files via nginx (autoindex
JSON) at `dev.bronley.com:8080/compare/`, often over plain HTTP off a network
share.

## Files

- **`preference-rating.js`** — the pure ranking engine (no DOM). Single source of
  truth for the math. Has a built-in zero-dependency test suite: run
  `node preference-rating.js` (currently **75/75 green** — keep it that way).
  Exposes `window.PreferenceCore` in the browser.
- **`index.html`** — the entire UI (inline `<script>`), audio engine, waveforms,
  router, and rendering. Loads the core via a timestamped `document.write` so the
  browser can never serve a stale copy.
- **`DESIGN.md`** — the full rationale for the ranking model and UX decisions.
  Read it before changing ranking/confidence/matchmaking behavior.
- **`audio/<set>/*.mp3`** — the comparison sets (gitignored).

## How the ranking works (see DESIGN.md for depth)

NOT Bradley-Terry (that was ripped out — it overrode the user's direct picks).
The model is deliberately simple and explainable:

- **One head-to-head grid**: `wins[i][j]` = times the user picked i over j. The
  full vote log is persisted to localStorage and is the source of truth (ranking
  is rebuilt by replaying it).
- **Pair states**: `unseen` / `provisional` (<3 meetings) / `decided` (≥3 and
  >⅔ one-sided) / `tied` (≥3, roughly even). Floor = `MEET_FLOOR = 3`.
- **Ranking = Copeland score** (matchups won − lost), which is cycle-proof.
- **Cycles** (rock-paper-scissors: A>B>C>A) are detected via Tarjan SCC and
  **broken by an opponent-weighted score** — a win over a STRONGER opponent
  counts more, but only when RELIABLE (bounded 0.5–1.5×, one-pass, reliability-
  gated so a fluke 1–0 ≈ 0). A truly symmetric cycle stays a tie.
- **Real preference cycles are a legitimate outcome**, not a bug — when items are
  near-equal the user's picks genuinely loop.

## Matchmaking (`nextPair`)

Pure **round-robin**: always serves the least-played pair, so coverage is even
(everyone vs everyone, then again). A gentle adjacency nudge orders within a
round; a small sporadic boost seeds a top-tie break. NEVER fixate on close pairs
(an early version ground one pair to 13 games while others got 3 — that
manufactured spurious cycles).

## The progress bar + confidence (two SEPARATE signals)

- **Bar = round-robin progress.** 1/3 per completed round, ≥3 dots, one dot per
  round; a 4th round expands the bar to a 4th dot, etc. `status()` exposes
  `roundsComplete / roundProgress / dots / votesToRound / currentRound`. The bar
  is monotonic within a fixed dot count.
- **Confidence tier follows ROUNDS COMPLETED** (the user's final decision):
  0→building, 1→Pretty sure, 2→Confident, 3→Very confident, 4+→Rock solid.
  Monotonic, never bounces, a tie still earns high confidence. (The old
  `competence` evidence-average is still computed but no longer drives the tier.)
- **Readout wording** (`statusParts` in index.html), always shows vote count:
  - before round 1 done: `"N votes · +K to your first ranking"`
  - round just completed: `"N votes · Ranking ready ✓ · <tier> · vote more to refine"`
    (NO "+K to finish this round" — don't imply a phantom new round)
  - mid-round: `"N votes · Ranking ready ✓ · <tier> · +K to finish round X"`
- **BLIND TEST**: the voting screen must NEVER reveal track names (no winner name
  in the status line). Names appear only on the results screen.

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
  per item, every head-to-head with W–L, plain-English outcome, and that
  matchup's signed contribution; a "Total score" row that SUMS to the item's
  opponent-weighted score (so the table proves the ranking). `table-layout:fixed`
  so columns align across cards. Score readout under each rank pill = overall
  `votesWon/votesTotal` "picks", NOT decided-only.
- Per-track score shown as "N/M picks" (overall record), labeled to avoid being
  mistaken for a rank.

## Persistence

`Store` (localStorage, key `audiocompare:v2:<folder>`). State = `{files, votes,
done, ranking, scores}`. On "Keep refining" we set `done:false` AND persist it,
so a refresh resumes the test rather than re-showing results.

## Conventions / gotchas

- **Always run `node preference-rating.js` after touching the core** — keep
  75/75 green. After touching index.html, sanity-check the inline script parses.
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
  copy-link buttons were removed; `competence` no longer drives the tier.
