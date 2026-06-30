# Audio Comparison — Ranking & Confidence Design

This document is the source of truth for how the comparison tool decides a
ranking and how it talks to the user about it.

## The model in one sentence

**Rank by total wins.** Each track's score is how many of your A/B picks it won,
summed across every matchup. Highest win count is #1. Equal win counts tie.

That's the whole ranking. The rest of this document explains *why* it's that
simple, and how the voting flow guarantees the count is fair.

## Why total wins (and why nothing fancier)

The unit of truth is a head-to-head: when two tracks were compared, which did you
pick. We want the simplest rule that turns those picks into an order the user can
trust and understand.

Three different-looking formulas all collapse to the same ranking **as long as
every track plays every other track the same number of times**:

- **total wins** (count the picks it won),
- **win rate** (wins ÷ games played),
- **win/loss ratio** (wins ÷ losses).

They're monotonic transforms of each other when games are equal, so they produce
the *identical* order. We use **total wins** because it's the most human:
"you picked it 37 times" needs no explanation, and it's exactly the number shown
on the results screen — so the displayed count can never disagree with the rank.

### What was tried and removed (and why)

- **Bradley–Terry / maximum-likelihood strength fit.** Removed: the global fit
  produced rankings that *contradicted the user's direct picks* — it would float
  a track to #1 even though the user picked another over it head-to-head, because
  its blowouts over weak tracks implied a high "latent strength." The tool's whole
  premise is "I like this one more than that one," so an aggregate score that can
  override a direct pick is wrong by definition.
- **Copeland + cycle-breaking (matchups won − lost, Tarjan SCC, opponent-weighted
  tiebreak).** Removed: it was cycle-aware and never contradicted a *decided*
  direct pick, but it produced rankings that disagreed with the on-screen "picks"
  count — a track with *fewer* total picks could rank *higher* (it won more
  distinct matchups). That inversion confused users far more than it helped, and
  the machinery (SCC clustering, opponent weighting, decided/tied thresholds) was
  a lot of surface area to explain a result the user found surprising.

### The known trade-off we accepted

Total wins is **not** cycle-aware. If your picks form a loop (you prefer A over B,
B over C, but C over A — common when tracks are close and context shifts your
ear), total wins still prints a confident linear order and stays silent about the
loop underneath. We accept this: it's simpler, it always agrees with the visible
picks count, and a margin/Copeland model can't honestly order a cycle either —
it just fails differently. Where ties *do* surface (equal win counts), we show
them (see "Ties").

### Why margins are deliberately ignored

A bigger win margin over a weak track does **not** mean a better track — it often
just means the two are *less similar in flavor*. A warm guitar beats a warm
"crappy" guitar by a smaller margin than a bright guitar does, not because it's
worse, but because it's closer in character. Rewarding margin therefore rewards
"sounds least like the worst track," which can promote a track above one the user
directly preferred. Counting wins (not margins) sidesteps this entirely.

## Completion is round-based

You can't rank fairly by win count on a *partial* round-robin — if some tracks
have played more games than others, raw win counts aren't comparable. So:

- A **round** is one full round-robin: every unordered pair played once
  (`C(N,2)` votes — 10 for 5 tracks).
- **No ranking exists until at least one full round is complete.** The "Show
  results" button is hard-disabled until then, showing "N more to finish the
  first round."
- After each completed round, a **round-complete modal** appears: "Round N
  complete — vote more or view results," flagging any ties. The user can stop
  with a fair ranking, or keep going for more rounds (which only firms it up).

## Matchmaking — pure round-robin

`nextPair()` always serves a pair from the **least-played tier**: no pair gets its
(k+1)th meeting until every pair has had its kth. Among the equally-least-played,
it picks uniformly at random. This guarantees full, equal coverage — the
precondition that makes win-count fair — and naturally completes rounds in order.

No closeness/adjacency nudges, no tie-seeding, no cycle chasing. (An early version
over-weighted close pairs and ground one pair to 13 meetings while others got 3 —
lopsided sampling that made win counts incomparable.)

## Confidence tier — driven by ROUNDS COMPLETED

Shown as a label. More full round-robins = more confident, full stop:

    0 rounds → "building"        (before the first round completes)
    1 round  → "Pretty sure"
    2 rounds → "Confident"
    3 rounds → "Very confident"
    4+ rounds→ "Rock solid"

Monotonic (rounds only increase, so it never bounces), and a tie still earns high
confidence — you did the work; the answer just happens to be "equal." This is a
separate signal from the progress bar.

## The progress bar

The bar tracks **round-robin progress**: 1/3 per completed round (≥3 dots, one dot
per round), the current round adding a fraction. A 4th round expands the bar to a
4th dot, etc. It only moves forward and maps exactly to the voting done.
`status()` exposes `roundsComplete / roundProgress / roundJustDone / dots / fill /
votesToRound / currentRound / tier / ties / hasTies / ready`.

## Ties

Tracks with equal win counts share a rank (a tie). Ties are surfaced two places:

- The **round-complete modal** flags that a tie exists ("a 3-way tie for 2nd
  place — vote more to break it"), naming only the rank, not the tracks (the
  voting screen is a blind test).
- The **results page** groups tied tracks at a shared rank with a "≈ tied" note.

A tie is a valid *answer* (these really are equal to you), not a failure — but
because more rounds can break it, we nudge.

## "Why this ranking?" — the transparency table

`PreferenceCore.explain()` returns, per track in ranked order, every head-to-head
it played: the W–L record and how many picks it won there. The per-matchup wins
sum exactly to the track's total wins (the rank-setting number), so the results
table proves the ranking. Each track's picks readout on the results page is also
clickable, opening a per-track step-by-step modal (your record vs each rival →
total wins → rank). Shown only on the ranked results view, never mid-vote (blind
test).

### Per-matchup outcome wording (`gradeOutcome`, LOCKED)

Each head-to-head gets a plain-English outcome from its raw W–L, graded by how
lopsided the pick was. This wording was deliberated and settled — do not "improve"
it without asking:

    even split        → "too close to call"
    win, share ≥ 80%  → "strongly preferred"
    win, share ≥ 62%  → "moderately preferred"
    win, otherwise    → "slightly preferred"
    (losing side mirrors: "strongly / moderately / slightly disfavored")

Rejected alternatives: "clearly" (reads the same as "strongly"), "narrowly", and
"slight edge to it / the other way" (clunky; "the other way" makes the reader work
out which way). The loss side is "disfavored", NOT "the other way".

## Blind test

The voting screen NEVER reveals track names (no winner name in the status line,
no names in the round-complete modal). Names appear only on the results screen.
(`?debug=true`, or the header Debug toggle, reveals names for testing.)

## Constants

There are no ranking thresholds anymore — win count needs none. The only structural
constant is the round-robin itself (`C(N,2)` votes per round).
