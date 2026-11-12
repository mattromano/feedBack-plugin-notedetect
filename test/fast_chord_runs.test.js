// Fast chord runs: a chord that's still ringing must not turn the next one
// into an EARLY miss.
//
// In a fast run the next chord is often the same shape, so it is already
// sounding when its timing window opens. Three places used to book that as a
// miss:
//
//   1. Engine verifier: the chord took the detect time of whichever member was
//      listed first, even when another member was detected right on the beat.
//   2. Engine verifier: a chord the engine verified inside its window could be
//      stamped a little before the window's early edge (the pushed playhead
//      lags by up to a poll), which classified it EARLY at random.
//   3. Browser / scoreChord path: one EARLY strummed frame locked the chord in
//      as a miss, so the on-time strum a few frames later couldn't count.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flush(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// One two-note power chord at t = 1.0 s, delivered through getNotes() so the
// engine verifier groups it by timestamp.
const CHORD_T = 1.0;
const CHART = [
    { t: CHORD_T, s: 0, f: 5, sus: 0 },
    { t: CHORD_T, s: 1, f: 7, sus: 0 },
];

function engineSandbox() {
    const verdictQueue = [];
    const intervals = [];
    let pushed = null;
    let hwTime = 0;
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0.3, inputPeak: 0.4, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async (chart) => { pushed = chart; return true; },
        getNoteVerdicts: async () => (verdictQueue.length ? verdictQueue.shift() : []),
    };
    const judgments = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.highway.getNotes = () => CHART.map((n) => ({ ...n }));
            sb.highway.getChords = () => ([]);
            sb.highway.getTime = () => hwTime;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
            sb.window.dispatchEvent = (ev) => {
                if (ev && (ev.type === 'notedetect:hit' || ev.type === 'notedetect:miss')) judgments.push(ev.detail);
                return true;
            };
        },
    });
    return {
        createNoteDetector, intervals, verdictQueue, judgments,
        ids: () => (pushed ? Array.from(pushed.notes, (n) => n.id) : []),
        setHwTime: (t) => { hwTime = t; },
    };
}

async function driveUntil(intervals, pred) {
    for (const cb of intervals) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flush();
        if (pred()) return true;
    }
    return pred();
}

async function judgeEngineChord(stamps, timed = []) {
    const env = engineSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flush();
    assert.ok(await driveUntil(env.intervals, () => env.ids().length === 2), 'chart pushed to the engine');
    env.setHwTime(CHORD_T + 0.4);
    const ids = env.ids();
    env.verdictQueue.push(ids.map((id, i) => ({
        id, detected: true, detectedSongTime: stamps[i], centsError: 0, snr: 6,
        ...(typeof timed[i] === 'boolean' ? { timed: timed[i] } : {}),
    })));
    // Every interval gets a turn; the detect tick drains the verdicts.
    await driveUntil(env.intervals, () => det.getStats().hits + det.getStats().misses > 0);
    const stats = det.getStats();
    const chordJ = env.judgments.find((j) => j && j.chord);
    det.destroy();
    await flush();
    return { stats, chordJ };
}

test('engine verifier: a chord is stamped with the member detected closest to the beat', async () => {
    // Low string still ringing from the previous chord → reported 170 ms early;
    // the other string was struck 20 ms early, i.e. on time.
    const { stats, chordJ } = await judgeEngineChord([CHORD_T - 0.17, CHORD_T - 0.02]);
    assert.equal(stats.hits, 1, 'the chord should count as a hit');
    assert.equal(stats.misses, 0);
    assert.ok(chordJ, 'a chord judgment was emitted');
    assert.equal(chordJ.timingError, -20, 'timing comes from the closest member');
});

test('engine verifier: a repeated chord is not judged EARLY off the previous strum', async () => {
    // Same shape again: the low string's "measured" attack is the previous strum
    // (170 ms early); the other string has no attack of its own, so the engine
    // stamps it at the chart time (timed: false). The closest stamp still wins —
    // preferring the measured one broke streaks on every repeated chord.
    const { stats, chordJ } = await judgeEngineChord([CHORD_T - 0.17, CHORD_T], [true, false]);
    assert.equal(stats.hits, 1, 'the chord should count as a hit');
    assert.equal(stats.misses, 0);
    assert.equal(chordJ.timingError, null, 'the winning stamp was untimed: no fake 0 ms');
    assert.equal(chordJ.timingUnknown, true);
});

