// Which train the "U kabinu" keyboard shortcut (K) rides when the user has not
// picked one. The map button always has a train — it hangs off that train's
// popup — but the shortcut fires from anywhere, so it needs a rule.
//
// The rule: honour an explicit selection, otherwise take the first train of the
// first line that HAS one. "First line" alone is not enough — a project's first
// line can be a freshly drawn route with no trains on it yet, and picking that
// would make K look broken on a project where three other lines are running.
//
// Pure and DOM-free so the choosing is unit-testable; the caller does the
// opening.
(function (root) {
    'use strict';

    // selectedObject is the planner's current selection ({type, ref}); pass null
    // when nothing is selected. Returns { train, line, reason } or null when the
    // project has no train anywhere.
    function pickCabTarget(project, selectedObject = null) {
        if (selectedObject && selectedObject.type === 'train') {
            const ref = selectedObject.ref;
            // A selection is only usable if it carries BOTH halves: openPlannerTrainCab
            // needs the line to resolve the route, and refuses a train that is no
            // longer on it.
            if (ref && ref.train && ref.line) {
                return { train: ref.train, line: ref.line, reason: 'selected' };
            }
        }
        const lines = (project && Array.isArray(project.lines)) ? project.lines : [];
        for (const line of lines) {
            const trains = (line && Array.isArray(line.trains)) ? line.trains : [];
            if (trains.length > 0) return { train: trains[0], line, reason: 'first' };
        }
        return null;
    }

    const api = { pickCabTarget };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__plannerCabTarget = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
