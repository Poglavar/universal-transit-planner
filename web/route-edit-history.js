(function initRouteEditHistory(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__routeEditHistory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRouteEditHistoryApi() {
    'use strict';

    function createHistory(limit = 50) {
        const maxEntries = Number.isInteger(limit) && limit > 0 ? limit : 50;
        const entries = [];

        return Object.freeze({
            push(entry) {
                if (!entry || typeof entry.undo !== 'function') {
                    throw new TypeError('An undo entry needs an undo function.');
                }
                entries.push(entry);
                if (entries.length > maxEntries) entries.shift();
                return entry;
            },
            undo() {
                const entry = entries.pop();
                if (!entry) return null;
                try {
                    entry.undo();
                } catch (error) {
                    entries.push(entry);
                    throw error;
                }
                return entry;
            },
            clear() {
                entries.length = 0;
            },
            peek() {
                return entries[entries.length - 1] || null;
            },
            get size() {
                return entries.length;
            },
        });
    }

    function isUndoShortcut(event) {
        return !!event
            && (event.metaKey || event.ctrlKey)
            && !event.altKey
            && !event.shiftKey
            && String(event.key || '').toLowerCase() === 'z';
    }

    function isEditableTarget(target) {
        const tagName = String(target?.tagName || '').toUpperCase();
        return tagName === 'INPUT'
            || tagName === 'TEXTAREA'
            || tagName === 'SELECT'
            || !!target?.isContentEditable;
    }

    return Object.freeze({ createHistory, isUndoShortcut, isEditableTarget });
}));
