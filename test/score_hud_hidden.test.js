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

test('setScoreHudHidden sets and removes data-nd-score-hidden on the instance root', () => {
    // Elements that keep their attributes, so the instance root can be read.
    const made = [];
    function recordingElement() {
        const attrs = new Map();
        const props = { style: {}, attrs };
        const el = new Proxy(props, {
            get: (t, prop) => {
                if (prop in t) return t[prop];
                if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
                if (prop === 'setAttribute') return (k, v) => { attrs.set(k, String(v)); };
                if (prop === 'removeAttribute') return (k) => { attrs.delete(k); };
                if (prop === 'getAttribute') return (k) => (attrs.has(k) ? attrs.get(k) : null);
                if (prop === 'querySelector') return () => null;
                if (prop === 'querySelectorAll') return () => [];
                if (typeof prop === 'symbol') return undefined;
                return () => {};
            },
            set: (t, prop, v) => { t[prop] = v; return true; },
        });
        made.push(el);
        return el;
    }
    const core = loadDetectionCore({
        sandboxBeforeRun: (sb) => { sb.document.createElement = recordingElement; },
    });
    const det = core.createNoteDetector({ isDefault: true });
    const roots = made.filter((e) => e.className === 'nd-instance-root');
    const root = roots.at(-1);
    assert.ok(root, 'instance root created');
    assert.equal(root.getAttribute('data-nd-score-hidden'), null);
    det.setScoreHudHidden(true);
    assert.equal(root.getAttribute('data-nd-score-hidden'), '1');
    det.setScoreHudHidden('yes');
    assert.equal(root.getAttribute('data-nd-score-hidden'), '1', 'a refused value leaves it');
    det.setScoreHudHidden(false);
    assert.equal(root.getAttribute('data-nd-score-hidden'), null);
});
