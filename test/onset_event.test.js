// notedetect:onset: a public event for any new note attack (Build-a-Band's
// "Noodle it up" counts these). Two sources share one emitter with an 80 ms
// refractory: the desktop engine's fresh onsets and a level attack at both
// level-history sites.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'screen.js'), 'utf8');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// The loader hoists every top-level function declaration onto its sandbox;
// keep a handle to it to reach the onset helpers.
function sandbox() {
    let sb = null;
    loadDetectionCore({ sandboxBeforeRun: (s) => { sb = s; } });
    return sb;
}

test('level attack: a 4 dB jump above the floor is an onset', () => {
    const { _ndLevelOnset } = sandbox();
    assert.equal(_ndLevelOnset(0.05, 0.09), true);
    assert.equal(_ndLevelOnset(0.05, 0.07), false, 'under x1.6');
    assert.equal(_ndLevelOnset(0, 0.04), false, 'under the floor');
    assert.equal(_ndLevelOnset(NaN, 0.06), true, 'a non-finite previous level counts as 0');
});

test('a ringing note decays without an onset', () => {
    const { _ndLevelOnset } = sandbox();
    const levels = [0.6, 0.5, 0.42, 0.35, 0.3, 0.26];
    for (let i = 1; i < levels.length; i++) {
        assert.equal(_ndLevelOnset(levels[i - 1], levels[i]), false, `${levels[i - 1]} -> ${levels[i]}`);
    }
});

test('refractory', () => {
    const { _ndOnsetDue } = sandbox();
    assert.equal(_ndOnsetDue(null, 1), true);
    assert.equal(_ndOnsetDue(1, 1.05), false);
    assert.equal(_ndOnsetDue(1, 1.08), true);
    assert.equal(_ndOnsetDue(5, 1), true, 'a backward jump');
});

test('onsets are emitted at both level sites and from engine onsets', () => {
    const pushAt = SRC.indexOf('_ndLevelSamples.push({ songT, level: inputLevel })');
    assert.ok(pushAt !== -1, 'desktop level push not found');
    const blockStart = SRC.lastIndexOf('if (hw && typeof hw.getTime === \'function\') {', pushAt);
    assert.ok(blockStart !== -1, 'desktop level block not found');
    const desktop = extractBlock(SRC, SRC.slice(blockStart, pushAt));
    assert.ok(desktop.includes('_ndEmitOnset('), 'desktop level site emits');

    const frame = extractBlock(SRC, 'async function processFrame(');
    assert.ok(frame.includes('_ndEmitOnset('), 'browser processFrame emits');

    const setAt = SRC.indexOf('bridgeNewOnsets.set(n.midi');
    assert.ok(setAt !== -1, 'bridgeNewOnsets.set not found');
    const lineStart = SRC.lastIndexOf('\n', setAt) + 1;
    const after = SRC.slice(lineStart).split('\n').slice(0, 31).join('\n');
    assert.ok(after.includes('_ndEmitOnset('), 'engine onsets emit within 30 lines');
});

test('the emitter dispatches notedetect:onset with the instance\'s isDefault', () => {
    const fn = extractBlock(SRC, 'function _ndEmitOnset(');
    assert.ok(fn.includes("dispatchInstanceEvent('notedetect:onset'"));
    assert.ok(fn.includes('isDefault'));
    assert.match(fn, /if\s*\(\s*!enabled\b.*\)\s*return\s*;/, 'returns early on !enabled');
});
