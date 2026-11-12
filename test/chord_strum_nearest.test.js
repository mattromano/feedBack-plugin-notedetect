// A strum belongs to the chart strike nearest it.
//
// In a riff of one repeated chord shape, the next chord's window opens up to
// timingTolerance (150 ms) before it, while the previous strum is still the
// freshest onset. The desktop chord path committed the next chord off that
// strum, booking it about one strum EARLY, and left the real strum for the
// chord after it. On a chord-heavy song the median timing read ~-120 ms EARLY
// while single notes in the same song read +21 ms (measured 2026-11-12).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flush(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Standard-tuning guitar: s0 f5 = A2 (45), s1 f7 = E3 (52).
const SHAPE = [{ s: 0, f: 5 }, { s: 1, f: 7 }];
const MIDIS = [45, 52];

function sandbox(chordTimes, { ml = true, latency = 0, settings = {}, voicing = false, levels = true, notes = [] } = {}) {
    const intervals = [];
    const judgments = [];
    let hwTime = 0;
    let poll = { seq: 0, ageMs: 0 };
    let level = 0.01;
    const { createNoteDetector, prevStrikeOfPitch, onsetNearerEarlierStrike } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.highway.getNotes = () => notes.map((n) => ({ ...n }));
            sb.highway.getChords = () => chordTimes.map((t) => ({ t, notes: SHAPE.map((n) => ({ ...n })) }));
            sb.highway.getTime = () => hwTime;
            sb.highway.getAvOffset = () => 0;
            sb.window.dispatchEvent = (ev) => {
                if (ev && (ev.type === 'notedetect:hit' || ev.type === 'notedetect:miss')) judgments.push(ev.detail);
                return true;
            };
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
                    // The shape rings through the whole riff: every frame scores.
                    scoreChord: async (ctx) => ({
                        score: 1, hitStrings: ctx.notes.length, totalStrings: ctx.notes.length, isHit: true, voicingHit: voicing,
                        results: ctx.notes.map((n) => ({ s: n.s, f: n.f, hit: true, bandEnergy: 0.2, centsDiff: 0, centsError: 0 })),
                    }),
                    // ml: false is a build whose ML transcriber is off.
                    detectNotes: async () => (ml ? {
                        notes: MIDIS.map((midi) => ({ midi, confidence: 0.95, onsetMs: poll.ageMs, onsetSeq: poll.seq })),
                        sampleRate: 48000,
                    } : null),
                },
            };
            // levels: false is a build with no input meter (no getLevels).
            if (!levels) delete sb.window.feedBackDesktop.audio.getLevels;
        },
    });
    const det = createNoteDetector({ isDefault: false });
    det.applySettings({
        timingTolerance: 0.15, timingHitThreshold: 0.1, chordTimingHitThreshold: 0.15, latencyOffset: latency, ...settings,
    });
    return {
        det, judgments, prevStrikeOfPitch, onsetNearerEarlierStrike,
        // One detect poll at song time `t` that sees a strum `ageMs` old
        // (a new onsetSeq) or nothing new (same seq).
        // `inputLevel` sets the guitar level (a jump is a level attack).
        async pollAt(t, { strumAgeMs = null, inputLevel = null } = {}) {
            hwTime = t;
            if (inputLevel !== null) level = inputLevel;
            if (strumAgeMs !== null) poll = { seq: poll.seq + 1, ageMs: strumAgeMs };
            for (const cb of intervals) {
                // eslint-disable-next-line no-await-in-loop
                await cb();
                // eslint-disable-next-line no-await-in-loop
                await flush();
            }
        },
    };
}

test('a strum seen while the next chord window is open goes to the chord it is nearest', async () => {
    // Chords 120 ms apart. The strum for the first lands at 1.005 but is only
    // seen at 1.08, when the second chord's window (opens 0.97) is open too.
    const env = sandbox([1.0, 1.12]);
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { strumAgeMs: 0 });          // primes the onset baseline
    await env.pollAt(1.08, { strumAgeMs: 75 });        // strum at 1.005
    await env.pollAt(1.13, { strumAgeMs: 5 });         // strum at 1.125
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.noteTime), [1.0, 1.12], 'each chord got its own strum');
    assert.deepEqual(hits.map((j) => j.timingError), [5, 5], 'neither chord is booked a strum early');
    env.det.destroy();
    await flush();
});

test('with an input latency, a strum still goes to the chord it is nearest', async () => {
    // Same riff as above with latencyOffset 80 ms: every poll is 80 ms later
    // on the playhead. The engine onset age is measured on the input, so the
    // strum's chart time must have the latency removed, or the strum for the
    // first chord reads 80 ms later, past the midpoint, and both chords book it.
    const env = sandbox([1.0, 1.12], { latency: 0.08 });
    await env.det.enable();
    await flush();
    await env.pollAt(0.58, { strumAgeMs: 0 });
    await env.pollAt(1.16, { strumAgeMs: 75 });        // strum at chart 1.005
    await env.pollAt(1.21, { strumAgeMs: 5 });         // strum at chart 1.125
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.noteTime), [1.0, 1.12], 'each chord got its own strum');
    assert.deepEqual(hits.map((j) => j.timingError), [5, 5], 'timed in chart time, latency removed');
    env.det.destroy();
    await flush();
});

