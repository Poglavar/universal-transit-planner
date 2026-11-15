// The planner cab's three-car consist is held back as one body at a line end, so its
// front car stops at the end of the track instead of the trailing cars sliding into it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../web/transit.js', import.meta.url), 'utf8');
const start = source.indexOf('const PLANNER_CAB_CAR_SPACING_M');
const end = source.indexOf('function makeTrainPoseFn', start);
assert.ok(start !== -1 && end !== -1);
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}; this.consist = plannerCabConsistDistance; this.spacing = PLANNER_CAB_CAR_SPACING_M;`, context);
const { consist, spacing } = context;

test('mid-line the consist is drawn where the train is', () => {
    assert.equal(consist(1888, 6086), 1888);
});

test('at either line end the whole consist stops a car short, so its end car is at the end', () => {
    assert.equal(consist(6086, 6086), 6086 - spacing);
    assert.equal(consist(6070, 6086), 6086 - spacing);
    assert.equal(consist(0, 6086), spacing);
    // The cars a spacing either side of it then never pass the line's ends.
    for (const d of [0, 5, 6080, 6086]) {
        const c = consist(d, 6086);
        assert.ok(c - spacing >= 0 && c + spacing <= 6086);
    }
});

test('a line shorter than the consist centres it', () => {
    assert.equal(consist(10, 40), 20);
});