test('engine verifier: a timed closest member still reports its real timing', async () => {
    const { stats, chordJ } = await judgeEngineChord([CHORD_T - 0.17, CHORD_T - 0.02], [false, true]);
    assert.equal(stats.hits, 1);
    assert.equal(chordJ.timingError, -20);
    assert.notEqual(chordJ.timingUnknown, true);
});

test('engine verifier: a chord verified at the early window edge counts as on time', async () => {
    // Both members present as the window opened (same shape still ringing),
    // stamped by a playhead that lags a poll behind: 180 ms early, just past
    // the 150 ms chord threshold.
    const { stats, chordJ } = await judgeEngineChord([CHORD_T - 0.18, CHORD_T - 0.18]);
    assert.equal(stats.hits, 1, 'an engine-verified chord at the window edge is not EARLY');
    assert.equal(stats.misses, 0);
    assert.equal(chordJ.timingState, 'OK');
});

test('engine verifier: a chord stamped well before its window is still EARLY', async () => {
    // 400 ms early is far outside anything poll lag explains.
    const { stats } = await judgeEngineChord([CHORD_T - 0.4, CHORD_T - 0.4]);
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 1);
});

test('scoreChord path: an EARLY strummed frame does not lock the chord in as a miss', async () => {
    const intervals = [];
    let hwTime = 0;
    let level = 0.01;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.highway.getNotes = () => ([]);
            sb.highway.getChords = () => ([{ t: CHORD_T, notes: CHART.map(({ s, f }) => ({ s, f })) }]);
            sb.highway.getTime = () => hwTime;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
                    getLevels: async () => ({ inputLevel: level, inputPeak: level, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    // The previous chord's identical shape is ringing: every
                    // frame in the window scores as the chord.
                    scoreChord: async (ctx) => ({
                        score: 1, hitStrings: ctx.notes.length, totalStrings: ctx.notes.length, isHit: true,
                        results: ctx.notes.map((n) => ({ s: n.s, f: n.f, hit: true, bandEnergy: 0.2, centsDiff: 0, centsError: 0 })),
                    }),
                },
            };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    // A player who tightened the chord hit window inside the match window:
    // frames 100–150 ms early are inside the window but EARLY.
    det.applySettings({
        timingTolerance: 0.15, timingHitThreshold: 0.08, chordTimingHitThreshold: 0.10, latencyOffset: 0,
    });
    await det.enable();
    await flush();

    const runAll = async () => {
        for (const cb of intervals) {
            // eslint-disable-next-line no-await-in-loop
            await cb();
            // eslint-disable-next-line no-await-in-loop
            await flush();
        }
    };
    // Frame 1: 130 ms early, with its own input-level attack, so the strum
    // gate (no ML onsets here) passes it and the chord judges EARLY. The
    // level poll runs after the detect poll, so a second pass sees the attack.
    hwTime = CHORD_T - 0.5;         // quiet, before the window: primes the level baseline
    await runAll();
    hwTime = CHORD_T - 0.13;
    level = 0.5;
    await runAll();
    await runAll();
    assert.equal(det.getStats().misses, 0, 'an EARLY strummed frame inside the window must not book a miss');
    level = 0.01;
    hwTime = CHORD_T - 0.06;
    await runAll();
    assert.equal(det.getStats().misses, 0, 'still no miss while the EARLY strum is the only one');
    // Frame 2: the on-time strum, a second attack.
    hwTime = CHORD_T;
    level = 0.5;
    await runAll();
    await runAll();
    const s = det.getStats();
    assert.equal(s.misses, 0, 'still no miss');
    assert.equal(s.hits, 1, 'the on-time strum counts');
    det.destroy();
    await flush();
});
