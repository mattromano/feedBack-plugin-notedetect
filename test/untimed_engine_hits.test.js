// The desktop engine stamps a hit it could not match to a pick attack at the chart
// time (verdict.timed === false). That read as exactly 0 ms — "on time" by construction
// — so palm-muted riffs filled the timing stats and Sync Lab with fake zeros and a badly
// offset rig still measured on time. Untimed hits still count; their timing is null.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function fnSource(name) {
    const start = SRC.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} not found`);
    let i = SRC.indexOf('{', start) + 1, depth = 1;
    while (i < SRC.length && depth > 0) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') depth--; i++; }
    return SRC.slice(start, i);
}

const ctx = {};
vm.runInNewContext(`${fnSource('_ndMarkUntimed')}; this.mark = _ndMarkUntimed;`, ctx);

test('an untimed hit keeps counting but reports no timing', () => {
    const j = ctx.mark({ hit: true, timingError: 0, timingState: 'OK' });
    assert.equal(j.hit, true);
    assert.equal(j.timingError, null);
    assert.equal(j.timingUnknown, true);
});

test('misses are left alone', () => {
    const j = ctx.mark({ hit: false, timingError: null });
    assert.equal(j.timingUnknown, undefined);
});

test('single-note engine hits are marked only on an explicit timed === false', () => {
    assert.match(SRC, /const judgment = makeMatchedJudgment\([\s\S]{0,200}?\);\s*if \(v\.timed === false\) _ndMarkUntimed\(judgment\);/);
});

test('a chord prefers a measured attack and is untimed only when no member was timed', () => {
    const body = fnSource('_ndFinalizeChordVerdict');
    assert.match(body, /const vTimed = v\.timed !== false;/);
    assert.match(body, /if \(!vTimed && detectedTimed\)/);
    assert.match(body, /if \(!detectedTimed\) _ndMarkUntimed\(chordJudgment\);\s*recordJudgment\(chordKey, chordJudgment\);/);
});

test('timing stats skip a null timingError (the diagnostic collector guard)', () => {
    assert.match(SRC, /if \(Number\.isFinite\(judgment\.timingError\) && _diagTimingErrors\.length < _DIAG_ERROR_CAP\)/);
});
