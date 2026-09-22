// Defines how loaded projects behave in the planner. Reference railways remain
// identifiable as existing infrastructure, but open as editable working copies.
(function initPlannerProjectLifecycle(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__plannerProjectLifecycle = api;
})(typeof window !== 'undefined' ? window : globalThis, function plannerProjectLifecycleFactory() {
    function isReferenceProject(project) {
        return project?.purpose === 'existing'
            && project?.access === 'reference';
    }

    function workingCopyPolicy(project) {
        return {
            isReference: isReferenceProject(project),
            canEdit: true,
            saveCreatesNewProject: true,
        };
    }

    function authoredProjectIdentity() {
        return {
            purpose: 'proposal',
            access: 'editable',
            referenceKind: null,
            provenance: null,
        };
    }

    return Object.freeze({
        isReferenceProject,
        workingCopyPolicy,
        authoredProjectIdentity,
    });
});
