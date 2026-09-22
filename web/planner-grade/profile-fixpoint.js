// Solving a track's vertical profile CHANGES the inputs its own freshness hash
// is computed from, so a single-shot solve writes a profile that is already
// stale. This runs the solve to a fixpoint instead — bounded, and loud when it
// will not settle.
//
// The feedback loop, concretely: currentTrackProfileHash() hashes each station's
// profile span, whose half-span comes from getStationStructureKind(), which
// reads track.verticalProfile to decide whether the platform is on a viaduct, in
// a tunnel or at grade. That profile is the solve's OUTPUT. So stamping it moves
// the hash the stamp was just compared against, and trackHasFreshAslProfile() is
// false for the rest of the session — for a profile that solved perfectly.
//
// What that cost, before this existed: the Split ride's 575-regime profile was
// never "fresh", so lineHasFullAslCoverage() was false, so the planner cab chose
// FLAT-world track props inside a world that had real terrain. RailFormation
// then draped the trackbed over the ground while planner-elevation raised the
// structures by the authored level, and the ride passed underneath a viaduct
// built from its own alignment.
//
// Kept pure and dependency-free (callbacks in, verdict out) so the settling rule
// can be tested headlessly, away from the planner's DOM and network.
(function (root) {
    'use strict';

    // Station structure kinds are discrete (viaduct / tunnel / at grade), so a
    // profile that is going to settle settles in one or two extra rounds. More
    // than a handful of rounds means the inputs are oscillating, not converging.
    const DEFAULT_MAX_ROUNDS = 4;

    // hashNow()      → the freshness hash as it stands right now
    // solveOnce(hash)→ solve and stamp the result with `hash`; false = refused
    //
    // Returns { converged, reason, rounds, hash, history }. `hash` is always the
    // hash the caller should end up stamped with, converged or not: a profile
    // marked with a hash nothing will ever ask for is indistinguishable from one
    // that failed to solve, and that ambiguity is the whole bug above.
    function solveToStableHash(options) {
        const { hashNow, solveOnce, maxRounds = DEFAULT_MAX_ROUNDS } = options || {};
        if (typeof hashNow !== 'function' || typeof solveOnce !== 'function') {
            throw new TypeError('solveToStableHash needs hashNow() and solveOnce(hash)');
        }
        const limit = Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS);
        const history = [];
        const seen = new Set();
        let hash = hashNow();

        for (let round = 1; round <= limit; round += 1) {
            history.push(hash);
            seen.add(hash);
            if (solveOnce(hash) === false) {
                return { converged: false, reason: 'refused', rounds: round, hash, history };
            }
            const next = hashNow();
            if (next === hash) {
                return { converged: true, reason: 'stable', rounds: round, hash, history };
            }
            // A hash we have already solved against means the inputs are cycling
            // between two shapes (a station flipping viaduct/tunnel each round).
            // More rounds cannot help, and the extra solves are not free.
            if (seen.has(next)) {
                return {
                    converged: false,
                    reason: 'cycle',
                    rounds: round,
                    hash: next,
                    history: history.concat(next),
                };
            }
            hash = next;
        }
        return { converged: false, reason: 'exhausted', rounds: limit, hash, history };
    }

    const api = { solveToStableHash, DEFAULT_MAX_ROUNDS };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__profileFixpoint = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
