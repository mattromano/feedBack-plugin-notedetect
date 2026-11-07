// The input-level wizard's calibration shares the engine input gain with the
// desktop tone presets. Automatic re-asserts (startup, Detect enable) must not
// replace a tone's own input level; the wizard itself still applies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const docWith = (value) => ({ getElementById: (id) => (id === 'ae-input-gain' ? { value } : null) });

test('reads the tone input level from the Audio Engine control', () => {
    const { _ndToneInputGainDb } = loadDetectionCore();
    assert.equal(_ndToneInputGainDb(docWith('4')), 4);
    assert.equal(_ndToneInputGainDb(docWith('-2.7')), -2.7);
    assert.equal(_ndToneInputGainDb(docWith('')), null);
    assert.equal(_ndToneInputGainDb({ getElementById: () => null }), null, 'browser app: no control');
    assert.equal(_ndToneInputGainDb(null), null);
});

test('a tone with its own input level wins over the automatic re-assert', () => {
    const { _ndShouldApplyEngineGain: should } = loadDetectionCore();
    assert.equal(should(0.5, false, 4), false, '+4 dB lead tone keeps its push');
    assert.equal(should(0.5, false, -3), false, 'any non-unity tone level wins');
    assert.equal(should(0.5, false, 0), true, 'unity tone: calibration applies');
    assert.equal(should(0.5, false, null), true, 'no tone control: calibration applies');
    assert.equal(should(null, false, 0), false, 'never calibrated: nothing to apply');
});

test('the wizard always applies its calibration', () => {
    const { _ndShouldApplyEngineGain: should } = loadDetectionCore();
    assert.equal(should(0.5, true, 4), true);
    assert.equal(should(null, true, 4), false, 'still nothing to apply when uncalibrated');
});

test('only the wizard call sites force; startup and enable() do not', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    const calls = src.match(/_ndApplyEngineGain\((true)?\)/g) || [];
    assert.equal(calls.filter((c) => c.includes('true')).length, 2, 'wizard apply + wizard close');
    assert.match(src, /setTimeout\(\(\) => _ndApplyEngineGain\(\), ms\)/, 'startup re-asserts are not forced');
    assert.match(src, /ensureDrawHook\(\);[\s\S]{0,200}_ndApplyEngineGain\(\);/, 'enable() is not forced');
});
