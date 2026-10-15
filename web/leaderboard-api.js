// Summary lists, bounded pagination, coalesced project reads and lazy visible previews.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__leaderboardApi = api;
})(typeof window === 'undefined' ? null : window, function (root) {
    function createClient({ apiBaseUrl, fetchImpl, pageLimit = 100, maxOffset = 10000 } = {}) {
        const base = String(apiBaseUrl || '').replace(/\/+$/, '');
        const request = fetchImpl || (root && root.fetch ? root.fetch.bind(root) : globalThis.fetch);
        if (!base) throw new Error('A transit API base URL is required.');
        if (typeof request !== 'function') throw new Error('A fetch implementation is required.');
        if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
            throw new Error('Transit page limit must be between 1 and 100.');
        }
        if (!Number.isInteger(maxOffset) || maxOffset < 0 || maxOffset > 10000) {
            throw new Error('Transit maximum offset must be between 0 and 10000.');
        }
        const detailRequests = new Map();
        const detailCache = new Map();
        const maxCachedDetails = 200;

        async function readList(url) {
            const response = await request(url, { cache: 'no-store' });
            if (!response.ok) throw new Error('Transit list request failed (' + response.status + ').');
            const value = await response.json();
            if (!Array.isArray(value)) throw new Error('Transit list response is not an array.');
            return value;
        }

        return Object.freeze({
            fetchLeaderboard(sort) {
                const selectedSort = encodeURIComponent(String(sort || 'cost_per_person'));
                return readList(base + '/transit/leaderboard?sort=' + selectedSort + '&view=summary');
            },
            async fetchUnranked() {
                const all = [];
                for (let offset = 0; offset <= maxOffset; offset += pageLimit) {
                    const page = await readList(base + '/transit/unranked?view=summary&limit=' + pageLimit + '&offset=' + offset);
                    all.push(...page);
                    if (page.length < pageLimit) return all;
                    if (offset + pageLimit > maxOffset) {
                        throw new Error('Transit unranked list exceeds the supported pagination range.');
                    }
                }
                return all;
            },
            async fetchProjectDetail(projectId) {
                const key = String(projectId);
                if (detailCache.has(key)) {
                    const cached = detailCache.get(key);
                    detailCache.delete(key);
                    detailCache.set(key, cached);
                    return cached;
                }
                const active = detailRequests.get(key);
                if (active) return active;
                const task = (async () => {
                    const response = await request(base + '/transit/projects/' + encodeURIComponent(key), { cache: 'no-store' });
                    if (!response.ok) throw new Error('Transit project request failed (' + response.status + ').');
                    const detail = await response.json();
                    detailCache.set(key, detail);
                    while (detailCache.size > maxCachedDetails) detailCache.delete(detailCache.keys().next().value);
                    return detail;
                })();
                detailRequests.set(key, task);
                try {
                    return await task;
                } finally {
                    if (detailRequests.get(key) === task) detailRequests.delete(key);
                }
            },
        });
    }

    function createLazyPreviewQueue({ Observer, concurrency = 2, isCurrent, load, onLoad, onError } = {}) {
        if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Preview concurrency must be positive.');
        if (typeof load !== 'function' || typeof onLoad !== 'function') throw new Error('Preview loading callbacks are required.');
        const IntersectionObserverImpl = Observer === undefined ? root?.IntersectionObserver : Observer;
        let records = new WeakMap();
        let queue = [];
        const queued = new Set();
        const pending = new Set();
        let active = 0;
        let observer = null;
        const current = isCurrent || (element => element && element.isConnected !== false);

        function pump() {
            while (active < concurrency && queue.length) {
                const element = queue.shift();
                queued.delete(element);
                const projectId = records.get(element);
                if (!projectId || !current(element, projectId)) continue;
                active++;
                pending.add(element);
                Promise.resolve().then(() => load(projectId)).then(detail => {
                    if (current(element, projectId)) onLoad(element, projectId, detail);
                }).catch(error => {
                    if (current(element, projectId) && typeof onError === 'function') onError(element, projectId, error);
                }).finally(() => {
                    active--;
                    pending.delete(element);
                    pump();
                });
            }
        }

        function enqueue(element) {
            if (!records.has(element) || queued.has(element) || pending.has(element)) return false;
            const projectId = records.get(element);
            if (!current(element, projectId)) return false;
            if (observer) observer.unobserve(element);
            queued.add(element);
            queue.push(element);
            pump();
            return true;
        }

        if (typeof IntersectionObserverImpl === 'function') {
            observer = new IntersectionObserverImpl(entries => {
                for (const entry of entries) if (entry.isIntersecting) enqueue(entry.target);
            }, { rootMargin: '120px 0px' });
        }

        return Object.freeze({
            available: Boolean(observer),
            observe(element, projectId) {
                if (!element || projectId === undefined || projectId === null) return false;
                records.set(element, String(projectId));
                if (observer) observer.observe(element);
                return true;
            },
            retry(element, projectId) {
                if (!element) return false;
                if (projectId !== undefined && projectId !== null) records.set(element, String(projectId));
                return enqueue(element);
            },
            reset() {
                if (observer) observer.disconnect();
                records = new WeakMap();
                queue = [];
                queued.clear();
            },
            get activeCount() { return active; },
            get queuedCount() { return queue.length; },
        });
    }

    return Object.freeze({ createClient, createLazyPreviewQueue });
});
