// Note detection stays off on a drum part: the song:loaded re-arm skips a
// highway whose loaded part is Drums, so a drums play (plain, Play as or a
// RockHeroSmith drum solo) never opens the guitar input or shows the
// "not hearing your instrument" banner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const { isDrumPart } = loadDetectionCore();

test('isDrumPart: the loaded arrangement by name or type', () => {
    assert.equal(isDrumPart({ arrangement: 'Drums' }), true);
    assert.equal(isDrumPart({ arrangement: 'Percussion' }), true);
    assert.equal(isDrumPart({ arrangement_index: 2, arrangements: [{ index: 0, name: 'Lead' }, { index: 2, name: 'Drums' }] }), true);
    assert.equal(isDrumPart({ arrangement_index: 1, arrangements: [{ index: 1, name: 'Kit', type: 'drums' }] }), true);
});

test('isDrumPart: guitar parts and unknown shapes are not drums', () => {
    for (const a of ['Lead', 'Rhythm', 'Bass', 'Combo']) assert.equal(isDrumPart({ arrangement: a }), false, a);
    assert.equal(isDrumPart({ arrangement: 'Lead', has_drum_tab: true }), false, 'a drum tab beside a guitar part');
    assert.equal(isDrumPart(null), false);
    assert.equal(isDrumPart({}), false);
});

test('the song:loaded re-arm checks for a drum part before enabling', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    const m = src.match(/function _reArmOnSongLoaded\(\) \{[\s\S]*?\n    \}\r?\n/);
    assert.ok(m, '_reArmOnSongLoaded present');
    const body = m[0];
    assert.ok(body.indexOf('_ndIsDrumPart') !== -1, 'checks the loaded part');
    assert.ok(body.indexOf('_ndIsDrumPart') < body.indexOf('enable()'), 'before enabling');
    assert.match(body, /disable\(\{ silent: true \}\)/, 'and stops quietly if it was on');
});
