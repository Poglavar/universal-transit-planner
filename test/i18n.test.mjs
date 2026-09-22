import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../web/i18n.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInContext(source, vm.createContext({
    module,
    globalThis: {},
    URL,
    URLSearchParams,
}));
const i18n = module.exports;

test('language selection prefers URL, then saved choice, then browser language', () => {
    assert.equal(i18n.detectLanguage({
        search: '?lang=en',
        stored: 'hr',
        languages: ['hr-HR'],
    }), 'en');
    assert.equal(i18n.detectLanguage({ stored: 'hr', languages: ['en-GB'] }), 'hr');
    assert.equal(i18n.detectLanguage({ languages: ['hr-HR', 'en-US'] }), 'hr');
    assert.equal(i18n.detectLanguage({ languages: ['de-DE', 'en-GB'] }), 'en');
});

test('unsupported language values fall back to the next available signal', () => {
    assert.equal(i18n.detectLanguage({
        search: '?lang=de',
        stored: 'en',
        languages: ['hr-HR'],
    }), 'en');
});

test('English compatibility translations preserve surrounding whitespace and variables', () => {
    assert.equal(i18n.translateText('  Ljestvica  ', 'en'), '  Leaderboard  ');
    assert.equal(i18n.translateText('Trasa 12 · 4 km', 'en'), 'Track 12 · 4 km');
    assert.equal(i18n.translateText('Objekti — North line', 'en'), 'Structures — North line');
    assert.equal(i18n.translateText('🛤️ Ravni teren (3 dionice)', 'en'), '🛤️ At grade (3 segments)');
    assert.equal(i18n.translateText('(1 dionica)', 'en'), '(1 segment)');
    assert.equal(i18n.translateText('8 objekata', 'en'), '8 structures');
    assert.equal(
        i18n.translateText('Trasa 1 🚊 Uskotračna (1000 mm) · 6.1 km (bez uzdužnog profila — samo tunel/teren/vijadukt)', 'en'),
        'Track 1 🚊 Metre gauge (1000 mm) · 6.1 km (no vertical profile — tunnel/surface/viaduct only)',
    );
    assert.equal(i18n.interpolate('Project “{name}” loaded.', { name: 'North line' }), 'Project “North line” loaded.');
});

test('language URLs preserve existing parameters and fragments', () => {
    assert.equal(
        i18n.withLanguage('/transit.html?project=7#station', 'hr', 'https://example.test/app/'),
        'https://example.test/transit.html?project=7&lang=hr#station',
    );
});
