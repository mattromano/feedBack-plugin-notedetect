// setScoreHudHidden(): Build-a-Band's band HUD replaces note_detect's own score
// HUD and end-of-song summary. Never persisted; per instance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'screen.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'plugin.css'), 'utf8');

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

test('setScoreHudHidden toggles and refuses non-booleans', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    assert.equal(det.isScoreHudHidden(), false);
    assert.equal(det.setScoreHudHidden(true), true);
    assert.equal(det.isScoreHudHidden(), true);
    assert.equal(det.setScoreHudHidden('on'), false);
    assert.equal(det.isScoreHudHidden(), true);
    assert.equal(det.setScoreHudHidden(false), true);
    assert.equal(det.isScoreHudHidden(), false);
});

test('the end-of-song summary takes the gig path while the score HUD is hidden', () => {
    const fn = extractBlock(SRC, 'function _endOfSongOnEnded()');
    assert.ok(fn.includes('_inGigSet() || scoreHudHidden'),
        'the gig branch must also fire while the score HUD is hidden');
});

test('plugin.css hides the HUD and the flash overlay', () => {
    assert.ok(CSS.includes('[data-nd-score-hidden="1"] .nd-hud'));
    assert.ok(CSS.includes('[data-nd-score-hidden="1"] .nd-flash-overlay'));
});
