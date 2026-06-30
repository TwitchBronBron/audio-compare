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
 * THE MODEL — rank by TOTAL WINS.
 *   wins[i][j]  = times the user picked i over j
 *   games[i][j] = wins[i][j] + wins[j][i]
 *   score(i)    = Σ_j wins[i][j]   (every pick it ever won)
 *
 * Because matchmaking enforces a full round-robin, every item plays every other
 * the SAME number of times. With equal games, "total wins", "win rate", and
 * "win/loss ratio" all produce the IDENTICAL ranking — so we use the simplest,
 * most explainable one: just count the wins. Ties = equal win counts.
 *
 * Earlier versions tried Bradley–Terry (a global strength fit) and then a
 * Copeland + cycle-breaking model. Both were removed: Bradley–Terry overrode the
 * user's direct picks, and Copeland produced rankings that disagreed with the
 * on-screen "picks" count (a lower-picks item could rank higher), which confused
 * users. Win-count makes the ranking exactly equal the picks number — no surprises.
 *
 * COMPLETION is round-based: a ranking only exists once at least one FULL
 * round-robin is done (every pair played the same number of times). You can't
 * rank fairly on a partial cycle. CONFIDENCE follows rounds completed.
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
   * grid, derives the win-count ranking, round-robin progress/completion, a
   * rounds-based confidence tier, and the next matchup to serve. Knows NOTHING
   * about audio or the DOM.
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

    // ---- per-pair record (for the debug panel + explain readout) ---------
    // Returns { games, wins, loss, leader } for the unordered pair (i, j).
    // `leader` is the index currently ahead, or null if dead even.
    pairState(i, j) {
      const w = this.wins[i][j], l = this.wins[j][i], g = w + l;
      const leader = w > l ? i : l > w ? j : null;
      return { i, j, games: g, wins: w, loss: l, leader };
    }

    // P(i preferred over j) as a Laplace-smoothed win rate (UI + tests).
    winProb(aKey, bKey) {
      const i = this.idx.get(aKey), j = this.idx.get(bKey);
      const w = this.wins[i][j], l = this.wins[j][i];
      return (w + 0.5) / (w + l + 1);
    }

    /* ---- ranking ------------------------------------------------------- *
     * Score = TOTAL WINS (Σ over opponents of wins[i][j]). Sort highest-first.
     * Items with equal win counts share a rank (a tie). Because the round-robin
     * gives everyone equal games, total wins == win rate == win/loss order.
     *
     * Returns rows best-first:
     *   { key, score, wins, losses, played, votesWon, votesTotal, winRate,
     *     rank, tied }
     * `score` == `votesWon` == total wins (the number that sets the rank).
     * `rank` is 1-based and shared by tied items; `tied` is true when an item
     * shares its rank with another.
     * -------------------------------------------------------------------- */
    ranking() {
      const n = this.n;
      const totalWinsPer = new Array(n).fill(0);
      const totalLossPer = new Array(n).fill(0);
      const totalVotesPer = new Array(n).fill(0);
      const played = new Array(n).fill(0);

      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const g = this.games[i][j];
          if (g > 0) {
            played[i]++;
            totalVotesPer[i] += g;
            totalWinsPer[i] += this.wins[i][j];
            totalLossPer[i] += this.wins[j][i];
          }
        }
      }

      const rows = this.keys.map((key, i) => ({
        key,
        score: totalWinsPer[i],          // TOTAL WINS drives the ranking
        wins: totalWinsPer[i],
        losses: totalLossPer[i],
        played: played[i],
        votesWon: totalWinsPer[i],
        votesTotal: totalVotesPer[i],
        winRate: totalVotesPer[i] ? totalWinsPer[i] / totalVotesPer[i] : 0,
        _i: i,
      }));

      // Highest win count first. Ties stay adjacent; stable secondary by key so
      // the order is deterministic. Equal scores get the SAME rank number.
      rows.sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));

      for (let p = 0; p < rows.length; p++) {
        if (p === 0) { rows[p].rank = 1; continue; }
        const prev = rows[p - 1], cur = rows[p];
        cur.rank = (cur.score === prev.score) ? prev.rank : p + 1;
      }
      const countByRank = {};
      for (const row of rows) countByRank[row.rank] = (countByRank[row.rank] || 0) + 1;
      for (const row of rows) { row.tied = countByRank[row.rank] > 1; delete row._i; }

      return rows;
    }

    /* ---- explain ------------------------------------------------------- *
     * Per-item head-to-head record behind the rank. In ranked order:
     *   { key, rank, tied, score, votesWon, votesTotal,
     *     matchups: [ { opp, oppRank, wins, loss, games } ] }
     * The matchups' wins sum to votesWon (the rank-setting total), so the
     * results table can show the full record adding up to the score.
     * -------------------------------------------------------------------- */
    explain() {
      const n = this.n;
      const rk = this.ranking();
      const rankOf = new Map(rk.map(r => [r.key, r.rank]));

      return rk.map(row => {
        const i = this.idx.get(row.key);
        const matchups = [];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const g = this.games[i][j];
          if (!g) continue;                       // never compared → nothing to show
          matchups.push({
            opp: this.keys[j], oppRank: rankOf.get(this.keys[j]),
            wins: this.wins[i][j], loss: this.wins[j][i], games: g,
          });
        }
        // most-won matchups first
        matchups.sort((a, b) => (b.wins - a.wins) || (a.loss - b.loss));
        return {
          key: row.key, rank: row.rank, tied: row.tied,
          score: row.score, votesWon: row.votesWon, votesTotal: row.votesTotal,
          matchups,
        };
      });
    }

    /* ---- round-robin bookkeeping --------------------------------------- *
     * A "round" is one full pass: every unordered pair played once. Because
     * matchmaking always serves a least-played pair, the fewest games any pair
     * has = rounds fully complete; pairs already past that are into the next round.
     * -------------------------------------------------------------------- */
    _rounds() {
      const n = this.n;
      const total = n * (n - 1) / 2;
      if (total === 0) return { roundsComplete: 0, aheadCount: 0, total: 0, minGames: 0 };
      let minGames = Infinity;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          minGames = Math.min(minGames, this.games[i][j]);
      if (!isFinite(minGames)) minGames = 0;
      let aheadCount = 0;
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          if (this.games[i][j] > minGames) aheadCount++;
      return { roundsComplete: minGames, aheadCount, total, minGames };
    }

    /* ---- status -------------------------------------------------------- *
     * The single object the UI needs:
     *   {
     *     ready,            // true once round 1 is complete (a ranking exists)
     *     roundsComplete,   // full round-robins finished
     *     roundProgress,    // 0..1 through the current (in-progress) round
     *     roundJustDone,    // true exactly when sitting on a round boundary
     *     dots,             // bar dots (≥3, one per round)
     *     fill,             // 0..1 bar fill (rounds + current-round fraction)
     *     votesToRound,     // votes left to finish the current round
     *     currentRound,     // 1-based round number in progress
     *     tier,             // confidence label, follows roundsComplete
     *     ties,             // [{ rank, keys:[...] }] groups sharing a rank (size>1)
     *     hasTies,          // any rank shared by 2+ items
     *   }
     * -------------------------------------------------------------------- */
    status() {
      const n = this.n;
      if (n < 2) {
        return { ready: true, roundsComplete: 1, roundProgress: 0, roundJustDone: true,
                 dots: 3, fill: 1, votesToRound: 0, currentRound: 1, tier: "rock-solid",
                 ties: [], hasTies: false };
      }

      const { roundsComplete, aheadCount, total } = this._rounds();
      const roundProgress = total ? aheadCount / total : 0;
      const ready = roundsComplete >= 1;
      // a round boundary: at least one round done AND no pair has started the next
      const roundJustDone = roundsComplete >= 1 && aheadCount === 0;

      const roundsStarted = roundsComplete + (aheadCount > 0 ? 1 : 0);
      const dots = Math.max(3, roundsStarted);
      const fill = dots > 0 ? Math.min(1, (roundsComplete + roundProgress) / dots) : 0;
      const votesToRound = total - aheadCount;   // votes to finish the current round

      // confidence tier — follows rounds completed, monotonic, never bounces.
      let tier;
      if (roundsComplete < 1) tier = "building";
      else if (roundsComplete >= 4) tier = "rock-solid";
      else if (roundsComplete >= 3) tier = "very-confident";
      else if (roundsComplete >= 2) tier = "confident";
      else tier = "pretty-sure";

      // ties: groups of items sharing a rank (only meaningful once ready)
      const ties = [];
      if (ready) {
        const rows = this.ranking();
        const byRank = new Map();
        for (const r of rows) {
          if (!byRank.has(r.rank)) byRank.set(r.rank, []);
          byRank.get(r.rank).push(r.key);
        }
        for (const [rank, keys] of byRank) if (keys.length > 1) ties.push({ rank, keys });
        ties.sort((a, b) => a.rank - b.rank);
      }

      return {
        ready, roundsComplete, roundProgress, roundJustDone,
        dots, fill, votesToRound, currentRound: roundsComplete + 1, tier,
        ties, hasTies: ties.length > 0,
      };
    }

    // Back-compat: the UI's bar reads a single 0..1 number.
    precision() { return this.status().fill; }

    /* ---- next matchup -------------------------------------------------- *
     * Pure round-robin: always serve a pair from the LEAST-played tier, so no
     * pair gets its (k+1)th meeting until every pair has had its kth. This
     * guarantees full, equal round-robin coverage — the precondition for ranking
     * by win count.
     *
     * Among the equally-least-played candidates, SOFT-NUDGE away from reusing a
     * track from the pair we just served — back-to-back repeats of the same sample
     * feel monotonous. We prefer candidates that share NO track with the last pair;
     * if none exist (common near the end of a round, when few pairs remain), we
     * fall back to the full least-played set rather than break the round-robin.
     * Returns [keyA, keyB] with randomized side order.
     * -------------------------------------------------------------------- */
    nextPair() {
      if (this.n < 2) return null;
      let minGames = Infinity;
      for (let i = 0; i < this.n; i++)
        for (let j = i + 1; j < this.n; j++)
          minGames = Math.min(minGames, this.games[i][j]);

      const candidates = [];
      for (let i = 0; i < this.n; i++)
        for (let j = i + 1; j < this.n; j++)
          if (this.games[i][j] <= minGames) candidates.push([i, j]);

      // Soft nudge: among the least-played, prefer pairs that don't reuse either
      // track from the previous matchup. Only applies the filter if it leaves at
      // least one candidate — otherwise we keep the full set (round-robin wins).
      let pool = candidates;
      if (this._lastPair) {
        const [pa, pb] = this._lastPair;
        const fresh = candidates.filter(([i, j]) => i !== pa && i !== pb && j !== pa && j !== pb);
        if (fresh.length) pool = fresh;
      }

      const pick = pool[Math.floor(this.rng() * pool.length)] || pool[0];
      this._lastPair = [pick[0], pick[1]];
      const ka = this.keys[pick[0]], kb = this.keys[pick[1]];
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
    function makeRng(seed) {
      let s = seed >>> 0;
      return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
    }
    function voteN(core, w, l, count) { for (let k = 0; k < count; k++) core.vote(w, l, w); }
    // play one full round-robin, the given winner of each pair winning once
    function playRound(core, winnerOf) {
      for (let i = 0; i < core.keys.length; i++)
        for (let j = i + 1; j < core.keys.length; j++) {
          const a = core.keys[i], b = core.keys[j];
          const w = winnerOf(a, b);
          core.vote(a, b, w);
        }
    }

    // ---- 1. Construction sane with zero votes ----------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      ok(c.n === 3, "n reflects key count");
      const rk = c.ranking();
      ok(rk.length === 3, "ranking has all items");
      ok(rk.every(r => r.score === 0), "zero votes → all scores 0");
      ok(rk.every(r => r.tied), "zero votes → everyone tied");
      ok(!c.status().ready, "not ready before any round completes");
    })();

    // ---- 2. Score == total wins -----------------------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      voteN(c, "A", "B", 5);   // A beats B 5x
      voteN(c, "A", "C", 3);   // A beats C 3x
      voteN(c, "B", "C", 2);   // B beats C 2x
      const rk = c.ranking();
      const byKey = Object.fromEntries(rk.map(r => [r.key, r]));
      ok(byKey.A.score === 8, "A total wins = 5+3 = 8");
      ok(byKey.B.score === 2, "B total wins = 2");
      ok(byKey.C.score === 0, "C total wins = 0");
      ok(rk[0].key === "A" && rk[1].key === "B" && rk[2].key === "C", "ranked by total wins");
    })();

    // ---- 3. Win count == winRate order (equal games) --------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"]);
      // one full round-robin, clean ladder A>B>C>D
      playRound(c, (a, b) => a < b ? a : b);  // earlier letter wins
      const rk = c.ranking();
      ok(rk.map(r => r.key).join("") === "ABCD", "clean ladder ranks A>B>C>D");
      // winRate must be monotonically non-increasing down the ranking
      let mono = true;
      for (let i = 1; i < rk.length; i++) if (rk[i].winRate > rk[i - 1].winRate + 1e-9) mono = false;
      ok(mono, "winRate non-increasing down the ranking (== win-count order)");
    })();

    // ---- 4. Ties: equal win counts share a rank -------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      // make A and B both beat C equally and split with each other
      voteN(c, "A", "C", 3);
      voteN(c, "B", "C", 3);
      voteN(c, "A", "B", 2); voteN(c, "B", "A", 2);   // 2-2 between A,B
      const rk = c.ranking();
      const byKey = Object.fromEntries(rk.map(r => [r.key, r]));
      ok(byKey.A.score === byKey.B.score, "A and B have equal win counts");
      ok(byKey.A.rank === byKey.B.rank, "equal win counts → shared rank");
      ok(byKey.A.tied && byKey.B.tied, "tied flag set on shared rank");
      ok(byKey.C.rank > byKey.A.rank && !byKey.C.tied, "C ranks below, not tied");
    })();

    // ---- 5. status.ready follows round completion -----------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      ok(!c.status().ready, "0 votes: not ready");
      c.vote("A", "B", "A");
      ok(!c.status().ready, "partial round: not ready");
      c.vote("A", "C", "A");
      ok(!c.status().ready, "still partial: not ready");
      c.vote("B", "C", "B");
      ok(c.status().ready, "full round complete: ready");
      ok(c.status().roundsComplete === 1, "roundsComplete = 1 after one pass");
      ok(c.status().roundJustDone, "roundJustDone true on the boundary");
    })();

    // ---- 6. roundJustDone only on the boundary --------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      playRound(c, (a, b) => a < b ? a : b);   // one full, valid round
      ok(c.status().roundJustDone, "boundary after first full round");
      c.vote("A", "B", "A");             // start round 2
      ok(!c.status().roundJustDone, "mid next round: not on boundary");
      ok(c.status().roundsComplete === 1, "still 1 round complete mid round 2");
    })();

    // ---- 7. nextPair enforces full round-robin --------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"], { rng: makeRng(42) });
      const total = 6;
      // first `total` distinct pairs should cover every pair exactly once
      const seen = new Set();
      for (let t = 0; t < total; t++) {
        const [x, y] = c.nextPair();
        seen.add([x, y].sort().join("|"));
        c.vote(x, y, x);
      }
      ok(seen.size === total, "first round serves every pair exactly once (no repeats)");
      ok(c.status().roundsComplete === 1, "exactly one round complete after C(n,2) votes");
    })();

    // ---- 8. nextPair valid, distinct, known keys ------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D", "E"], { rng: makeRng(7) });
      for (let t = 0; t < 50; t++) {
        const p = c.nextPair();
        ok(Array.isArray(p) && p.length === 2 && p[0] !== p[1], "nextPair returns a distinct pair");
        ok(c.idx.has(p[0]) && c.idx.has(p[1]), "nextPair items are known keys");
        c.vote(p[0], p[1], p[0]);
      }
    })();

    // ---- 8b. soft no-repeat nudge avoids back-to-back same track --------
    (function () {
      // With 5+ tracks there's always a disjoint least-played pair available, so
      // consecutive matchups should never share a track.
      const c = new PreferenceCore(["A", "B", "C", "D", "E"], { rng: makeRng(123) });
      let repeats = 0, prev = null;
      for (let t = 0; t < 40; t++) {
        const p = c.nextPair().slice().sort();
        if (prev && (prev.includes(p[0]) || prev.includes(p[1]))) repeats++;
        prev = p;
        c.vote(p[0], p[1], p[0]);
      }
      ok(repeats === 0, "5 tracks: no consecutive matchup reuses a track");

      // With exactly 3 tracks, every pair shares a track with the previous one,
      // so the nudge MUST fall back gracefully (still serve, still round-robin).
      const c3 = new PreferenceCore(["A", "B", "C"], { rng: makeRng(5) });
      const seen = new Set();
      for (let t = 0; t < 3; t++) { const [x, y] = c3.nextPair(); seen.add([x, y].sort().join("|")); c3.vote(x, y, x); }
      ok(seen.size === 3, "3 tracks: nudge falls back, round-robin still covers all pairs");
    })();

    // ---- 9. bar fill is monotonic within a fixed dot count --------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"], { rng: makeRng(99) });
      let prev = -1, prevDots = -1, mono = true;
      for (let t = 0; t < 6; t++) {     // one full round (dots stay at 3)
        const [x, y] = c.nextPair(); c.vote(x, y, x);
        const s = c.status();
        if (s.dots === prevDots && s.fill < prev - 1e-9) mono = false;
        prev = s.fill; prevDots = s.dots;
      }
      ok(mono, "bar fill never decreases within a fixed dot count");
    })();

    // ---- 10. tier follows rounds completed ------------------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      ok(c.status().tier === "building", "0 rounds → building");
      playRound(c, (a, b) => a < b ? a : b);
      ok(c.status().tier === "pretty-sure", "1 round → pretty-sure");
      playRound(c, (a, b) => a < b ? a : b);
      ok(c.status().tier === "confident", "2 rounds → confident");
      playRound(c, (a, b) => a < b ? a : b);
      ok(c.status().tier === "very-confident", "3 rounds → very-confident");
      playRound(c, (a, b) => a < b ? a : b);
      ok(c.status().tier === "rock-solid", "4 rounds → rock-solid");
    })();

    // ---- 11. status.ties reports shared-rank groups ---------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"]);
      // one full round, but engineer a 2-way tie for 2nd:
      // A wins everything; B and C each beat D and split nothing else cleanly.
      c.vote("A", "B", "A");
      c.vote("A", "C", "A");
      c.vote("A", "D", "A");
      c.vote("B", "C", "B");   // B beats C
      c.vote("B", "D", "D");   // D beats B  -> B:1 win, D:1 win
      c.vote("C", "D", "C");   // C beats D  -> C:1 win
      const s = c.status();
      ok(s.ready, "ready after full round");
      // wins: A=3, B=1, C=1, D=1  -> B,C,D tie for 2nd
      const tie = s.ties.find(t => t.keys.length === 3);
      ok(!!tie, "detects the 3-way tie");
      ok(s.hasTies, "hasTies true when a tie exists");
    })();

    // ---- 12. explain matchup wins sum to the score ----------------------
    (function () {
      const c = new PreferenceCore(["A", "B", "C"]);
      voteN(c, "A", "B", 4);
      voteN(c, "A", "C", 2);
      voteN(c, "C", "B", 3);
      const ex = c.explain();
      for (const e of ex) {
        const sum = e.matchups.reduce((s, m) => s + m.wins, 0);
        ok(sum === e.score, `explain wins sum to score for ${e.key} (${sum} == ${e.score})`);
      }
    })();

    // ---- 13. replay reconstructs the same grid --------------------------
    (function () {
      const log = [
        { a: "A", b: "B", winner: "A" },
        { a: "A", b: "C", winner: "C" },
        { a: "B", b: "C", winner: "B" },
        { a: "A", b: "B", winner: "A" },
      ];
      const c = new PreferenceCore(["A", "B", "C"]);
      c.replay(log);
      const byKey = Object.fromEntries(c.ranking().map(r => [r.key, r]));
      ok(byKey.A.score === 2, "replay: A won twice");
      ok(byKey.B.score === 1, "replay: B won once");
      ok(byKey.C.score === 1, "replay: C won once");
      ok(c.voteCount === 4, "replay counts all votes");
    })();

    // ---- 14. winProb smoothed ------------------------------------------
    (function () {
      const c = new PreferenceCore(["A", "B"]);
      ok(Math.abs(c.winProb("A", "B") - 0.5) < 1e-9, "unseen pair → 0.5");
      voteN(c, "A", "B", 3);
      ok(c.winProb("A", "B") > 0.5, "after A wins, P(A>B) > 0.5");
    })();

    // ---- summary --------------------------------------------------------
    const total = passed + failed;
    console.log("preference-rating.js test suite");
    console.log(`  ${passed}/${total} assertions passed`);
    if (failed) { console.log("  FAILURES:"); for (const f of fails) console.log("   ✗ " + f); }
    else console.log("  ✓ all green");
    return failed === 0;
  }

  return { PreferenceCore, runTests };
});
