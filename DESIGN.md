# Audio Comparison — Ranking & Confidence Design

This document is the source of truth for how the comparison tool decides a
ranking and how it talks to the user about it. The math deliberately stays
simple enough to read off a head-to-head grid by hand — no Bradley–Terry, no
maximum-likelihood, no Fisher information. Those were ripped out because they
produced rankings that **contradicted the user's own direct choices** (the
global strength fit would float an item to #1 even though the user picked a
different item over it 3-to-1 head-to-head). The whole point of this tool is
"I like this one more than that one," so the ranking is built *from* the
head-to-heads, never from a score that can override them.

## What the user wants (the requirements, in their words)

1. **"Find the one I like most"** is the #1 goal. The rest of the order is
   "interesting too" but secondary.
2. **"Winning more than B means nothing if C never got a chance to play."**
   Raw win *counts* are biased by who got served against whom. Ranking must be
   pairwise, not points-based.
3. **"I want 'like this one more than that one.'"** The unit of truth is a
   head-to-head: when two items were compared, which did the user pick.
4. **"Until I've compared every option to every other, you never really know."**
   Confidence is driven by *coverage* of pairings, not a clever model.
5. **"A bracket is too easy to get wrong, and comparing things changes my
   opinion."** Nothing gets eliminated; every vote is kept; later votes revise
   earlier standings.
6. **"If we keep getting ties, they really are the same."** A tie is a valid
   *answer*, not a failure to separate. Once confirmed, stop asking.
7. **Two kinds of user must both be served:** the friend who votes once or
   twice and wants a quick answer, AND the friend who grinds 50–100 votes and
   wants to watch confidence climb. Completion must be fast; confidence is
   optional and unbounded.

## Core model: a round-robin head-to-head grid

The only stored state is the full vote log (already persisted). From it we
tally one grid:

    wins[i][j]  = number of times the user picked i over j
    games[i][j] = wins[i][j] + wins[j][i]  (times i and j were compared)

Everything below is computed from this grid.

### Pair states

Every unordered pair is in exactly one of three states:

| State        | Condition                                              | Meaning                              |
|--------------|--------------------------------------------------------|--------------------------------------|
| `unseen`     | `games == 0`                                           | Never compared — we truly don't know |
| `provisional`| `games >= 1` but `< MEET_FLOOR`, has a leader          | A guess, lightly backed (could flip) |
| `decided`    | `games >= MEET_FLOOR` AND one side `> DECIDE_FRAC`     | The user clearly prefers one side    |
| `tied`       | `games >= MEET_FLOOR` AND roughly even (not `decided`) | Confirmed equivalent — stop asking   |

Constants:

- `MEET_FLOOR = 3` — a pair must be compared at least this many times before it
  can be called a *confirmed* `decided` or `tied`. Below the floor, a pair with
  a leader is only `provisional` ("close — vote again to confirm"). This is the
  "comparing changes my opinion / voting a lot ≠ ranking once" requirement.
- `DECIDE_FRAC = 2/3` — above the floor, a pair is `decided` only if more than
  two-thirds of its meetings went one way (3–1, 4–1, 4–2…). Otherwise it's a
  confirmed `tied` (2–2, 3–2, 3–3…).

A `provisional` pair still has a *direction* (the side currently ahead, or a
single 1–0 result). That direction is used to build the ranking after one pass;
it just carries low confidence.

## Completion vs. Confidence — the two separate ideas

This split is the heart of the design. **Completion and confidence are NOT the
same number.**

- **Completion** = "does every pair have an answer?" A pair has an answer once
  it's been seen at least once (`games >= 1`) — provisional counts. The moment
  every pair is non-`unseen`, the tool is **done**: it shows the full ranking
  and never forces the user to continue.
  - One full pass of an N-item set is `C(N,2)` votes (21 for 7 items). After
    that pass, **completion is reached** even though most pairs are only
    `provisional`.
- **Confidence** = "how hard-backed are those answers?" This is the optional,
  unbounded climb. It rises as pairs cross from `provisional` into `decided` or
  confirmed `tied`. The grinder pushes this up; the casual voter ignores it.

> Quick player: complete, correctly-ordered answer in one pass, low confidence,
> free to leave. Grinder: same answer, watches confidence climb, and knows they
> already had a valid answer the whole time.

## The ranking — clusters, not a forced total order

Rank is built so it never contradicts a user's direct, decided preference.

