/* ==================================================================== *
 * preference-rating.js  —  head-to-head preference ranking core
 * ==================================================================== *
 *
 * PURE LOGIC, NO DOM. Single source of truth for the ranking used by the
 * audio-comparison tool. Loaded two ways:
 *
 *   • Browser:  <script src="preference-rating.js"></script>  → window.PreferenceCore
 *   • Node:     const { PreferenceCore, runTests } = require('./preference-rating.js');
 *               `node preference-rating.js`  runs the test suite.
 *
 * See DESIGN.md for the full rationale. The short version:
 *
 * This used to be a Bradley–Terry maximum-likelihood model. It was ripped out
 * because the global strength fit produced rankings that CONTRADICTED the user's
 * own direct head-to-head choices (it would put item X at #1 even though the user
 * picked Y over X three times out of four). This tool is "I like this one more
 * than that one", so the ranking is built FROM the head-to-heads and can never
 * override them.
 *
 * THE MODEL — one head-to-head grid:
 *   wins[i][j]  = times the user picked i over j
 *   games[i][j] = wins[i][j] + wins[j][i]
 *
 * Each pair is `unseen` / `provisional` / `decided` / `tied`. Rank by matchups
 * won against the field (each opponent counted once, so a 9–0 blowout is worth
 * the same as a 5–4 win: one matchup). Tied items merge into shared-rank
 * clusters — this applies at #1 too (a "winner's circle"). A confirmed tie is a
 * valid ANSWER, not a failure to separate.
 *
 * COMPLETION (every pair seen ≥1×) is separate from CONFIDENCE (how hard-backed
 * those answers are). One pass → a complete, correct ranking at low confidence;
 * grinding raises confidence without ever being required.
 * ==================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;                 // Node
    if (require.main === module) {
      const ok = api.runTests();
      if (typeof process !== "undefined") process.exit(ok ? 0 : 1);
    }
  } else {
    root.PreferenceCore = api.PreferenceCore;   // browser global
    root.runPreferenceTests = api.runTests;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * PreferenceCore — the pure ranking engine.
   *
   * Constructed with a list of opaque keys (strings). Maintains the wins/games
   * grid, derives pair states, ranking clusters, completion, confidence, and
   * the next matchup to serve. Knows NOTHING about audio or the DOM.
   *
   * An injectable RNG (default Math.random) keeps nextPair() deterministic
   * under test.
   * ------------------------------------------------------------------ */
  class PreferenceCore {
    constructor(keys, opts) {
      opts = opts || {};
      this.keys = keys.slice();
      this.idx = new Map(this.keys.map((k, i) => [k, i]));
      this.n = keys.length;
      this.voteCount = 0;
      this.rng = opts.rng || Math.random;

      // wins[i][j] = times item i was preferred over item j
      this.wins = Array.from({ length: this.n }, () => new Array(this.n).fill(0));
      // games[i][j] = total comparisons between i and j (symmetric)
      this.games = Array.from({ length: this.n }, () => new Array(this.n).fill(0));
    }

    // ---- tunable constants (see DESIGN.md) -------------------------------
    // Min meetings before a pair is a CONFIRMED decided/tied (vs provisional).
    static get MEET_FLOOR() { return 3; }
    // Fraction one-sided needed to be `decided` (else it's a confirmed tie).
    static get DECIDE_FRAC() { return 2 / 3; }
    // Head-to-head margin the top boundary needs to "crown" a single winner.
    static get WIN_MARGIN() { return 2; }

    _record(iWin, iLose) {
      this.wins[iWin][iLose]++;
      this.games[iWin][iLose]++;
      this.games[iLose][iWin]++;
      this.voteCount++;
    }

    // Record a single vote by key. Returns true if accepted.
    vote(aKey, bKey, winnerKey) {
      const wi = this.idx.get(winnerKey);
      const loserKey = winnerKey === aKey ? bKey : aKey;
      const oi = this.idx.get(loserKey);
      if (wi == null || oi == null || wi === oi) return false;
      this._record(wi, oi);
      return true;
    }

    // Load a prior vote log (array of {a, b, winner}) into the grid.
    replay(log) {
      for (const v of log) {
        const wi = this.idx.get(v.winner);
        const oi = this.idx.get(v.winner === v.a ? v.b : v.a);
        if (wi == null || oi == null || wi === oi) continue;
        this._record(wi, oi);
      }
    }

    /* ---- pair state ---------------------------------------------------- *
     * Returns { games, wins, loss, leader, state } for the unordered pair
     * (i, j). `leader` is the index currently ahead (or null if dead even),
     * `state` ∈ "unseen" | "provisional" | "decided" | "tied".
     * -------------------------------------------------------------------- */
    pairState(i, j) {
      const w = this.wins[i][j], l = this.wins[j][i], g = w + l;
      const leader = w > l ? i : l > w ? j : null;
      let state;
      if (g === 0) {
        state = "unseen";
      } else if (g < PreferenceCore.MEET_FLOOR) {
        state = "provisional";
      } else {
        const top = Math.max(w, l);
        state = (top / g) > PreferenceCore.DECIDE_FRAC ? "decided" : "tied";
      }
      return { i, j, games: g, wins: w, loss: l, leader, state };
    }

    // P(i is preferred over j) as a simple smoothed win rate — handy for the UI
    // and tests. Laplace-smoothed so an unseen pair reads 0.5.
    winProb(aKey, bKey) {
      const i = this.idx.get(aKey), j = this.idx.get(bKey);
      const w = this.wins[i][j], l = this.wins[j][i];
      return (w + 0.5) / (w + l + 1);
    }

    /* ---- ranking ------------------------------------------------------- *
     * Score each item by matchups WON against the field (each opponent counted
     * once): +1 if decided over j, -1 if decided under j, 0 otherwise. For
     * provisional pairs we lean on the current leader at half weight so a single
     * pass still yields a sensible order without overriding decided results.
     *
     * Returns rows best-first:
     *   { key, score, wins, losses, played, winRate, r, rank, tied }
     * `rank` is the 1-based cluster rank (shared by tied items); `tied` is true
     * when the item shares its rank with a neighbor (a tie cluster, incl. #1).
     * -------------------------------------------------------------------- */
    ranking() {
      const n = this.n;
      const score = new Array(n).fill(0);
      const decidedWins = new Array(n).fill(0);
      const decidedLoss = new Array(n).fill(0);
      const played = new Array(n).fill(0);
      let totalVotesPer = new Array(n).fill(0);
      let totalWinsPer = new Array(n).fill(0);

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const g = this.games[i][j];
          if (g > 0) { played[i]++; totalVotesPer[i] += g; totalWinsPer[i] += this.wins[i][j]; }
          if (j <= i) continue;
          const ps = this.pairState(i, j);
          if (ps.state === "decided") {
            if (ps.leader === i) { score[i] += 1; score[j] -= 1; decidedWins[i]++; decidedLoss[j]++; }
            else                 { score[j] += 1; score[i] -= 1; decidedWins[j]++; decidedLoss[i]++; }
          } else if (ps.state === "provisional" && ps.leader != null) {
            // half weight: provisional direction informs the order but yields to
            // any decided result and to a true score difference.
            if (ps.leader === i) { score[i] += 0.5; score[j] -= 0.5; }
            else                 { score[j] += 0.5; score[i] -= 0.5; }
          }
          // unseen / tied contribute 0
        }
      }

      const rows = this.keys.map((key, i) => ({
        key,
        score: score[i],
        wins: decidedWins[i],
        losses: decidedLoss[i],
        played: played[i],
        // overall win rate across all meetings — a cosmetic readout only
        winRate: totalVotesPer[i] ? totalWinsPer[i] / totalVotesPer[i] : 0,
        // display rating (cosmetic): 1500 centered, scaled by net matchup score
        r: 1500 + 80 * score[i],
        _i: i,
      }));

      // sort best-first by score, then by direct head-to-head, then by win rate
      rows.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const wa = this.wins[a._i][b._i], wb = this.wins[b._i][a._i];
        if (wa !== wb) return wb - wa;
        return b.winRate - a.winRate;
      });

      // assign cluster ranks: two adjacent rows are in the SAME cluster when
      // neither is `decided` over the other (i.e. tied / provisional-even /
      // unseen between them AND equal score). Olympic-style shared rank numbers.
      let rank = 1;
      for (let p = 0; p < rows.length; p++) {
        if (p === 0) { rows[p].rank = 1; continue; }
        const prev = rows[p - 1], cur = rows[p];
        const ps = this.pairState(prev._i, cur._i);
        const mergeable = cur.score === prev.score && ps.state !== "decided";
        if (mergeable) {
          rows[p].rank = prev.rank;          // same cluster
        } else {
          rows[p].rank = p + 1;              // new cluster (Olympic gap)
        }
      }
      // mark tie clusters (any rank shared by >1 row)
      const countByRank = {};
      for (const row of rows) countByRank[row.rank] = (countByRank[row.rank] || 0) + 1;
      for (const row of rows) { row.tied = countByRank[row.rank] > 1; delete row._i; }

      return rows;
    }

    /* ---- completion / phase / confidence ------------------------------- *
     * status() returns the single object the UI needs:
     *   {
     *     complete,            // every pair seen ≥1× → a full ranking exists
     *     phase,               // 1 finding-winner | 2 settling | 3 confident
     *     winnerLocked,        // top cluster is locked (single winner or tie)
     *     winners: [keys],     // the top cluster (1+ keys)
     *     competence,          // 0..1 felt-sureness (weakest adjacent boundary)
     *     tier,                // "building" | "pretty-sure" | "confident" | "rock-solid"
     *     fill,                // 0..1 bar fill (phase-aware, see below)
     *     stopOk,              // true once phase ≥ 2 (good-enough-to-stop marker passed)
     *     votesToNext,         // est. votes to the next milestone
     *     nextLabel,           // what that milestone is
     *   }
     * -------------------------------------------------------------------- */
    status() {
      const n = this.n;
      if (n < 2) {
        return { complete: true, phase: 3, winnerLocked: true, winners: this.keys.slice(),
                 competence: 1, tier: "rock-solid", fill: 1, stopOk: true,
                 votesToNext: 0, nextLabel: "done" };
      }

      // gather pair states
      let unseen = 0, provisional = 0, settled = 0, total = 0;
      let provisionalNeed = 0;     // extra meetings to bring provisionals to floor
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ps = this.pairState(i, j);
          total++;
          if (ps.state === "unseen") unseen++;
          else if (ps.state === "provisional") {
            provisional++;
            provisionalNeed += Math.max(1, PreferenceCore.MEET_FLOOR - ps.games);
          } else settled++;
        }
      }
      const complete = unseen === 0;

      const rows = this.ranking();

      // ---- winner lock: is the top boundary resolved? --------------------
      // Locked if the top cluster is a confirmed tie (winner's circle) OR the
      // #1 vs #2 boundary is `decided` with margin ≥ WIN_MARGIN over the floor.
      const topRank = rows[0].rank;
      const winners = rows.filter(r => r.rank === topRank).map(r => r.key);
      let winnerLocked, votesToWinner = 0;
      if (winners.length > 1) {
        // top is a tie cluster — locked only once those pairs cleared the floor
        winnerLocked = true;
        for (let a = 0; a < winners.length; a++)
          for (let b = a + 1; b < winners.length; b++) {
            const ps = this.pairState(this.idx.get(winners[a]), this.idx.get(winners[b]));
            if (ps.games < PreferenceCore.MEET_FLOOR) { winnerLocked = false; votesToWinner += (PreferenceCore.MEET_FLOOR - ps.games); }
          }
      } else {
        const top = rows[0], second = rows[1];
        const ti = this.idx.get(top.key), si = this.idx.get(second.key);
        const ps = this.pairState(ti, si);
        const margin = Math.abs(ps.wins - ps.loss);
        winnerLocked = ps.games >= PreferenceCore.MEET_FLOOR &&
                       ps.state === "decided" && margin >= PreferenceCore.WIN_MARGIN;
        if (!winnerLocked) {
          // rough votes to lock: reach floor, then enough to hit the margin
          const toFloor = Math.max(0, PreferenceCore.MEET_FLOOR - ps.games);
          const toMargin = Math.max(0, PreferenceCore.WIN_MARGIN - margin);
          votesToWinner = Math.max(1, toFloor, Math.ceil(toMargin / 2) + toFloor);
        }
      }

      // ---- competence: weakest adjacent boundary -------------------------
      // Each adjacent boundary's "sureness": a decided gap = margin·backing; a
      // confirmed tie boundary counts as fully sure (we KNOW it's even).
      let competence = 1;
      for (let p = 0; p < rows.length - 1; p++) {
        if (rows[p].rank === rows[p + 1].rank) continue;   // inside a tie cluster
        const i = this.idx.get(rows[p].key), j = this.idx.get(rows[p + 1].key);
        const ps = this.pairState(i, j);
        let sure;
        if (ps.state === "tied") sure = 1;                  // confirmed equal
        else if (ps.games === 0) sure = 0;
        else {
          const margin = Math.abs(ps.wins - ps.loss) / ps.games;
          const backing = Math.min(1, ps.games / PreferenceCore.MEET_FLOOR);
          sure = margin * backing;
        }
        competence = Math.min(competence, sure);
      }

      // ---- phase + fill --------------------------------------------------
      const allSettled = unseen === 0 && provisional === 0;
      let phase;
      if (!winnerLocked) phase = 1;
      else if (!allSettled) phase = 2;
      else phase = 3;

      // bar fill: phase 1 = 0..0.5 by coverage toward winner-lock;
      //           phase 2 = 0.5..0.85 by fraction of pairs settled;
      //           phase 3 = 0.85..1.0 by competence.
      let fill;
      const coverage = total ? (total - unseen) / total : 1;
      const settledFrac = total ? settled / total : 1;
      if (phase === 1)      fill = 0.5 * coverage * 0.9; // cap below .5 until locked
      else if (phase === 2) fill = 0.5 + 0.35 * settledFrac;
      else                  fill = 0.85 + 0.15 * competence;
      if (winnerLocked && fill < 0.5) fill = 0.5;

      // ---- tier ----------------------------------------------------------
      let tier;
      if (!winnerLocked) tier = "building";
      else if (competence >= 0.85) tier = "rock-solid";
      else if (competence >= 0.5) tier = "confident";
      else tier = "pretty-sure";

      // ---- next milestone + votes remaining ------------------------------
      let votesToNext, nextLabel;
      if (!complete) {
        votesToNext = unseen;
        nextLabel = "complete the first pass";
      } else if (phase === 1) {
        votesToNext = Math.max(1, votesToWinner);
        nextLabel = "find your winner";
      } else if (phase === 2) {
        votesToNext = Math.max(1, provisionalNeed);
        nextLabel = "settle the rest of the ranking";
      } else {
        votesToNext = 0;
        nextLabel = "raise confidence (optional)";
      }

      return {
        complete, phase, winnerLocked, winners,
        competence, tier, fill,
        stopOk: phase >= 2,
        votesToNext, nextLabel,
        counts: { unseen, provisional, settled, total },
      };
    }

    // Back-compat: the UI's bar reads a single 0..1 number. precision() now maps
    // to the phase-aware fill from status().
    precision() { return this.status().fill; }

    /* ---- next matchup -------------------------------------------------- *
     * Serve only pairs that still need work; never re-serve a settled pair.
     * Priority: unseen first (reach completion fast), then provisional pairs
     * weighted toward those closest in the current standings and least-met.
     * If everything is settled, pick the weakest adjacent boundary to firm up
     * (so a grinder can keep raising confidence) — but with a low ceiling so it
     * doesn't loop forever. Returns [keyA, keyB] with randomized side order.
     * -------------------------------------------------------------------- */
    nextPair() {
      if (this.n < 2) return null;
      const rows = this.ranking();
      const pos = new Map(rows.map((row, r) => [row.key, r]));

      const candidates = [];
      let total = 0;
      for (let i = 0; i < this.n; i++) {
        for (let j = i + 1; j < this.n; j++) {
          const ps = this.pairState(i, j);
          const ki = this.keys[i], kj = this.keys[j];
          const adjacency = 1 / (1 + Math.abs(pos.get(ki) - pos.get(kj)));
          let w = 0;
          if (ps.state === "unseen") {
            w = 100;                                   // top priority: complete the pass
          } else if (ps.state === "provisional") {
            const toFloor = PreferenceCore.MEET_FLOOR - ps.games;
            w = 10 + 6 * toFloor + 8 * adjacency;      // close-in-standings, under-met
          } else {
            // settled: only a faint pull so grinders can firm up the weakest gap
            const margin = ps.games ? Math.abs(ps.wins - ps.loss) / ps.games : 1;
            w = 0.4 * (1 - margin) * adjacency;
          }
          if (w > 0) { candidates.push({ i, j, w }); total += w; }
        }
      }
      if (!candidates.length) {
        // everything maximally settled — fall back to a random distinct pair
        let i = Math.floor(this.rng() * this.n), j = Math.floor(this.rng() * (this.n - 1));
        if (j >= i) j++;
        candidates.push({ i, j, w: 1 }); total = 1;
      }

      let pick = candidates[0];
      let roll = this.rng() * total;
      for (const c of candidates) { roll -= c.w; if (roll <= 0) { pick = c; break; } }
      const ka = this.keys[pick.i], kb = this.keys[pick.j];
      return this.rng() < 0.5 ? [ka, kb] : [kb, ka];
    }
  }

  /* ================================================================== *
   * TEST SUITE — `node preference-rating.js` runs it. Returns true iff green.
   * ================================================================== */
  function runTests() {
    let passed = 0, failed = 0;
    const fails = [];
    function ok(cond, msg) { if (cond) passed++; else { failed++; fails.push(msg); } }
    function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`); }
    function makeRng(seed) {
      let s = seed >>> 0;
      return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
    }
    function voteN(core, w, l, count) { for (let k = 0; k < count; k++) core.vote(w, l, w); }
    const FLOOR = PreferenceCore.MEET_FLOOR;

    // ---- 1. Construction sane with zero votes ----------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      ok(c.n === 3, "n reflects key count");
      const rk = c.ranking();
      ok(rk.length === 3, "ranking has all items");
      ok(rk.every(r => r.score === 0), "no votes ⇒ all scores 0");
      const s = c.status();
      ok(!s.complete, "no votes ⇒ not complete");
      ok(s.phase === 1, "no votes ⇒ phase 1");
      approx(s.fill, 0, 1e-9, "no votes ⇒ empty bar");
    })();

    // ---- 2. Consistent winner ranks above loser, never contradicts H2H ---
    (function () {
      const c = new PreferenceCore(["A", "B"]);
      voteN(c, "A", "B", 5);
      const rk = c.ranking();
      ok(rk[0].key === "A", "5–0 ⇒ A ranks first");
      ok(c.winProb("A", "B") > 0.5, "winProb(A,B) > 0.5 after A wins");
      ok(c.pairState(0, 1).state === "decided", "5–0 ⇒ decided");
    })();

    // ---- 3. THE headline fix: direct H2H is never overridden -------------
    // The exact shape of the user's real bug: B beats everyone weak, but A beat
    // B directly 3–1. A must NOT rank below B.
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"]);
      voteN(c, "A", "B", 3); voteN(c, "B", "A", 1);   // A>B 3–1 (decided for A)
      voteN(c, "B", "C", 4); voteN(c, "B", "D", 4);   // B crushes C, D
      const rk = c.ranking();
      const posA = rk.findIndex(r => r.key === "A");
      const posB = rk.findIndex(r => r.key === "B");
      ok(posA < posB, "A (beat B 3–1 directly) ranks above B despite B's transitive wins");
    })();

    // ---- 4. Transitivity emerges for decided pairs -----------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      voteN(c, "A", "B", 3); voteN(c, "B", "C", 3); voteN(c, "A", "C", 3);
      const rk = c.ranking();
      ok(rk.map(r => r.key).join("") === "ABC", "A>B>C ordering");
    })();

    // ---- 5. Flip-flop past the floor ⇒ confirmed TIE ---------------------
    (function () {
      const c = new PreferenceCore(["A", "B"]);
      for (let k = 0; k < 3; k++) { c.vote("A", "B", "A"); c.vote("A", "B", "B"); } // 3–3
      ok(c.pairState(0, 1).state === "tied", "even record past floor ⇒ tied");
      const rk = c.ranking();
      ok(rk[0].rank === rk[1].rank, "tied items share a rank (cluster)");
      ok(rk[0].tied && rk[1].tied, "both flagged tied");
    })();

    // ---- 6. Below floor with a leader ⇒ provisional, not decided ---------
    (function () {
      const c = new PreferenceCore(["A", "B"]);
      c.vote("A", "B", "A");                       // 1–0, below floor
      ok(c.pairState(0, 1).state === "provisional", "1–0 ⇒ provisional");
      voteN(c, "A", "B", FLOOR);                   // push past floor, all A
      ok(c.pairState(0, 1).state === "decided", "past floor & one-sided ⇒ decided");
    })();

    // ---- 7. Completion after one pass (every pair seen once) -------------
    (function () {
      const keys = ["A", "B", "C", "D"];
      const c = new PreferenceCore(keys);
      // one pass: every pair once, A>B>C>D
      const order = { A: 4, B: 3, C: 2, D: 1 };
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const w = order[keys[i]] > order[keys[j]] ? keys[i] : keys[j];
          c.vote(keys[i], keys[j], w);
        }
      const s = c.status();
      ok(s.complete, "one pass ⇒ complete (full ranking exists)");
      ok(c.ranking().map(r => r.key).join("") === "ABCD", "one-pass order correct");
      ok(s.tier === "building" || s.tier === "pretty-sure", "one pass ⇒ low confidence tier");
    })();

    // ---- 8. Completion ≠ confidence: grinding raises competence ----------
    (function () {
      const keys = ["A", "B", "C"];
      const c = new PreferenceCore(keys, { rng: makeRng(1) });
      const order = { A: 3, B: 2, C: 1 };
      // one pass
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
        c.vote(keys[i], keys[j], order[keys[i]] > order[keys[j]] ? keys[i] : keys[j]);
      const c1 = c.status().competence;
      // grind consistently
      for (let t = 0; t < 30; t++) {
        const [x, y] = c.nextPair();
        c.vote(x, y, order[x] > order[y] ? x : y);
      }
      const c2 = c.status().competence;
      ok(c2 >= c1, "grinding does not lower competence");
      ok(c2 > 0.5, "consistent grinding reaches at least 'confident'");
    })();

    // ---- 9. Winner's circle: top tie crowns co-winners, doesn't hang -----
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      // A and B tie (3–3), both clearly beat C
      for (let k = 0; k < 3; k++) { c.vote("A", "B", "A"); c.vote("A", "B", "B"); }
      voteN(c, "A", "C", 3); voteN(c, "B", "C", 3);
      const s = c.status();
      ok(s.winnerLocked, "confirmed top tie ⇒ winner locked (no hang)");
      ok(s.winners.length === 2 && s.winners.includes("A") && s.winners.includes("B"),
        "top tie ⇒ A and B are co-winners");
    })();

    // ---- 10. Single clear winner crowns once margin/floor met ------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      voteN(c, "A", "B", 3); voteN(c, "A", "C", 3); voteN(c, "B", "C", 3);
      const s = c.status();
      ok(s.winnerLocked, "decisive A ⇒ winner locked");
      ok(s.winners.length === 1 && s.winners[0] === "A", "A is the sole winner");
    })();

    // ---- 11. precision()/fill monotonic-ish and in [0,1] -----------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"], { rng: makeRng(5) });
      const order = { A: 4, B: 3, C: 2, D: 1 };
      let prev = 0, ok01 = true, neverWild = true;
      for (let t = 0; t < 60; t++) {
        const [x, y] = c.nextPair();
        c.vote(x, y, order[x] > order[y] ? x : y);
        const f = c.precision();
        if (f < 0 || f > 1) ok01 = false;
        if (f < prev - 0.2) neverWild = false;   // no catastrophic wipe
        prev = f;
      }
      ok(ok01, "fill stays within [0,1]");
      ok(neverWild, "fill never wipes (no >0.2 single drop)");
      ok(c.precision() > 0.8, "consistent voter ends high");
    })();

    // ---- 12. nextPair valid, distinct, prefers unseen then provisional ---
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"], { rng: makeRng(7) });
      const seen = new Set();
      for (let t = 0; t < 6; t++) {
        const p = c.nextPair();
        ok(Array.isArray(p) && p.length === 2 && p[0] !== p[1], "nextPair returns a distinct pair");
        ok(c.idx.has(p[0]) && c.idx.has(p[1]), "nextPair items are known keys");
        const k = [p[0], p[1]].sort().join("|");
        // first 6 picks on 4 items (6 pairs) should each be a fresh unseen pair
        ok(!seen.has(k), "unseen pairs served before repeats");
        seen.add(k);
        c.vote(p[0], p[1], p[0]);
      }
    })();

    // ---- 13. Settled pairs are not re-served (no endless re-asking) ------
    // Drive to all-settled, then confirm nextPair stops hammering decided pairs.
    (function () {
      const keys = ["A", "B", "C", "D"];
      const c = new PreferenceCore(keys, { rng: makeRng(11) });
      const order = { A: 4, B: 3, C: 2, D: 1 };
      for (let t = 0; t < 200 && c.status().counts.unseen + c.status().counts.provisional > 0; t++) {
        const [x, y] = c.nextPair();
        c.vote(x, y, order[x] > order[y] ? x : y);
      }
      const s = c.status();
      ok(s.counts.unseen === 0, "all pairs eventually seen");
      ok(s.phase === 3, "fully settled ⇒ phase 3");
      // now every pair is decided/tied; 20 more picks must each be an already-met pair
      let allMet = true;
      for (let t = 0; t < 20; t++) {
        const [x, y] = c.nextPair();
        if (c.games[c.idx.get(x)][c.idx.get(y)] === 0) allMet = false;
        c.vote(x, y, order[x] > order[y] ? x : y);
      }
      ok(allMet, "after settling, nextPair never serves an unseen pair");
    })();

    // ---- 14. votesToNext shrinks toward each milestone -------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"], { rng: makeRng(3) });
      const s0 = c.status();
      ok(s0.nextLabel === "complete the first pass", "starts by asking to complete a pass");
      ok(s0.votesToNext === 3, "3 unseen pairs ⇒ 3 votes to complete");
    })();

    // ---- 15. replay() == sequential vote() -------------------------------
    (function () {
      const log = [
        { a: "A", b: "B", winner: "A" }, { a: "B", b: "C", winner: "C" },
        { a: "A", b: "C", winner: "A" }, { a: "A", b: "B", winner: "B" },
      ];
      const cr = new PreferenceCore(["A", "B", "C"]); cr.replay(log);
      const cv = new PreferenceCore(["A", "B", "C"]); for (const v of log) cv.vote(v.a, v.b, v.winner);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
        ok(cr.wins[i][j] === cv.wins[i][j], `replay matches vote() wins[${i}][${j}]`);
      ok(cr.voteCount === cv.voteCount && cr.voteCount === 4, "replay vote count correct");
    })();

    // ---- 16. Determinism: same seed ⇒ same matchup sequence --------------
    (function () {
      function seq(seed) {
        const c = new PreferenceCore(["A", "B", "C"], { rng: makeRng(seed) });
        const out = [];
        for (let t = 0; t < 20; t++) { const p = c.nextPair(); out.push(p.join(">")); c.vote(p[0], p[1], p[0]); }
        return out.join(",");
      }
      ok(seq(99) === seq(99), "same seed ⇒ identical sequence");
      ok(seq(99) !== seq(100), "different seed ⇒ different sequence");
    })();

    // ---- 17. Vote rejects bad input --------------------------------------
    (function () {
      const c = new PreferenceCore(["A", "B"]);
      ok(c.vote("A", "B", "A") === true, "valid vote accepted");
      ok(c.vote("A", "X", "A") === false, "unknown loser rejected");
      ok(c.vote("A", "A", "A") === false, "self-vote rejected");
      ok(c.voteCount === 1, "rejected votes not counted");
    })();

    // ---- 18. Noisy-but-decisive voter recovers a sensible order ----------
    (function () {
      const keys = ["A", "B", "C", "D", "E"];
      const rng = makeRng(2024);
      const c = new PreferenceCore(keys, { rng });
      const strength = { A: 5, B: 4, C: 3, D: 2, E: 1 };
      for (let t = 0; t < 200; t++) {
        const [x, y] = c.nextPair();
        const better = strength[x] > strength[y] ? x : y, worse = better === x ? y : x;
        const gap = Math.abs(strength[x] - strength[y]);
        const pCorrect = 0.5 + 0.18 * gap;
        c.vote(x, y, rng() < pCorrect ? better : worse);
      }
      const rk = c.ranking().map(r => r.key);
      ok(rk.indexOf("A") <= 1, "noisy voter: true-best A lands top-2");
      ok(rk.indexOf("E") >= 3, "noisy voter: true-worst E lands bottom-2");
    })();

    // ---- 19. Tie cluster uses Olympic shared ranks -----------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"]);
      voteN(c, "A", "B", 3); voteN(c, "A", "C", 3); voteN(c, "A", "D", 3); // A clear #1
      // B, C tie; both beat D
      for (let k = 0; k < 3; k++) { c.vote("B", "C", "B"); c.vote("B", "C", "C"); }
      voteN(c, "B", "D", 3); voteN(c, "C", "D", 3);
      const rk = c.ranking();
      ok(rk[0].key === "A" && rk[0].rank === 1, "A is rank 1");
      const bRow = rk.find(r => r.key === "B"), cRow = rk.find(r => r.key === "C");
      ok(bRow.rank === cRow.rank, "B and C share a rank (tie cluster)");
      const dRow = rk.find(r => r.key === "D");
      ok(dRow.rank > bRow.rank, "D ranks below the B/C cluster");
    })();

    // ---- 20. The real-data regression: no ranking contradicts a decided H2H
    // Reconstructed shape from the user's session: ensure the final ranking has
    // ZERO inversions of a decided head-to-head.
    (function () {
      const keys = ["A", "B", "C", "D", "E"];
      const rng = makeRng(77);
      const c = new PreferenceCore(keys, { rng });
      const strength = { A: 5, B: 4, C: 3, D: 2, E: 1 };
      for (let t = 0; t < 300; t++) {
        const [x, y] = c.nextPair();
        const better = strength[x] > strength[y] ? x : y, worse = better === x ? y : x;
        const gap = Math.abs(strength[x] - strength[y]);
        c.vote(x, y, rng() < 0.5 + 0.2 * gap ? better : worse);
      }
      const rk = c.ranking();
      const posOf = {}; rk.forEach((r, i) => posOf[r.key] = i);
      let inversions = 0;
      for (let i = 0; i < c.n; i++) for (let j = i + 1; j < c.n; j++) {
        const ps = c.pairState(i, j);
        if (ps.state !== "decided") continue;
        const hi = ps.leader, lo = hi === i ? j : i;
        if (posOf[keys[hi]] > posOf[keys[lo]]) inversions++;
      }
      ok(inversions === 0, "ranking never contradicts a decided head-to-head");
    })();

    // ---- summary ---------------------------------------------------------
    const total = passed + failed;
    const line = (s) => (typeof console !== "undefined" ? console.log(s) : void 0);
    line("");
    line(`preference-rating.js test suite`);
    line(`  ${passed}/${total} assertions passed`);
    if (failed) { line(`  ${failed} FAILED:`); for (const f of fails) line(`    ✗ ${f}`); }
    else line(`  ✓ all green`);
    line("");
    return failed === 0;
  }

  return { PreferenceCore, runTests };
});