test('a strum nearer the later chord still counts for it', async () => {
    // One strum 40 ms before the second chord (80 ms after the first): it is
    // the second chord's, played a little early.
    const env = sandbox([1.0, 1.12]);
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { strumAgeMs: 0 });
    await env.pollAt(1.0, { strumAgeMs: 0 });          // first chord on the beat
    await env.pollAt(1.1, { strumAgeMs: 20 });         // strum at 1.08
    const second = env.judgments.find((j) => j && j.chord && j.hit && j.noteTime === 1.12);
    assert.ok(second, 'the second chord is hit');
    assert.equal(second.timingError, -40);
    env.det.destroy();
    await flush();
});

test('_ndPrevStrikeOfPitch finds the last earlier strike sounding that pitch', () => {
    const { prevStrikeOfPitch: _ndPrevStrikeOfPitch } = sandbox([]);
    const midiOf = (n) => n.m;
    const notes = [{ t: 0.5, m: 45 }, { t: 0.9, m: 47 }, { t: 0.95, m: 45, mt: true }];
    const chords = [{ t: 0.7, notes: [{ m: 45 }, { m: 52 }] }, { t: 1.0, notes: [{ m: 45 }] }];
    assert.equal(_ndPrevStrikeOfPitch(notes, chords, 45, 1.0, midiOf, 1.0), 0.7, 'chord member, muted note skipped');
    assert.equal(_ndPrevStrikeOfPitch(notes, chords, 47, 1.0, midiOf, 1.0), 0.9);
    assert.equal(_ndPrevStrikeOfPitch(notes, chords, 45, 0.6, midiOf, 1.0), 0.5);
    assert.equal(_ndPrevStrikeOfPitch(notes, chords, 45, 1.0, midiOf, 0.2), null, 'outside the lookback');
    assert.equal(_ndPrevStrikeOfPitch(notes, chords, 60, 1.0, midiOf, 1.0), null);
});

test('_ndOnsetNearerEarlierStrike splits at the midpoint', () => {
    const { onsetNearerEarlierStrike: near } = sandbox([]);
    assert.equal(near(1.005, 1.12, 1.0), true);
    assert.equal(near(1.08, 1.12, 1.0), false);
    assert.equal(near(1.005, 1.12, null), false, 'no earlier strike: the onset is this chord\'s');
});

test('with the ML transcriber off, a ringing chord waits for its strum', async () => {
    // detectNotes resolves null (no ML model), so there are no engine onsets.
    // The shape rings through the riff and scores on every poll. Before, each
    // chord committed the moment its window opened: ~120-150 ms EARLY.
    const env = sandbox([1.0, 1.5], { ml: false });
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { inputLevel: 0.01 });
    await env.pollAt(0.86, { inputLevel: 0.01 });      // window open, shape ringing, no strum
    assert.equal(env.judgments.filter((j) => j && j.chord).length, 0, 'no chord committed without a strum');
    await env.pollAt(1.01, { inputLevel: 0.5 });       // strum
    await env.pollAt(1.02);
    await env.pollAt(1.36, { inputLevel: 0.3 });       // decaying ring: not an attack
    await env.pollAt(1.52, { inputLevel: 0.01 });
    await env.pollAt(1.53, { inputLevel: 0.6 });       // next strum
    await env.pollAt(1.54);
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.noteTime), [1.0, 1.5]);
    assert.deepEqual(hits.map((j) => j.timingError), [10, 30], 'each chord timed by its own strum');
    env.det.destroy();
    await flush();
});

test('_ndPickStrum takes the nearest unused strum that is not the previous chord one', () => {
    const { pickStrum } = loadDetectionCore();
    assert.equal(pickStrum([0.9, 1.01, 1.2], 1.0, 0.15, 1.1, null, new Set()), 1.01);
    assert.equal(pickStrum([0.9, 1.01], 1.0, 0.15, 1.1, null, new Set([1.01])), 0.9, 'used strum skipped');
    assert.equal(pickStrum([0.9], 1.0, 0.15, 1.1, 0.85, new Set()), null, 'nearer the previous strike at 0.85');
    assert.equal(pickStrum([1.05], 1.0, 0.15, 1.02, null, new Set()), null, 'not heard yet');
});