1. **Score each item by matchups won against the field**, each opponent counted
   ONCE (so beating Taylor 9–0 is worth the same as 5–4: it's one matchup won,
   not nine points — requirement #2). For item i vs each opponent j it has met:
   `+1` if i is decided over j, `-1` if j is decided over i, `0` if tied or
   provisional-even.
2. **Sort by that score.** Ties in score break by the direct head-to-head
   between the two items; if that's also even, they form a **tied cluster**.
3. **Adjacent items that are `tied` (or score-tied with an even head-to-head)
   merge into one cluster** sharing a rank number (Olympic style: two "3rd",
   then "5th").

This applies at **every position, including #1.** If the top two keep splitting
past the floor, there is no single winner — there's a **winner's circle** (a
2- or 3-way tie for first), shown in arbitrary/alphabetical order within the
group. "No clear #1 after enough tries" is not a stuck state; it *is* the
answer.

Genuine rock-paper-scissors knots (A>B>C>A) can leave one unavoidable
violation; rank those by overall matchups-won and flag the leftover pair as
`tied`/close rather than hiding it.

## The progress bar — three phases, one bar

The bar communicates *which phase you're in and how much further to the next
milestone*, NOT "0→100% complete." Under the bar, text always names the phase
and the small, reachable next number.

| Phase | True when… | Message (must / may / just-for-confidence) |
|-------|------------|--------------------------------------------|
| **1. Finding the winner** | Top cluster not yet locked | *"Keep going — no winner yet. ~N votes."* (must continue) |
| **2. Settling the rest**  | Top cluster locked; lower clusters still have provisional/close pairs | *"🏆 Winner: X. Spots 3–4 still close — ~N to settle (or stop)."* (may continue) |
| **3. Raising confidence** | Every pair decided or confirmed-tied | *"Ranking settled — keep voting only to raise confidence."* (optional) |

A **"good enough to stop" marker** sits on the bar at the end of phase 2, so the
user can *see* that everything past it is bonus. This is the retention release
valve: passing the marker means "you didn't fail to finish — the rest is extra."

Note completion (one pass) can arrive during phase 1 or 2; the bar/phase text is
about *confidence milestones*, while the "you're done, here's your ranking" state
is governed by completion. A user can be "done" (has a full ranking) while the
bar still invites more votes to firm it up.

## The competence score (NOT statistical confidence)

A felt "I'm pretty sure → more sure → really sure," not a p-value (the user
explicitly did not want it to feel statistical). Shown as a **tier label**
(headline) with the **bar fill** providing motion so the needle visibly moves
on each vote.

    Pretty sure  →  Confident  →  Rock solid

Computed as the **weakest link**: a ranking is only as trustworthy as its
shakiest adjacent pair. For each adjacent pair in the standings, its "sureness"
is how lopsided and how repeated its head-to-head is:

    margin   = |wins_ij - wins_ji| / games_ij      // 0..1, how one-sided
    backing  = min(1, games_ij / MEET_FLOOR)        // how many meetings back it
    sureness = margin * backing                     // decided-far + well-met = high
                                                    // a confirmed TIE counts as
                                                    // sure too (we KNOW it's even)

The competence score is the minimum sureness across adjacent boundaries
(treating a confirmed tie boundary as fully sure — we are confident they're
equal). One pass → mostly low backing → "Pretty sure." Grinding raises every
boundary → "Rock solid."

## "Votes remaining" — the retention number

The user said telling people how much longer is **critical** to stop them
leaving. We estimate work to the **next milestone** only (never the far finish):

- **To complete:** count `unseen` pairs (each needs ~1 vote to register).
- **To crown the winner (phase 1→2):** votes for the top boundary to lock
  (reach the floor with a ≥2 margin, or confirm a top tie).
- **To settle the rest (phase 2→3):** sum over still-`provisional` pairs of how
  many more meetings each needs to reach `MEET_FLOOR` (≈ `MEET_FLOOR - games`).

Always display the smallest, nearest milestone ("~4 votes to your winner"),
because "37 to fully resolve" makes people quit.

## Matchmaking

Serve only pairs that still need work, so the engine can't loop the user on an
already-settled pair (the old tool re-asked one near-tie ~10×):

- Never serve a `decided` or confirmed-`tied` pair.
- Prefer `unseen` pairs first (reach completion fast — serves the casual voter).
- Then prefer `provisional` pairs, weighted toward those closest in the current
  standings (settling the order where it actually matters) and those with the
  fewest meetings.
- Cap repeats so no single pair dominates a session.

## Constants summary

| Name          | Value | Role                                                        |
|---------------|-------|-------------------------------------------------------------|
| `MEET_FLOOR`  | 3     | Min meetings before a pair is *confirmed* decided/tied      |
| `DECIDE_FRAC` | 2/3   | Fraction one-sided needed to be `decided` (else `tied`)     |
| `WIN_MARGIN`  | 2     | Head-to-head margin for the top boundary to "crown" #1      |

## What was removed

- Bradley–Terry MLE / MM iteration, latent strengths `θ`, the `1500 + SCALE·θ`
  Elo-style display rating.
- Fisher-information standard errors and the `z`-score significance test
  (`SEP_Z`), including the "≈ tied" flag based on overlapping `r ± rd` intervals.
- The single `precision()` metric that conflated coverage and separation and
  could never reach 100% when genuine ties existed.

Display ratings, if still shown, are derived directly from matchup record
(e.g. win rate), not from a fitted strength.
