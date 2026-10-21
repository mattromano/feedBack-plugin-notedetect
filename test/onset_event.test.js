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

// Fix round 1 (I1): dedupe by absolute distance, 80 ms within a source and
// 150 ms across sources. `count` replays a sequence through _ndOnsetDue the
// way _ndEmitOnset does.
function count(_ndOnsetDue, seq) {
    let lastT = null, lastSource = null, n = 0;
    for (const [source, t] of seq) {
        if (!_ndOnsetDue(lastT, t, lastSource, source)) continue;
        lastT = t; lastSource = source; n++;
    }
    return n;
}

test('cross-source dedupe: one pick heard by both sources is one onset', () => {
    const { _ndOnsetDue } = sandbox();
    assert.equal(count(_ndOnsetDue, [['level', 1.000], ['engine', 0.990]]), 1,
        'a back-dated engine onset after a level attack');
    assert.equal(count(_ndOnsetDue, [['engine', 1.000], ['level', 1.120]]), 1,
        'a late level attack after an engine onset');
    assert.equal(count(_ndOnsetDue, [['level', 1.000], ['level', 1.090]]), 2,
        'two level attacks 90 ms apart');
    assert.equal(_ndOnsetDue(10, 2, 'level', 'level'), true, 'a backward seek');
    assert.equal(_ndOnsetDue(10, 2, 'level', 'engine'), true, 'a backward seek across sources');
});

// Fix round 1 (M1, M3): drive the desktop level poll through the bridge stub.
// The first reading only primes; a later +4 dB jump emits one 'level' onset.
const flush = () => new Promise((r) => setImmediate(r));

test('level path: the first reading primes, a later attack emits notedetect:onset', async () => {
    const levels = [0.3, 0.3, 0.1, 0.3];
    let li = 0;
    let songT = 5;
    const events = [];
    const intervals = [];
    const calls = { getLevels: 0 };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic'));
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.dispatchEvent = (ev) => { if (ev.type === 'notedetect:onset') events.push(ev.detail); };
            sb.highway.getTime = () => songT;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
                    getLevels: async () => {
                        calls.getLevels++;
                        const v = levels[Math.min(li++, levels.length - 1)];
                        return { inputLevel: v, inputPeak: v, outputLevel: 0, outputPeak: 0 };
                    },
                    getSampleRate: async () => 48000,
                },
            };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    for (let i = 0; i < 5; i++) await flush();

    let levelTick = null;
    for (const cb of intervals) {
        const before = calls.getLevels;
        await cb();
        await flush();
        if (calls.getLevels > before) { levelTick = cb; break; }
    }
    assert.equal(typeof levelTick, 'function', 'the level poll interval is registered');
    assert.equal(events.length, 0, 'the first reading (0.3) only primes');
    for (let i = 1; i < levels.length; i++) {
        songT += 0.05;
        await levelTick();
        await flush();
    }
    assert.equal(events.length, 1, '0.3 -> 0.3 -> 0.1 -> 0.3 gives one attack');
    const d = events[0];
    assert.equal(d.source, 'level');
    assert.equal(d.level, 0.3);
    assert.equal(d.midi, null);
    assert.equal(d.confidence, null);
    assert.equal(d.isDefault, false);
    assert.ok(Math.abs(d.t - (5.15 - 0.08)) < 1e-9, `t = songT - latencyOffset, got ${d.t}`);
    det.destroy();
    await flush();
});
