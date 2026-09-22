import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../web/transit.js', import.meta.url), 'utf8');

function bodyBetween(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(from, -1, start);
    assert.notEqual(to, -1, end);
    return source.slice(from, to);
}

test('chainage cab claims the train before opening Station3D', () => {
    const body = bodyBetween('function rideCabToTrackChainage', 'function setElevationHoverMarker');
    assert.ok(body.indexOf('train._cabRidden = true') < body.indexOf('openPlannerTrainCab'));
    assert.match(body, /if \(!openPlannerTrainCab[\s\S]*train\._cabRidden = false/);
});

test('cab deeplink holds its exact offset across asynchronous proposal loading', () => {
    const body = bodyBetween('async function applyPlannerCab3DLink', 'function getPlannerStationElevationMeters');
    assert.ok(body.indexOf('train._cabRidden = true') < body.indexOf('fetchPlanProposalRecords'));
    assert.match(body, /catch \(error\) \{\s*train\._cabRidden = false/);
    assert.match(body, /if \(!opened\) \{\s*train\._cabRidden = false/);
});
