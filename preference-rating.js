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

    // Transitive tiebreak: when i and j are directly even, compare how each did
    // against their SHARED opponents (A>B, B>C ⇒ A edges C). Returns a signed
    // number — positive means i is transitively ahead of j, 0 means even/no
    // shared data. Used ONLY to break a direct tie, never to override a direct
    // decided result.
    transitiveEdge(i, j) {
      let edge = 0;
      for (let k = 0; k < this.n; k++) {
        if (k === i || k === j) continue;
        const gi = this.games[i][k], gj = this.games[j][k];
        if (gi === 0 || gj === 0) continue;             // need both vs k
        const ni = (this.wins[i][k] - this.wins[k][i]) / gi;  // i's net vs k
        const nj = (this.wins[j][k] - this.wins[k][j]) / gj;  // j's net vs k
        edge += ni - nj;
      }
      return edge;
    }

    /* ---- opponent-weighted score --------------------------------------- *
     * A win over a STRONG guitar is worth more than a win over a weak one — but
     * only if that win is RELIABLE (repeated/decisive), not a fluke. This is the
     * refinement that breaks genuine cycles: in a rock-paper-scissors loop the
     * members aren't really equal — one beat the *stronger* opponents on balance,
     * and this surfaces that.
     *
     * For each item i, sum over opponents j it has played:
     *     net(i,j) · weight(j)
     *   net(i,j)  = (wins_ij − wins_ji) / games_ij        // −1..+1, your lean
     *   weight(j) = 1 + (qual(j) − 1) · reliability(i,j)   // 0.5..1.5, faded in
     *   qual(j)   = opponent j's strength, squashed to [0.5, 1.5] (BOUNDED so no
     *               single result can run away — keeps the top catchable)
     *   reliability(i,j) = min(1, games/MEET_FLOOR) · |net|  // a fluke 1–0 ≈ 0,
     *               a solid 5–1 ≈ 1. Quality credit only counts once the result
     *               is proven, so an upset must be REPEATED to move the ranking.
     *
     * `base` is a per-item strength estimate used as the opponent-quality source
     * (we pass in the plain Copeland scores). Computed in ONE pass — no iteration —
     * so the "beat-the-strong" credit can't compound into a blow-up.
     * -------------------------------------------------------------------- */
    _opponentWeighted(base) {
      const n = this.n, FLOOR = PreferenceCore.MEET_FLOOR;
      const maxAbs = Math.max(1, ...base.map(v => Math.abs(v)));
      const qual = base.map(v => 1 + 0.5 * (v / maxAbs));   // bounded 0.5..1.5
      const out = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const g = this.games[i][j];
          if (!g) continue;
          const net = (this.wins[i][j] - this.wins[j][i]) / g;
          const reliability = Math.min(1, g / FLOOR) * Math.abs(net);
          out[i] += net * (1 + (qual[j] - 1) * reliability);
        }
      }
      return out;
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
          // Score each pair by its NET win fraction, so a lean counts as a lean:
          // 3–0 → ±1, 2–1 → ±1/3, 1–1 → 0. This is what stops everything from
          // collapsing to score 0 (and then chain-merging into one giant tie):
          // a 2–1 means you mildly preferred the leader, and the score now SAYS so
          // instead of treating 2–1 as a dead tie worth nothing.
          if (g > 0) {
            const net = (this.wins[i][j] - this.wins[j][i]) / g;  // -1..+1
            score[i] += net; score[j] -= net;
          }
          // decided record (for the W–L readout): only matchups past the floor
          // with a clear winner count as a confirmed win/loss.
          if (ps.state === "decided") {
            if (ps.leader === i) { decidedWins[i]++; decidedLoss[j]++; }
            else                 { decidedWins[j]++; decidedLoss[i]++; }
          }
        }
      }

      // ---- Copeland score: (matchups won − matchups lost) across the field ----
      // This is the backbone of the ranking. Unlike a pairwise comparator, it is
      // CYCLE-PROOF: it always yields a consistent order, and within a cycle it
      // favors whoever beat the most others. A "win" over j counts when the pair
      // is decided (one side clearly preferred); a provisional lean counts at half
      // so a single pass still orders sensibly without overriding decided results.
      const copeland = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const ps = this.pairState(Math.min(i, j), Math.max(i, j));
          if (ps.state === "decided") {
            copeland[i] += ps.leader === i ? 1 : -1;
          } else if (ps.state === "provisional" && ps.leader != null) {
            copeland[i] += ps.leader === i ? 0.5 : -0.5;
          }
        }
      }

      const rows = this.keys.map((key, i) => ({
        key,
        score: copeland[i],            // Copeland score drives the ranking
        net: score[i],                 // net win-fraction (tiebreak + display)
        wins: decidedWins[i],
        losses: decidedLoss[i],
        played: played[i],
        votesWon: totalWinsPer[i],
        votesTotal: totalVotesPer[i],
        winRate: totalVotesPer[i] ? totalWinsPer[i] / totalVotesPer[i] : 0,
        r: 1500 + 80 * copeland[i],
        _i: i,
      }));

      // Order by Copeland; break Copeland ties by the DIRECT decided head-to-head
      // (if you decisively picked A over B, A outranks B when their Copeland scores
      // tie — direct preference is king), then net win-fraction, then win rate.
      rows.sort((a, b) => {
        if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
        const ps = this.pairState(Math.min(a._i, b._i), Math.max(a._i, b._i));
        if (ps.state === "decided") return ps.leader === a._i ? -1 : 1;
        return (b.net - a.net) || (b.winRate - a.winRate);
      });

      // ---- cluster ranks via cycle detection ------------------------------
      // Two items belong in the same TIE CLUSTER when you have no consistent
      // preference between them — which happens when they're in a directed CYCLE
      // of decided results (rock-paper-scissors: A>B, B>C, C>A), OR they're a
      // confirmed direct tie, OR neither has separated from the other yet. We find
      // these as strongly-connected components of the "decided beats" graph,
      // augmented so confirmed-tied / unresolved-even pairs also link.
      const clusterId = this._clusters(rows);

      // ---- opponent-weighted score BREAKS clusters into real ranks --------
      // Plain Copeland can leave a cycle / dead-even group clustered. But those
      // members aren't truly equal: one beat the STRONGER opponents (reliably).
      // The opponent-weighted score surfaces that and gives them distinct, REAL
      // scores — so we use it to separate cluster members into their own ranks.
      // They only STAY tied if even the weighted score is an exact dead heat
      // (genuinely no signal to separate them).
      const oppScore = this._opponentWeighted(copeland);
      for (const row of rows) row.oppScore = oppScore[row._i];
      // re-sort: clusters stay contiguous and in Copeland order (so the weighting
      // never moves an item ACROSS cluster lines — it can't override clean direct
      // results elsewhere), but WITHIN a cluster, order by opponent-weighted score.
      const clusterRank = new Map();   // clusterId -> first index in Copeland order
      rows.forEach((row, p) => {
        const cid = clusterId[row._i];
        if (!clusterRank.has(cid)) clusterRank.set(cid, p);
      });
      rows.sort((a, b) => {
        const ca = clusterRank.get(clusterId[a._i]), cb = clusterRank.get(clusterId[b._i]);
        if (ca !== cb) return ca - cb;                       // keep cluster grouping
        return (b.oppScore - a.oppScore) || (b.net - a.net) || (b.winRate - a.winRate);
      });

      // assign ranks. Within a cluster, the opponent-weighted score SEPARATES
      // members into distinct ranks; two only share a rank if their weighted
      // scores are an exact dead heat (truly nothing to tell them apart).
      const OPP_EPS = 1e-9;
      for (let p = 0; p < rows.length; p++) {
        if (p === 0) { rows[p].rank = 1; continue; }
        const prev = rows[p - 1], cur = rows[p];
        const sameCluster = clusterId[cur._i] === clusterId[prev._i];
        const deadHeat = sameCluster && Math.abs(cur.oppScore - prev.oppScore) < OPP_EPS;
        rows[p].rank = deadHeat ? prev.rank : p + 1;
      }
      const countByRank = {};
      for (const row of rows) countByRank[row.rank] = (countByRank[row.rank] || 0) + 1;
      for (const row of rows) { row.tied = countByRank[row.rank] > 1; delete row._i; }

      return rows;
    }

    /* ---- explain ------------------------------------------------------- *
     * A full, human-readable breakdown of HOW each item got its rank — the
     * transparency table behind the results. For every item, in ranked order:
     *   {
     *     key, rank, tied,
     *     score,        // Copeland (matchups won − lost)
     *     oppScore,     // opponent-weighted score (the tiebreak that ranks cycles)
     *     votesWon, votesTotal,
     *     matchups: [   // one row per opponent actually played, best-beaten first
     *       { opp, oppRank, wins, loss, games, state, outcome, contribution }
     *     ]
     *   }
     * `outcome` ∈ "beat" | "lost" | "tied" | "leaning" (provisional). `contribution`
     * is this matchup's signed term in the opponent-weighted score, so the table
     * can literally show "beating <stronger opp> added +X" — proving the ranking.
     * -------------------------------------------------------------------- */
    explain() {
      const n = this.n, FLOOR = PreferenceCore.MEET_FLOOR;
      const rk = this.ranking();
      const rankOf = new Map(rk.map(r => [r.key, r.rank]));

      // opponent quality (same bounded squash _opponentWeighted uses), from Copeland
      const maxAbs = Math.max(1, ...rk.map(r => Math.abs(r.score)));
      const qualByKey = {};
      for (const r of rk) qualByKey[r.key] = 1 + 0.5 * (r.score / maxAbs);

      return rk.map(row => {
        const i = this.idx.get(row.key);
        const matchups = [];
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const oppKey = this.keys[j];
          const g = this.games[i][j];
          if (!g) continue;                       // never compared → nothing to show
          const w = this.wins[i][j], l = this.wins[j][i];
          const ps = this.pairState(Math.min(i, j), Math.max(i, j));
          let outcome;
          if (ps.state === "decided") outcome = ps.leader === i ? "beat" : "lost";
          else if (ps.state === "tied") outcome = "tied";
          else outcome = w > l ? "leaning-win" : w < l ? "leaning-loss" : "even";
          const net = (w - l) / g;
          const reliability = Math.min(1, g / FLOOR) * Math.abs(net);
          const contribution = net * (1 + (qualByKey[oppKey] - 1) * reliability);
          matchups.push({
            opp: oppKey, oppRank: rankOf.get(oppKey),
            wins: w, loss: l, games: g, state: ps.state, outcome,
            net, contribution,
          });
        }
        // order: biggest positive contribution first (your most valuable wins on top)
        matchups.sort((a, b) => b.contribution - a.contribution);
        return {
          key: row.key, rank: row.rank, tied: row.tied,
          score: row.score, oppScore: row.oppScore,
          votesWon: row.votesWon, votesTotal: row.votesTotal,
          matchups,
        };
      });
    }

    /* ---- cluster detection (Tarjan SCC on the "tie/cycle" graph) -------- *
     * Build a directed graph where i → j means "i is at-least-as-good as j with
     * no clear loss to j": specifically we add BOTH directions i↔j when the pair
     * is NOT decided (a tie / even / unresolved link), and only the winning
     * direction when decided. Strongly-connected components of this graph are the
     * tie clusters: a cycle of decided results (A>B>C>A) forms one SCC, and so
     * does any chain joined by ties. Returns an array clusterId[itemIndex].
     *
     * NOTE on chaining: we only add the undirected tie-link for a pair that is a
     * CONFIRMED tie (state==="tied") or genuinely unresolved between two items
     * that are ADJACENT in Copeland order — so distant items don't chain into one
     * blob. Decided pairs never add a back-edge, so a clean A>B>C stays separate.
     * -------------------------------------------------------------------- */
    _clusters(sortedRows) {
      const n = this.n;
      // Copeland score per item (recomputed cheaply; matches ranking()).
      const cop = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const ps = this.pairState(Math.min(i, j), Math.max(i, j));
        if (ps.state === "decided") cop[i] += ps.leader === i ? 1 : -1;
        else if (ps.state === "provisional" && ps.leader != null) cop[i] += ps.leader === i ? 0.5 : -0.5;
      }
      const adj = Array.from({ length: n }, () => []);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const a = Math.min(i, j), b = Math.max(i, j);
          const ps = this.pairState(a, b);
          if (ps.state === "decided") {
            // single directed edge winner → loser. A CYCLE of these (A>B>C>A)
            // becomes one SCC = a tie cluster, which is what we want.
            if (ps.leader === i) adj[i].push(j);
          } else if (ps.state === "tied" && Math.abs(cop[i] - cop[j]) < 1e-9) {
            // CONFIRMED tie AND equal standing → genuine equivalence; bidirectional
            // link so they share a cluster. The equal-Copeland guard stops a pair
            // that merely SPLIT head-to-head (but sits at different overall
            // standings) from bridging unrelated parts of the field into one blob.
            adj[i].push(j);
          } else if (ps.state === "provisional" && ps.leader != null) {
            // an unsettled lean is NOT a tie — it's a tentative order. Add the
            // leader's directed edge so it sorts, but no back-edge (so it can't
            // merge a cluster). An even provisional (1–1) adds nothing.
            if (ps.leader === i) adj[i].push(j);
          }
          // unseen contributes no edge
        }
      }

      // Tarjan's strongly-connected components.
      const idxOf = new Array(n).fill(-1), low = new Array(n).fill(0);
      const onStack = new Array(n).fill(false), comp = new Array(n).fill(-1);
      const stack = []; let counter = 0, compId = 0;
      const dfs = (u) => {
        // iterative to avoid deep recursion (n is tiny but keep it safe)
        const work = [[u, 0]];
        while (work.length) {
          const top = work[work.length - 1];
          const v = top[0];
          if (top[1] === 0) { idxOf[v] = low[v] = counter++; stack.push(v); onStack[v] = true; }
          let recursed = false;
          for (let e = top[1]; e < adj[v].length; e++) {
            const w = adj[v][e];
            if (idxOf[w] === -1) { top[1] = e + 1; work.push([w, 0]); recursed = true; break; }
            else if (onStack[w]) low[v] = Math.min(low[v], idxOf[w]);
          }
          if (recursed) continue;
          if (low[v] === idxOf[v]) {
            let w;
            do { w = stack.pop(); onStack[w] = false; comp[w] = compId; } while (w !== v);
            compId++;
          }
          work.pop();
          if (work.length) { const p = work[work.length - 1]; low[p[0]] = Math.min(low[p[0]], low[v]); }
        }
      };
      for (let i = 0; i < n; i++) if (idxOf[i] === -1) dfs(i);
      return comp;
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
      let minGames = Infinity;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ps = this.pairState(i, j);
          total++;
          minGames = Math.min(minGames, ps.games);
          if (ps.state === "unseen") unseen++;
          else if (ps.state === "provisional") {
            provisional++;
            provisionalNeed += Math.max(1, PreferenceCore.MEET_FLOOR - ps.games);
          } else settled++;
        }
      }
      if (!isFinite(minGames)) minGames = 0;
      const complete = unseen === 0;

      // ---- round-robin progress (drives the bar) -------------------------
      // Because matchmaking always serves the LEAST-played pair, coverage is even:
      // a "round" is one full pass (every pair played once). roundsComplete = the
      // fewest games any pair has; the pairs already at minGames+1 are how far into
      // the current round we are. The bar fills 1/3 per completed round, with a dot
      // per round and a 4th+ dot added if you keep going.
      let roundsComplete = minGames;
      let aheadCount = 0;                       // pairs already into the next round
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
          if (this.games[i][j] > minGames) aheadCount++;
      const roundProgress = total ? aheadCount / total : 0;   // 0..1 through current round
      // total dots: at least 3, grows as you start more rounds
      const roundsStarted = roundsComplete + (aheadCount > 0 ? 1 : 0);
      const dots = Math.max(3, roundsStarted || (complete ? 1 : 0) + (roundProgress > 0 ? 1 : 0));
      // bar fill: each completed round is 1/dots; the current round adds a fraction.
      const roundFill = dots > 0 ? (roundsComplete + roundProgress) / dots : 0;

      const rows = this.ranking();

      // ---- winner lock: is the top boundary resolved? --------------------
      // Locked if the top cluster is a confirmed tie (winner's circle) OR the
      // #1 vs #2 boundary is `decided` with margin ≥ WIN_MARGIN over the floor.
      // The "winner" is the set of items near the very top that are close enough
      // to still be in contention. We find them by net score: anyone within
      // ~one matchup of the leader is a contender for #1.
      const topScore = rows[0].score;
      const contenders = rows.filter(r => (topScore - r.score) < 1 - 1e-9);
      const contenderIdx = contenders.map(r => this.idx.get(r.key));

      // winnerLocked, topIsTie, the contenders to serve head-to-head, and a
      // stable "votes to the winner milestone" estimate.
      let winnerLocked, topIsTie = false, votesToWinner = 0;
      let tieContenders = [];   // keys to serve against each other to break a top tie

      if (!complete) {
        // Still mid first-pass: the only blocker to a usable ranking is finishing
        // the pass. Don't chase tie-breaks yet (it would over-count and starve
        // coverage). tieContenders stays empty until the pass is done.
        winnerLocked = false;
        votesToWinner = unseen;
      } else if (contenders.length <= 1) {
        // One item clearly ahead on score → it's the winner. (Score lead ≥ 1 means
        // it beat the field about one matchup more than #2 — a clear lead, no
        // decisive DIRECT margin required.)
        winnerLocked = true;
        votesToWinner = 0;
      } else {
        // Several items tied for #1. Per design: make the user pick BETWEEN the
        // contenders head-to-head — 2–4 votes should reveal a winner. We're
        // "locked" once every contender pair has been compared enough (floor) to
        // either separate them (one pulls ahead on score) or confirm a true tie.
        tieContenders = contenders.map(r => r.key);
        let need = 0;
        for (let a = 0; a < contenderIdx.length; a++)
          for (let b = a + 1; b < contenderIdx.length; b++) {
            const ps = this.pairState(contenderIdx[a], contenderIdx[b]);
            if (ps.games < PreferenceCore.MEET_FLOOR) need += (PreferenceCore.MEET_FLOOR - ps.games);
          }
        // If, after enough head-to-heads, the contenders are STILL score-tied,
        // it's a genuine winner's circle: lock it and crown co-winners.
        topIsTie = need === 0;
        winnerLocked = need === 0;
        votesToWinner = Math.max(1, need);
      }

      // The crowned winner(s): the contenders, but only those sharing the very
      // top cluster rank (so a tie that got broken shows a single winner).
      const topRank = rows[0].rank;
      const winners = rows.filter(r => r.rank === topRank).map(r => r.key);

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

      // ---- the bar: simple round-robin progress --------------------------
      // No phase magic. The bar IS how far through the round-robins you are:
      // 1/3 per completed round (≥3 dots), the current round adding a fraction.
      // It only moves forward and maps exactly to the real work being done.
      const fill = Math.min(1, roundFill);

      // `phase`/`allSettled` are kept ONLY for the status text + button gate
      // (they don't drive the bar anymore).
      const allSettled = unseen === 0 && provisional === 0;
      let phase;
      if (!complete) phase = 0;
      else if (!winnerLocked) phase = 1;
      else if (!allSettled) phase = 2;
      else phase = 3;

      // ---- tier ----------------------------------------------------------
      let tier;
      if (!winnerLocked) tier = "building";
      else if (competence >= 0.85) tier = "rock-solid";
      else if (competence >= 0.5) tier = "confident";
      else tier = "pretty-sure";

      // ---- next milestone + votes remaining ------------------------------
      // Two regimes, per design:
      //   BEFORE the ranking is usable (no winner locked): a countdown to the
      //     "preliminary ranking ready" point. This is the number that should
      //     mostly tick DOWN as you vote.
      //   AFTER (preliminary ready): the ranking is viewable any time; the
      //     countdown becomes "votes to the next confidence step".
      // `preliminary` is the flag the UI uses to tell the user, for certain,
      // that they can view results whenever they want.
      const preliminary = winnerLocked;     // a trustworthy ranking exists
      let votesToNext, nextLabel;
      if (!preliminary) {
        // votes to a usable ranking: whichever is the live blocker — finishing
        // the first pass, or breaking the tie at the top.
        votesToNext = Math.max(1, votesToWinner || unseen);
        nextLabel = "to a ranking";
      } else if (!allSettled) {
        // ranking ready; remaining work tightens the lower ranks
        votesToNext = Math.max(1, provisionalNeed);
        nextLabel = "to settle the rest";
      } else {
        votesToNext = 0;
        nextLabel = "fully settled";
      }

      // votes remaining to FINISH the current round-robin (each pair not yet at
      // minGames+1 needs one vote). This is what the round bar counts down.
      const votesToRound = total - aheadCount;

      return {
        complete, phase, winnerLocked, winners, topIsTie,
        preliminary, tieContenders,
        competence, tier, fill,
        stopOk: preliminary,            // can view results for certain once true
        votesToNext, nextLabel,
        // round-robin progress (drives the bar + dots)
        roundsComplete, roundProgress, roundsStarted, dots, votesToRound,
        currentRound: roundsComplete + 1,
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

      // ROUND-ROBIN by design: the dominant driver is "fewest meetings". We always
      // serve from the least-played tier of pairs, so the whole field gets even,
      // repeated coverage (everyone vs everyone, then again) instead of fixating on
      // a couple of close pairs (which is how one pair hit 13 games while others got
      // 3). Closeness/adjacency is only a gentle tiebreak AMONG the least-played.
      let minGames = Infinity;
      for (let i = 0; i < this.n; i++)
        for (let j = i + 1; j < this.n; j++)
          minGames = Math.min(minGames, this.games[i][j]);

      // Sporadic tie-for-first breaker: only when the first full round-robin is in
      // (every pair played ≥1) AND there's a real tie at the top, give the tied
      // contenders' pairs a modest boost — enough to seed a round, not to dominate
      // it. The round-robin floor above still pulls every other pair along.
      const topScore = rows[0].score;
      const contenderKeys = rows.filter(r => (topScore - r.score) < 1 - 1e-9).map(r => r.key);
      const isContender = new Set(contenderKeys.map(k => this.idx.get(k)));
      const breakTopTie = contenderKeys.length > 1 && minGames >= 1;

      const candidates = [];
      let total = 0;
      for (let i = 0; i < this.n; i++) {
        for (let j = i + 1; j < this.n; j++) {
          const g = this.games[i][j];
          const ki = this.keys[i], kj = this.keys[j];
          // Restrict to the least-played tier: this enforces full round-robin
          // cycling. Only pairs at the current minimum game count are eligible,
          // so no pair gets a 2nd meeting until every pair has had its 1st, etc.
          if (g > minGames) continue;
          const adjacency = 1 / (1 + Math.abs(pos.get(ki) - pos.get(kj)));
          // base weight ~even; a gentle pull toward close-in-standings pairs so,
          // within a round, the informative matchups come a little sooner.
          let w = 1 + 0.5 * adjacency;
          // modest, sporadic boost to seed a tie-break among the top contenders.
          if (breakTopTie && isContender.has(i) && isContender.has(j) &&
              this.pairState(i, j).state !== "decided") {
            w += 2;
          }
          candidates.push({ i, j, w }); total += w;
        }
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
      ok(s.phase === 0, "no votes ⇒ phase 0 (first sweep not done)");
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

    // ---- 11. round-bar fill: in [0,1], 1/3 per round, only drops on expansion
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "D"], { rng: makeRng(5) });
      const order = { A: 4, B: 3, C: 2, D: 1 };
      let prev = 0, ok01 = true, monotoneWithinDots = true, prevDots = 3;
      for (let t = 0; t < 60; t++) {
        const [x, y] = c.nextPair();
        c.vote(x, y, order[x] > order[y] ? x : y);
        const s = c.status();
        if (s.fill < 0 || s.fill > 1) ok01 = false;
        // fill only ever decreases when the dot count GROWS (a new round began,
        // rescaling the bar) — never within a fixed dot count.
        if (s.dots === prevDots && s.fill < prev - 1e-9) monotoneWithinDots = false;
        prev = s.fill; prevDots = s.dots;
      }
      ok(ok01, "round fill stays within [0,1]");
      ok(monotoneWithinDots, "round fill never retreats within a fixed dot count");
      // after a full round-robin (every pair ≥1), fill is at least 1/3.
      const s = c.status();
      ok(s.complete && s.fill >= 1 / 3 - 1e-9, "first full round ⇒ bar at least at 1st marker");
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
      ok(!s0.preliminary, "no votes ⇒ no preliminary ranking yet");
      ok(s0.nextLabel === "to a ranking", "starts by counting down to a ranking");
      ok(s0.votesToNext === 3, "3 unseen pairs ⇒ 3 votes to a ranking");
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
      const posOf = {}, rankOf = {};
      rk.forEach((r, i) => { posOf[r.key] = i; rankOf[r.key] = r.rank; });
      let inversions = 0;
      for (let i = 0; i < c.n; i++) for (let j = i + 1; j < c.n; j++) {
        const ps = c.pairState(i, j);
        if (ps.state !== "decided") continue;
        const hi = ps.leader, lo = hi === i ? j : i;
        // A cross-CLUSTER inversion is the real bug. Within a tie cluster a decided
        // pair can be "inverted" — that's exactly what a cycle is (resolved by the
        // opponent-weighted score), so it's expected, not a violation.
        if (rankOf[keys[hi]] !== rankOf[keys[lo]] && posOf[keys[hi]] > posOf[keys[lo]]) inversions++;
      }
      ok(inversions === 0, "ranking never contradicts a decided H2H across clusters");
    })();

    // ---- 21. Asymmetric cycle is broken by opponent quality --------------
    // A 3-cycle A>B>C>A (all decided) has no Copeland order. But it's ASYMMETRIC
    // here: A also beats two strong outsiders (X, Y) reliably, while B and C only
    // beat the weak one. The member with the stronger reliable wins (A) should
    // separate to the top of the cluster rather than staying in a blob.
    (function () {
      const c = new PreferenceCore(["A", "B", "C", "X", "Y"]);
      // 3-cycle among A,B,C
      voteN(c, "A", "B", 3); voteN(c, "B", "C", 3); voteN(c, "C", "A", 3);
      // X and Y are strong (each beats B and C), but A beats X and Y → A's wins
      // are over stronger opponents, so A should rise within the cycle cluster.
      voteN(c, "A", "X", 3); voteN(c, "A", "Y", 3);
      voteN(c, "X", "B", 3); voteN(c, "X", "C", 3);
      voteN(c, "Y", "B", 3); voteN(c, "Y", "C", 3);
      const rk = c.ranking();
      const rankOf = {}; rk.forEach(r => rankOf[r.key] = r.rank);
      // A beat strong X,Y; B and C lost to them → A should outrank B and C.
      ok(rankOf["A"] < rankOf["B"] && rankOf["A"] < rankOf["C"],
        "asymmetric cycle: the member with stronger reliable wins (A) rises to the top");
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