test('with no input meter, the level strum gate stays off', async () => {
    // No ML onsets and no getLevels: there can never be a level strum, so
    // the gate must not hold the chord back (it commits as before).
    const env = sandbox([1.0], { ml: false, levels: false });
    await env.det.enable();
    await flush();
    await env.pollAt(0.5);
    await env.pollAt(0.95);
    await env.pollAt(1.0);
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.noteTime), [1.0], 'the chord commits without a strum');
    env.det.destroy();
    await flush();
});

test('a loop wrap drops the previous pass\'s strums', async () => {
    // Pass 1: a stray attack at 0.90 and the real strum at 1.01; the strum
    // books the chord and the stray attack stays unused. After the drill
    // wraps back to 0.5 the player is silent: the old pass's attack must
    // not book the replayed chord.
    const env = sandbox([1.0], { ml: false });
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { inputLevel: 0.01 });
    await env.pollAt(0.90, { inputLevel: 0.5 });
    await env.pollAt(0.93, { inputLevel: 0.01 });
    await env.pollAt(1.01, { inputLevel: 0.5 });
    await env.pollAt(1.02, { inputLevel: 0.5 });
    await env.pollAt(1.6, { inputLevel: 0.01 });
    assert.equal(env.judgments.filter((j) => j && j.chord && j.hit).length, 1, 'pass 1 hits');
    const n1 = env.judgments.length;
    for (const t of [0.5, 0.7, 0.9, 0.96, 1.0, 1.05, 1.6]) {
        // eslint-disable-next-line no-await-in-loop
        await env.pollAt(t, { inputLevel: 0.01 });
    }
    const pass2 = env.judgments.slice(n1).filter((j) => j && j.chord);
    assert.ok(pass2.length > 0, 'the chord was reopened and retired');
    assert.equal(pass2.filter((j) => j.hit).length, 0, 'no hit from a stale strum');
    env.det.destroy();
    await flush();
});

test('an early attack waits for a nearer strum', async () => {
    // A stray attack 100 ms before the chord (inside the hit window) is
    // heard first; the real strum lands 10 ms after. The chord is the
    // strum's, not the first attack's.
    const env = sandbox([1.0], { ml: false });
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { inputLevel: 0.01 });
    await env.pollAt(0.90, { inputLevel: 0.5 });       // stray attack
    await env.pollAt(0.93, { inputLevel: 0.01 });
    await env.pollAt(0.97, { inputLevel: 0.01 });
    assert.equal(env.judgments.filter((j) => j && j.chord).length, 0, 'the early attack does not commit yet');
    await env.pollAt(1.01, { inputLevel: 0.5 });       // the strum
    await env.pollAt(1.02, { inputLevel: 0.5 });
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.timingError), [10], 'timed by the nearer strum');
    env.det.destroy();
    await flush();
});

test('an early attack with no nearer strum commits once none can come', async () => {
    const env = sandbox([1.0], { ml: false });
    await env.det.enable();
    await flush();
    await env.pollAt(0.5, { inputLevel: 0.01 });
    await env.pollAt(0.94, { inputLevel: 0.5 });       // strum 60 ms early
    await env.pollAt(1.0, { inputLevel: 0.3 });
    assert.equal(env.judgments.filter((j) => j && j.chord).length, 0, 'still waiting at the strike');
    await env.pollAt(1.07, { inputLevel: 0.2 });       // 70 ms past: no nearer strum is possible
    const hits = env.judgments.filter((j) => j && j.chord && j.hit);
    assert.deepEqual(hits.map((j) => j.timingError), [-60]);
    env.det.destroy();
    await flush();
});

test('_ndStrumSettled', () => {
    const { strumSettled } = loadDetectionCore();
    assert.equal(strumSettled(1.01, 1.0, 1.01), true, 'at or after the strike');
    assert.equal(strumSettled(0.9, 1.0, 1.05), false, 'a strum before 1.1 could still be nearer');
    assert.equal(strumSettled(0.9, 1.0, 1.1), true);
});

test('with the strum gate on, an EARLY ring does not pin the voicing rescue', async () => {
    // The shape rings through the window at a steady level (no attack the
    // gate can see). The chord retires through the voicing rescue, judged
    // at the first frame inside the hit window, not at the -140 ms ring.
    const env = sandbox([2.0], {
        ml: false, voicing: true,
        settings: { timingHitThreshold: 0.08, chordTimingHitThreshold: 0.10 },
    });
    await env.det.enable();
    await flush();
    for (const t of [1.4, 1.86, 1.95, 2.0, 2.05, 2.4, 2.8, 3.2]) {
        // eslint-disable-next-line no-await-in-loop
        await env.pollAt(t, { inputLevel: 0.3 });
    }
    const chords = env.judgments.filter((j) => j && j.chord);
    assert.equal(chords.length, 1);
    assert.equal(chords[0].hit, true, 'rescued as a hit');
    assert.equal(chords[0].timingError, -50, 'judged at the first in-window frame');
    env.det.destroy();
    await flush();
});
