// Verify summary requests, complete pagination and bounded lazy geometry loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/leaderboard-api.js', import.meta.url), 'utf8');
const sandbox = { window: {}, URL, URLSearchParams, Map, Promise, Error, Number, String, Array, Object, encodeURIComponent, globalThis: {} };
vm.runInNewContext(source, sandbox, { filename: 'leaderboard-api.js' });
const { createClient, createLazyPreviewQueue } = sandbox.window.__leaderboardApi;
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('leaderboard uses summary without requesting project detail', async () => {
    const calls = [];
    const api = createClient({ apiBaseUrl: '/api/', fetchImpl: async (url, init) => { calls.push([url, init]); return json([{ id: 3 }]); } });
    assert.deepEqual(await api.fetchLeaderboard('cost_per_person'), [{ id: 3 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/transit/leaderboard?sort=cost_per_person&view=summary');
    assert.equal(calls[0][1].cache, 'no-store');
});

test('unranked pagination keeps every row across page boundaries', async () => {
    const calls = [];
    const api = createClient({ apiBaseUrl: '/api', fetchImpl: async url => {
        calls.push(url);
        const offset = Number(new URL(url, 'https://example.test').searchParams.get('offset'));
        const count = offset === 0 ? 100 : offset === 100 ? 100 : 3;
        return json(Array.from({ length: count }, (_, index) => ({ id: offset + index })));
    } });
    const rows = await api.fetchUnranked();
    assert.equal(rows.length, 203);
    assert.deepEqual(calls.map(url => new URL(url, 'https://example.test').searchParams.get('offset')), ['0', '100', '200']);
    assert.ok(calls.every(url => url.includes('view=summary&limit=100&offset=')));
});

test('unranked page failure rejects instead of returning a truncated list', async () => {
    let calls = 0;
    const api = createClient({ apiBaseUrl: '/api', fetchImpl: async () => (++calls === 1 ? json(Array.from({ length: 100 }, (_, id) => ({ id }))) : new Response('{}', { status: 503 })) });
    await assert.rejects(api.fetchUnranked(), /503/);
    assert.equal(calls, 2);
});

test('a full final page at the offset bound is reported rather than silently truncated', async () => {
    const api = createClient({ apiBaseUrl: '/api', pageLimit: 1, maxOffset: 0, fetchImpl: async () => json([{ id: 1 }]) });
    await assert.rejects(api.fetchUnranked(), /pagination range/);
});

test('summary rows defer geometry to a coalesced detail request, with retry after failure', async () => {
    const calls = [];
    let fail = true;
    const api = createClient({ apiBaseUrl: '/api', fetchImpl: async url => {
        calls.push(url);
        if (url.includes('/leaderboard?')) return json([{ id: 42, detail_path: '/api/transit/projects/42' }]);
        assert.equal(url, '/api/transit/projects/42');
        if (fail) { fail = false; return new Response('{}', { status: 503 }); }
        await new Promise(resolve => setTimeout(resolve, 5));
        return json({ id: 42, project_data: { tracks: [] } });
    } });
    const summaries = await api.fetchLeaderboard('cost_per_person');
    assert.deepEqual(summaries, [{ id: 42, detail_path: '/api/transit/projects/42' }]);
    await assert.rejects(api.fetchProjectDetail(summaries[0].id), /503/);
    const [first, second] = await Promise.all([
        api.fetchProjectDetail(summaries[0].id), api.fetchProjectDetail(summaries[0].id),
    ]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0], '/api/transit/leaderboard?sort=cost_per_person&view=summary');
    assert.deepEqual(first, second);
    assert.equal(first.id, 42);
    assert.ok(first.project_data);
    assert.deepEqual(await api.fetchProjectDetail(42), first);
    assert.equal(calls.length, 3, 'later row actions reuse the completed detail cache');
});

test('lazy previews wait for visibility and cap parallel detail loads at two', async () => {
    let observerCallback;
    class FakeObserver {
        constructor(callback, options) { observerCallback = callback; this.options = options; this.disconnected = false; }
        observe() {}
        unobserve() {}
        disconnect() { this.disconnected = true; }
    }
    const releases = new Map();
    const rendered = [];
    let active = 0;
    let peak = 0;
    const queue = createLazyPreviewQueue({
        Observer: FakeObserver,
        concurrency: 2,
        load: id => new Promise(resolve => {
            active++;
            peak = Math.max(peak, active);
            releases.set(id, value => { active--; resolve(value); });
        }),
        onLoad: (_cell, id) => rendered.push(id),
    });
    const cells = [1, 2, 3, 4].map(id => ({ id, isConnected: true }));
    cells.forEach(cell => queue.observe(cell, cell.id));
    assert.equal(queue.available, true);
    assert.equal(queue.queuedCount, 0);
    assert.equal(active, 0, 'rendering the summary table does not fetch project geometry');
    observerCallback(cells.map(target => ({ target, isIntersecting: true })));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(active, 2);
    assert.equal(peak, 2);
    releases.get('1')({ id: 1 });
    releases.get('2')({ id: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(active, 2);
    releases.get('3')({ id: 3 });
    releases.get('4')({ id: 4 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(peak, 2);
    assert.deepEqual(rendered.sort(), ['1', '2', '3', '4']);
});

test('detached rows are ignored and a failed visible preview can be retried', async () => {
    let observerCallback;
    class FakeObserver { constructor(callback) { observerCallback = callback; } observe() {} unobserve() {} disconnect() {} }
    let retryAttempts = 0;
    let rendered = 0;
    let errors = 0;
    const queue = createLazyPreviewQueue({
        Observer: FakeObserver,
        load: async id => {
            if (id === '7') return { id: 7 };
            retryAttempts++;
            if (retryAttempts === 1) throw new Error('temporary');
            return { id: 8 };
        },
        onLoad: () => { rendered++; },
        onError: () => { errors++; },
    });
    const detached = { isConnected: true };
    queue.observe(detached, 7);
    observerCallback([{ target: detached, isIntersecting: true }]);
    detached.isConnected = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(rendered, 0, 'a response cannot update a removed row');
    assert.equal(errors, 0);

    const cell = { isConnected: true };
    queue.observe(cell, 8);
    observerCallback([{ target: cell, isIntersecting: true }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(errors, 1);
    assert.equal(queue.retry(cell, 8), true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(retryAttempts, 2);
    assert.equal(rendered, 1);
});

test('without IntersectionObserver, previews still wait for an explicit user action', async () => {
    let loads = 0;
    const cell = { isConnected: true };
    const queue = createLazyPreviewQueue({ Observer: null, load: async () => { loads++; }, onLoad() {} });
    queue.observe(cell, 1);
    assert.equal(queue.available, false);
    assert.equal(loads, 0);
    queue.retry(cell, 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loads, 1);
});
