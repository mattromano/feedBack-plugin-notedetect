// setInputErrorsQuiet(): band mode swaps the blocking alert() on an input
// failure for a public notedetect:input-error event. Never persisted; per instance.

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

test('setInputErrorsQuiet toggles and refuses non-booleans', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    assert.equal(det.isInputErrorsQuiet(), false);
    assert.equal(det.setInputErrorsQuiet(true), true);
    assert.equal(det.isInputErrorsQuiet(), true);
    assert.equal(det.setInputErrorsQuiet('on'), false);
    assert.equal(det.isInputErrorsQuiet(), true);
    assert.equal(det.setInputErrorsQuiet(false), true);
    assert.equal(det.isInputErrorsQuiet(), false);
});

test('an input failure is announced and alerts only when not quiet', () => {
    const fn = extractBlock(SRC, 'async function startAudio(');
    assert.ok(fn.includes("dispatchInstanceEvent('notedetect:input-error'"),
        'the catch must dispatch notedetect:input-error');
    assert.match(fn, /message\s*:\s*e && e\.message \? e\.message : String\(e\)/);
    const at = fn.indexOf('alert(');
    assert.ok(at !== -1, 'alert call not found');
    const before = fn.slice(0, at);
    const cond = before.slice(before.lastIndexOf('if ('));
    assert.ok(cond.includes('!quietInputErrors'), 'the alert must sit under !quietInputErrors');
});

test('the switch is on the public API', () => {
    assert.match(SRC, /^\s*setInputErrorsQuiet,\s*$/m);
    assert.match(SRC, /^\s*isInputErrorsQuiet:\s*\(\)\s*=>\s*quietInputErrors,?\s*$/m);
});
