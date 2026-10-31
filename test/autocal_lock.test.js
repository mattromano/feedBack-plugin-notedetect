// A/V auto-calibrate respects core's lock (the offset set by hand or applied by
// the main menu's Calibrate): no sweep while locked, nothing logged or announced
// when core ignores the write, and the user's Auto-tune Apply passes 'manual'.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

test('a locked A/V offset is left alone: no sweep, no setAvOffsetMs', () => {
    let calls = 0;
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.isAvOffsetLocked = () => true;
            sb.setAvOffsetMs = () => { calls++; return true; };
        },
    });
    const det = core.createNoteDetector({ isDefault: true });
    assert.equal(det._runAutoCalibrate(), 'locked (A/V set by hand)');
    assert.equal(calls, 0);
});

test('an unlocked host still runs the usual checks (older cores without isAvOffsetLocked too)', () => {
    const core = loadDetectionCore({ sandboxBeforeRun(sb) { sb.isAvOffsetLocked = () => false; } });
    const r = core.createNoteDetector({ isDefault: true })._runAutoCalibrate();
    assert.notEqual(r, 'locked (A/V set by hand)');
    const old = loadDetectionCore();
    assert.notEqual(old.createNoteDetector({ isDefault: true })._runAutoCalibrate(), 'locked (A/V set by hand)');
});

test('an ignored write (core returns false) is not logged or announced as calibrated', () => {
    const fn = SCREEN.slice(SCREEN.indexOf('function _ndRunAutoCalibrate()'));
    const body = fn.slice(0, fn.indexOf("return 'OK '"));
    const ignored = body.indexOf('window.setAvOffsetMs(r.offsetMs) === false');
    assert.ok(ignored > 0, 'checks the return value');
    assert.ok(ignored < body.indexOf('A/V auto-calibrated to'), 'before the log line');
    assert.ok(ignored < body.indexOf("dispatchInstanceEvent('notedetect:calibrated'"), 'before the event');
});

test("the Auto-tune panel's A/V Apply is the user's: it passes 'manual'", () => {
    assert.match(SETTINGS, /window\.setAvOffsetMs\(suggested, false, 'manual'\)/);
    assert.doesNotMatch(SETTINGS, /window\.setAvOffsetMs\(suggested\);/);
});
