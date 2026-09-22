// What the ephemeral "how do I get into the cab" banner says when a project
// opens on the 2D map — or null when the project has no train to ride, so the
// banner would send the reader looking for an icon that is not there. Pure and
// DOM-free so the wording rule is unit-testable; transit.js renders and times it.
(function (root) {
    'use strict';

    // hasTrain: whether pickCabTarget found anything. coarsePointer: a touch
    // device, where the keyboard half of the sentence is noise and there is no
    // click, only a tap. Returns { lead, key, rest } — `key` is rendered as a
    // keycap between the two halves — or null.
    function plannerCabHint({ hasTrain, coarsePointer } = {}) {
        if (!hasTrain) return null;
        if (coarsePointer) return { lead: 'Dodirni ikonu vlaka za ulaz u kabinu', key: null, rest: '' };
        return { lead: 'Pritisni', key: 'K', rest: 'za ulaz u kabinu, ili klikni na ikonu vlaka' };
    }

    const api = { plannerCabHint };
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.__plannerCabHint = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
