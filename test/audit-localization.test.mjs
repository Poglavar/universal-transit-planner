import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [catalogue, transit, cab, leaderboard, html] = await Promise.all([
    read('web/i18n.js'), read('web/transit.js'), read('web/planner-cab-hint.js'),
    read('web/leaderboard.js'), read('web/leaderboard.html'),
]);
function i18n(language) {
    const module = { exports: {} };
    vm.runInNewContext(catalogue, { module, window: { location: { search: `?lang=${language}` } }, URL, URLSearchParams });
    return module.exports;
}
function body(name, next) {
    return transit.slice(transit.indexOf(`function ${name}`), transit.indexOf(`function ${next}`));
}
function button() {
    return { classList: { toggle() {} }, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } };
}
for (const language of ['en', 'hr']) {
    test(`${language}: editor button labels and accessible names survive repeated mode changes`, () => {
        const buttons = [button(), button(), button()];
        const context = vm.createContext({
            I18N: i18n(language), projectLifecyclePolicy: () => ({ canEdit: true }), hasDraftLine: () => false,
            currentMode: 'explore', routeGaugePickerOpen: false,
            toggleTrackDrawingBtn: buttons[0], toggleStationPlacementBtn: buttons[1], toggleRouteEditingBtn: buttons[2],
            toggleElectrificationEditingBtn: null, toggleReferenceConnectionBtn: null,
        });
        vm.runInContext(body('syncMapActionButtons()', 'setMode('), context);
        for (const mode of ['explore', 'drawLine', 'placeStation', 'edit', 'explore']) {
            context.currentMode = mode;
            vm.runInContext('syncMapActionButtons()', context);
            for (const [i, key] of ['newTrack', 'newStation', 'editNetwork'].entries()) {
                const active = mode === ['drawLine', 'placeStation', 'edit'][i];
                assert.equal(buttons[i].textContent, context.I18N.t(active ? 'finishAction' : key));
                const label = active ? ['finishTrackLabel', 'finishStationLabel', 'finishNetworkLabel'][i] : `${key}Label`;
                assert.equal(buttons[i].attributes['aria-label'], context.I18N.t(label));
            }
        }
    });
    test(`${language}: viewer tooltip reflects unsaved, dirty and saved projects`, () => {
        const context = vm.createContext({ I18N: i18n(language), openReliefViewerBtn: {}, savedProjectId: null, projectDirty: false });
        const start = transit.indexOf('function refreshReliefViewerButton()');
        const end = transit.indexOf('\n}', start) + 2;
        vm.runInContext(transit.slice(start, end), context);
        for (const [id, dirty, key] of [[null, false, 'saveReliefProjectHint'], [7, true, 'saveReliefChangesHint'], [7, false, 'openReliefHint']]) {
            context.savedProjectId = id; context.projectDirty = dirty;
            vm.runInContext('refreshReliefViewerButton()', context);
            assert.equal(context.openReliefViewerBtn.title, context.I18N.t(key));
            assert.equal(context.openReliefViewerBtn.disabled, !id || dirty);
        }
    });
}
test('cab hint uses the selected language for keyboard and touch, and hides without a train', () => {
    const module = { exports: {} };
    vm.runInNewContext(cab, { module });
    const hint = module.exports.plannerCabHint;
    assert.equal(hint({ hasTrain: false, language: 'en' }), null);
    assert.equal(hint({ hasTrain: true, language: 'en' }).lead, 'Press');
    assert.equal(hint({ hasTrain: true, language: 'en' }).key, 'K');
    assert.equal(hint({ hasTrain: true, language: 'en', coarsePointer: true }).lead, 'Tap the train icon to enter the cab');
    assert.equal(hint({ hasTrain: true, language: 'hr' }).lead, 'Pritisni');
    assert.match(transit, /coarsePointer:[^\n]+\n\s*language: UI_LANGUAGE/);
});
test('heatmap activity and leaderboard loading/disabled values use named messages', () => {
    const en = i18n('en');
    assert.equal(en.t('heatmapPopulationStatus', { count: '1,234' }), 'Heatmap: 1,234 buildings with population data.');
    assert.equal(en.t('heatmapJobsStatus', { count: 7 }), 'Heatmap: 7 buildings with jobs data.');
    assert.match(transit, /field === 'residents' \? 'heatmapPopulationStatus' : 'heatmapJobsStatus'/);
    assert.equal(en.t('loading'), 'Loading…');
    assert.equal(en.t('comingSoon'), 'Coming soon');
    assert.equal(i18n('hr').t('comingSoon'), 'Uskoro');
    assert.equal((html.match(/data-i18n="loading"/g) || []).length, 2);
    assert.equal((leaderboard.match(/i18n.t\('loading'\)/g) || []).length, 4);
    assert.match(leaderboard, /const lockedValue = isFixed \? `×\$\{field.fixedValue\}` : i18n.t\('comingSoon'\)/);
});

test('both entrypoints request the matching localization revision instead of cached scripts', async () => {
    const plannerHtml = await read('web/transit.html');
    for (const [page, scripts] of [
        [plannerHtml, ['i18n.js', 'transit.js', 'planner-cab-hint.js']],
        [html, ['i18n.js', 'leaderboard.js']],
    ]) {
        for (const script of scripts) {
            assert.ok(page.includes(`src="${script}?v=20261012-1"`), script);
        }
    }
});
