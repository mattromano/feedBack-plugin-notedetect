// Public setDevice(deviceId): lets other plugins (Build-a-Band) pick the input
// device without the gear popover. Persists for the default instance and never
// opens the mic while detection is off.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function load(extra) {
    const writes = [];
    const gum = { calls: 0 };
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.localStorage.setItem = (k, v) => { writes.push([k, v]); };
            if (extra) extra(sb);
            sb.navigator.mediaDevices.getUserMedia = () => {
                gum.calls++;
                return Promise.reject(new Error('not available in vm'));
            };
        },
    });
    return { core, writes, gum };
}

const settingsWrites = (writes) => writes.filter(([k]) => k === 'slopsmith_notedetect');

test('setDevice persists the device for the default instance without opening the mic', () => {
    const { core, writes, gum } = load();
    const det = core.createNoteDetector({ isDefault: true });
    const before = settingsWrites(writes).length;
    det.setDevice('dev-2');
    const after = settingsWrites(writes);
    assert.ok(after.length > before, 'settings were written');
    assert.equal(JSON.parse(after[after.length - 1][1]).deviceId, 'dev-2');
    assert.equal(gum.calls, 0);
});

test('setDevice on a non-default instance does not write settings', () => {
    const { core, writes } = load();
    const det = core.createNoteDetector({ isDefault: false });
    const before = settingsWrites(writes).length;
    det.setDevice('dev-3');
    assert.equal(settingsWrites(writes).length, before);
});

test('setDevice ignores non-strings', () => {
    const { core, writes } = load();
    const det = core.createNoteDetector({ isDefault: true });
    const before = settingsWrites(writes).length;
    det.setDevice(42);
    det.setDevice(null);
    assert.equal(settingsWrites(writes).length, before);
});

test('setDevice is on the documented API surface', () => {
    const { core } = load();
    const det = core.createNoteDetector({ isDefault: true });
    assert.equal(typeof det.setDevice, 'function');
});

test('setDevice updates an open gear select', () => {
    const select = { value: '' };
    const { core } = load((sb) => {
        const orig = sb.document.querySelector;
        sb.document.querySelector = (sel) => (
            sel === '.nd-settings-panel .nd-device-select'
                ? select
                : (typeof orig === 'function' ? orig.call(sb.document, sel) : null));
    });
    const det = core.createNoteDetector({ isDefault: true });
    det.setDevice('dev-9');
    assert.equal(select.value, 'dev-9');
});
