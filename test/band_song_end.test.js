// Band mode (setScoreHudHidden) at song:ended: the take is credited, but the
// user's Detect state is left alone and no summary is shown. A real gig set
// keeps its behaviour (XP, no summary, detector torn down). Runs the real
// enable() path through the desktop bridge, no audio and no getUserMedia.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flush(turns = 8) {
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

function setup({ gig = false } = {}) {
    const runs = [];
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async () => true,
        getNoteVerdicts: async () => [],
    };
    const env = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic'));
            sandbox.setInterval = () => 0;
            sandbox.dispatchEvent = () => true;
            sandbox.highway.getSongInfo = () => ({ arrangement: 'lead', stringCount: 6, tuningOffsets: [0, 0, 0, 0, 0, 0], capo: 0 });
            sandbox.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
            sandbox.slopsmithMinigames = {
                submitRun: async (p) => { runs.push(p); return { ok: true, xp_gained: 1, profile: { level: 1 } }; },
            };
            if (gig) {
                sandbox.window.feedBack = { playQueue: { active: () => true, source: () => 'gig' } };
            }
        },
    });
    env.slopsmith._autoplayExit = true; // a built natural-end summary would claim the exit
    return { env, runs };
}

function seed(det, n = 6) {
    for (let i = 0; i < n; i++) {
        det._recordJudgment(`k${i}`, { hit: true, note: { s: 1, f: 0 }, noteTime: 0, judgedAt: 0 });
    }
}

test('band mode: song:ended credits XP, keeps detection ON, shows no summary', async () => {
    const { env, runs } = setup();
    const det = env.createNoteDetector({ isDefault: true });
    await det.enable();
    await flush();
    assert.equal(det.isEnabled(), true);
    det.setScoreHudHidden(true);
    seed(det);

    env.slopsmith._fire('song:ended', {});
    await flush();

    assert.equal(runs.length, 1, 'XP credited once');
    assert.equal(det.isEnabled(), true, 'the user\'s Detect state is untouched');
    assert.equal(det.wantsDetect(), true, 'preference untouched');
    assert.equal(env.slopsmith._holdCount, 0, 'no summary built (it would claim auto-exit)');

    det.destroy();
    await flush();
});

test('band mode: a take under the summary threshold earns no XP but still stays enabled', async () => {
    const { env, runs } = setup();
    const det = env.createNoteDetector({ isDefault: true });
    await det.enable();
    await flush();
    det.setScoreHudHidden(true);
    seed(det, 2);
    env.slopsmith._fire('song:ended', {});
    await flush();
    assert.equal(runs.length, 0);
    assert.equal(det.isEnabled(), true);
    det.destroy();
    await flush();
});

test('gig set (unchanged): XP, no summary, detector torn down, preference kept', async () => {
    const { env, runs } = setup({ gig: true });
    const det = env.createNoteDetector({ isDefault: true });
    await det.enable();
    await flush();
    seed(det);

    env.slopsmith._fire('song:ended', {});
    await flush();

    assert.equal(runs.length, 1);
    assert.equal(det.isEnabled(), false, 'gig path still disables between songs');
    assert.equal(det.wantsDetect(), true, 'silent disable never touches the preference');
    assert.equal(env.slopsmith._holdCount, 0);
    det.destroy();
    await flush();
});

test('normal song (no band, no gig): summary built and detector disabled', async () => {
    const { env } = setup();
    const det = env.createNoteDetector({ isDefault: true });
    await det.enable();
    await flush();
    seed(det);
    env.slopsmith._fire('song:ended', {});
    await flush();
    assert.equal(det.isEnabled(), false);
    assert.equal(env.slopsmith._holdCount, 1, 'summary built and claimed auto-exit');
    det.destroy();
    await flush();
});
