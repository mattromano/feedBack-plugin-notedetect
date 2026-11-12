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

function sandbox(chordTimes) {
    const intervals = [];
    const judgments = [];
    let hwTime = 0;
    let poll = { seq: 0, ageMs: 0 };
    const { createNoteDetector, prevStrikeOfPitch, onsetNearerEarlierStrike } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.highway.getNotes = () => ([]);
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
                    getLevels: async () => ({ inputLevel: 0.2, inputPeak: 0.3, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    // The shape rings through the whole riff: every frame scores.
                    scoreChord: async (ctx) => ({
                        score: 1, hitStrings: ctx.notes.length, totalStrings: ctx.notes.length, isHit: true,
                        results: ctx.notes.map((n) => ({ s: n.s, f: n.f, hit: true, bandEnergy: 0.2, centsDiff: 0, centsError: 0 })),
                    }),
                    detectNotes: async () => ({
                        notes: MIDIS.map((midi) => ({ midi, confidence: 0.95, onsetMs: poll.ageMs, onsetSeq: poll.seq })),
                        sampleRate: 48000,
                    }),
                },
            };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    det.applySettings({ timingTolerance: 0.15, timingHitThreshold: 0.1, chordTimingHitThreshold: 0.15, latencyOffset: 0 });
    return {
        det, judgments, prevStrikeOfPitch, onsetNearerEarlierStrike,
        // One detect poll at song time `t` that sees a strum `ageMs` old
        // (a new onsetSeq) or nothing new (same seq).
        async pollAt(t, { strumAgeMs = null } = {}) {
            hwTime = t;
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
