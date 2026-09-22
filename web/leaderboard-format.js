// Timestamp formatting and comparison for the leaderboard tables. Extracted from
// leaderboard.js so it can be unit-tested in node: the display format drops the
// year, which makes the sort comparison and the rendered text two different
// things that must not be confused for one another.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.__leaderboardFormat = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SHORT_MONTHS_HR = [
        'sij', 'velj', 'ožu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro',
    ];
    const SHORT_MONTHS_EN = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const LEADERBOARD_TAB_QUERY = {
        ranked: 'ranked',
        unranked: 'unranked',
        existing: 'existing',
    };

    // dd.mon.hh:mm in the reader's own timezone (26.srp.15:09). Deliberately
    // narrow: the column exists to sort by recency and to tell two imports of the
    // same line apart, not to be read as a full date.
    function formatCreatedAt(value, locale = 'en') {
        if (value === null || value === undefined || value === '') return '';
        const at = new Date(value);
        if (Number.isNaN(at.getTime())) return '';
        const pad = number => String(number).padStart(2, '0');
        const months = String(locale).toLowerCase().startsWith('hr') ? SHORT_MONTHS_HR : SHORT_MONTHS_EN;
        return `${pad(at.getDate())}.${months[at.getMonth()]}.`
            + `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }

    // Sorting compares the INSTANT, never the rendered text — the format has no
    // year, so "31.pro.23:59" sorts after "01.sij.00:01" as a string while being
    // a year earlier. Unparseable stays null so the existing null-last ordering
    // handles a project with no timestamp.
    function timestampValue(value) {
        const at = Date.parse(value);
        return Number.isFinite(at) ? at : null;
    }

    function findProjectById(projectId, ...collections) {
        const wantedId = Number(projectId);
        if (!Number.isFinite(wantedId)) return null;
        for (const projects of collections) {
            if (!Array.isArray(projects)) continue;
            const project = projects.find(candidate => Number(candidate?.id) === wantedId);
            if (project) return project;
        }
        return null;
    }

    function normalizeLeaderboardTab(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (['unranked', 'nerangirani'].includes(normalized)) return 'unranked';
        if (normalized === 'existing') return 'existing';
        return 'ranked';
    }

    function leaderboardTabQueryValue(tab) {
        return LEADERBOARD_TAB_QUERY[normalizeLeaderboardTab(tab)];
    }

    // Reference-project imports used to append an implementation detail to the
    // public name. The Postojeće tab already supplies that context; keep stored
    // data untouched but present a clean railway name everywhere in the list
    // and in portable-export metadata/filenames.
    function displayProjectName(value) {
        const original = String(value ?? '').trim();
        if (!original) return '';
        const cleaned = original.replace(
            /\s*(?:[·•|–—-]\s*)?rekonstrukcija visinskog profila\s*$/iu,
            '',
        ).trim();
        return cleaned || original;
    }

    return {
        LEADERBOARD_TAB_QUERY,
        SHORT_MONTHS_EN,
        SHORT_MONTHS_HR,
        displayProjectName,
        leaderboardTabQueryValue,
        formatCreatedAt,
        normalizeLeaderboardTab,
        timestampValue,
        findProjectById,
    };
}));
