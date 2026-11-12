// Palm mutes reach the engine verifier.
//
// A palm-muted chug is a short damped thud with little pitch, so the engine's
// harmonic comb often hears none of its strings: on a chugged C5 riff about
// 1 in 3 palm-muted chords scored 0/2 strings and were missed (measured
// 2026-11-12). The engine counts a palm-muted note on its pick attack instead,
// but only if the chart it is sent says which notes are palm-muted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flush(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

test('the chart pushed to the engine verifier carries the palm-mute flag', async () => {
    const intervals = [];
    let pushed = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            sb.highway.getNotes = () => ([
                { t: 1.0, s: 0, f: 3, sus: 0, pm: true },
                { t: 2.0, s: 0, f: 5, sus: 0 },
            ]);
            sb.highway.getChords = () => ([
                { t: 3.0, notes: [{ s: 1, f: 3, pm: true }, { s: 2, f: 5, pm: true }] },
            ]);
            sb.highway.getTime = () => 0;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getLevels: async () => ({ inputLevel: 0.3, inputPeak: 0.4, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
                    setChart: async (chart) => { pushed = chart; return true; },
                    getNoteVerdicts: async () => [],
                },
            };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flush();
    for (let i = 0; i < 3 && !pushed; i++) {
        for (const cb of intervals) {
            // eslint-disable-next-line no-await-in-loop
            await cb();
            // eslint-disable-next-line no-await-in-loop
            await flush();
        }
    }
    assert.ok(pushed, 'the chart was pushed to the engine');
    const byT = (t, s) => Array.from(pushed.notes).find((n) => n.t === t && n.s === s);
    assert.equal(byT(1.0, 0).pm, true, 'palm-muted single note');
    assert.equal(byT(2.0, 0).pm, false, 'ringing single note');
    assert.equal(byT(3.0, 1).pm, true, 'palm-muted chord member');
    assert.equal(byT(3.0, 2).pm, true, 'palm-muted chord member');
    det.destroy();
    await flush();
});
