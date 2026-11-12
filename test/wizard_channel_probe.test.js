// Calibration wizard input-channel auto-detect on an aggregate device.
//
// ASIO4ALL with a USB headset and a guitar cable both enabled exposes the
// headset mic as Ch 1/2 and the guitar as Ch 3. The probe only tried
// Mono/Ch 1/Ch 2, so it never heard the guitar, and it left the engine on the
// last channel tried, which silenced the monitored guitar until the user reset
// the channel. Runs the real auto-detect against a fake engine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8').replace(/\r\n/g, '\n');

function extractFunction(name) {
    const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
    assert.ok(m, `function ${name} not found`);
    let i = SRC.indexOf('{', SRC.indexOf(')', m.index)) + 1;
    let depth = 1;
    while (depth > 0) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
    }
    return SRC.slice(m.index, i);
}

function extractConst(name) {
    const start = SRC.indexOf(`const ${name} =`);
    assert.ok(start !== -1, `const ${name} not found`);
    return SRC.slice(start, SRC.indexOf(';', start) + 1);
}

const FUNCS = [
    '_calWizardEngineChannelLabel', '_calWizardEngineChannelDisplayLabel',
    '_calWizardPluginChannelFromEngine', '_calWizardProbeChannelSteps',
    '_calWizardEngineInputChannelNames', '_calWizardSavedEngineInputChannel',
    '_calWizardTrialByCh', '_calWizardLevelsClose', '_calWizardPickChannelProbeWinner',
    '_calWizardAnalyzeChannelProbeTrials', '_calWizardChannelProbeProgressLabel',
    '_calWizardWizardAudioApi', '_calWizardApplyEngineInputChannel', '_calWizardAutoDetectInputChannel',
    '_calWizardProbeRestoreChannel', '_calWizardChannelProbePickHtml', '_calWizardFormatChannelProbeResult',
    '_calWizardChannelProbeTrialsSummary', '_calWizardChannelProbeTrialShortLabel',
];
const CONSTS = [
    '_CAL_WIZARD_INPUT_CHANNEL_OPTIONS', '_CAL_WIZARD_CHANNEL_PROBE_MAX_INPUTS',
    '_CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK', '_CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO',
];

// A fake engine: `levels[ch]` is what getLevels() reads while on channel ch.
function fakeEngine({ names, levels, saved = '2', liveChannel }) {
    const eng = {
        channel: saved == null || saved === '' ? -1 : Number(saved),
        setCalls: [],
        savedChannel: saved,
        async getCurrentDevice() {
            const dev = { type: 'ASIO', inputType: 'ASIO', outputType: 'ASIO', input: 'ASIO4ALL v2', output: 'ASIO4ALL v2' };
            if (liveChannel !== undefined) dev.inputChannel = liveChannel;
            return dev;
        },
        async probeDeviceOptions() { return { compatible: true, inputChannels: names }; },
        async setInputChannel(ch) { eng.channel = ch; eng.setCalls.push(ch); },
        async resetPeaks() {},
        async getLevels() { const l = levels[eng.channel] || 0; return { inputLevel: l, inputPeak: l }; },
        async loadDeviceSettings() { return { inputChannel: eng.savedChannel }; },
        async saveDeviceSettings(s) { eng.savedChannel = s.inputChannel; },
    };
    return eng;
}

function load(engine) {
    const ctx = {
        Number, Math, String, Array, Object, Promise, Date, console,
        usingDesktopBridge: true,
        bridgeDesktop: { audio: engine },
        window: {},
        selectedChannel: 'mono',
        saveSettings() {},
        renderCalibrationWizard() {},
        _calWizardRefreshLive() {},
        _calWizardSetChannelProbeStatus() {},
        getCalibrationSnapshot: () => ({ enabled: true }),
        _calWizardSleep: () => Promise.resolve(),
        _CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS: 0,
        _CAL_WIZARD_CHANNEL_PROBE_MS: 0,
        _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS: 0,
        _calWizardChannelProbeGen: 0,
        _calWizardState: { channelProbeRunning: false, channelProbeResult: null, channelProbeError: null, channelProbeAbort: null },
    };
    // One getLevels() sample per channel step. While `ctx.gate` is true each
    // sample parks until the test calls one of the `ctx.parked` resolvers, so a
    // test can hold a run mid-step (to cancel it and start another).
    ctx.gate = false;
    ctx.parked = [];
    ctx._calWizardSampleEngineLevels = async () => {
        if (ctx.gate) await new Promise((resolve) => ctx.parked.push(resolve));
        const lv = await engine.getLevels();
        return { maxLevel: lv.inputLevel, avgLevel: lv.inputLevel, maxPeak: lv.inputPeak };
    };
    const code = [
        ...CONSTS.map((c) => extractConst(c).replace(/^const /, 'var ')),
        ...FUNCS.map(extractFunction),
        'this.api = { autoDetect: _calWizardAutoDetectInputChannel, steps: _calWizardProbeChannelSteps,'
            + ' analyze: _calWizardAnalyzeChannelProbeTrials, pickHtml: _calWizardChannelProbePickHtml,'
            + ' format: _calWizardFormatChannelProbeResult };',
    ].join('\n');
    vm.runInNewContext(code, ctx);
    return ctx;
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const ASIO4ALL = ['PRO Mic 1', 'PRO Mic 2', 'USB Audio Device 1', 'USB Audio Device 2'];

test('a two-input device keeps the Mono / Ch 1 / Ch 2 probe', () => {
    const ctx = load(fakeEngine({ names: ['In 1', 'In 2'], levels: {} }));
    assert.deepEqual(plain(ctx.api.steps(['In 1', 'In 2'])).map((s) => s.ch), [-1, 0, 1]);
    assert.deepEqual(plain(ctx.api.steps([])).map((s) => s.ch), [-1, 0, 1], 'unknown channel names');
});

test('an aggregate device probes every input it reports', () => {
    const ctx = load(fakeEngine({ names: ASIO4ALL, levels: {} }));
    const steps = plain(ctx.api.steps(ASIO4ALL));
    assert.deepEqual(steps.map((s) => s.ch), [-1, 0, 1, 2, 3]);
    assert.match(steps[3].label, /Ch 3.*USB Audio Device 1/);
    const many = plain(ctx.api.steps(Array.from({ length: 20 }, (_, i) => `In ${i}`)));
    assert.equal(many.length, 1 + 8, 'capped at 8 inputs');
});

test('finds the guitar on Ch 3 and keeps it', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: { [-1]: 0.02, 0: 0.02, 1: 0.02, 2: 0.6, 3: 0.01 } });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    const r = ctx._calWizardState.channelProbeResult;
    assert.equal(r.ok, true);
    assert.equal(r.bestCh, 2);
    assert.equal(eng.channel, 2, 'engine left on the guitar');
    assert.equal(eng.savedChannel, '2');
});

test('a headset mic that hears the strum does not make Ch 1/2 "ambiguous" over Ch 3', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: { [-1]: 0.15, 0: 0.15, 1: 0.15, 2: 0.7, 3: 0.01 } });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    assert.equal(ctx._calWizardState.channelProbeResult.ok, true);
    assert.equal(eng.channel, 2);
});

test('no signal anywhere puts the original channel back', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {} });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    assert.equal(ctx._calWizardState.channelProbeResult.ok, false);
    assert.equal(eng.channel, 2, 'guitar channel restored, not left on the last probe');
    assert.equal(eng.setCalls.at(-1), 2);
});

test('an ambiguous Ch 1 / Ch 2 result puts the original channel back until the user picks', async () => {
    const eng = fakeEngine({ names: ['In 1', 'In 2'], levels: { [-1]: 0.5, 0: 0.5, 1: 0.5 }, saved: '0' });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    assert.equal(ctx._calWizardState.channelProbeResult.ok, 'ambiguous');
    assert.equal(eng.channel, 0, 'not left on Ch 2, the last channel tried');
});

test('a failing probe puts the original channel back', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {} });
    eng.getLevels = async () => { throw new Error('engine gone'); };
    const ctx = load(eng);
    ctx._calWizardSampleEngineLevels = async () => { throw new Error('engine gone'); };
    await ctx.api.autoDetect();
    assert.equal(ctx._calWizardState.channelProbeError, 'engine gone');
    assert.equal(eng.channel, 2);
});

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// What the wizard's cancel/close does to a running probe in screen.js.
function cancel(ctx) {
    ctx._calWizardState.channelProbeAbort = null;
    ctx._calWizardState.channelProbeRunning = false;
}

test('a cancelled run that wakes during a newer run leaves the engine channel alone', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {}, saved: '0' });
    const ctx = load(eng);
    ctx.gate = true;
    const runA = ctx.api.autoDetect();
    await flush();
    assert.equal(ctx.parked.length, 1, 'run A parked in its first sample');
    cancel(ctx);
    const runB = ctx.api.autoDetect();
    await flush();
    assert.equal(ctx.parked.length, 2, 'run B parked in its first sample');
    assert.equal(eng.channel, -1, 'run B is on its Mono step');
    ctx.parked[0]();
    await runA;
    assert.equal(eng.channel, -1, 'run A did not switch the engine back under run B');
    assert.equal(ctx._calWizardState.channelProbeRunning, true, 'run B still marked running');
    ctx.gate = false;
    ctx.parked[1]();
    await runB;
    assert.equal(eng.channel, 0, 'run B restores the saved channel itself');
    assert.equal(ctx._calWizardState.channelProbeRunning, false);
});

test('a cancelled run does not undo a channel the user saved meanwhile', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {}, saved: '2' });
    const ctx = load(eng);
    ctx.gate = true;
    const run = ctx.api.autoDetect();
    await flush();
    cancel(ctx);
    // The user picks Input 4 on the Audio screen while the run is parked.
    await eng.setInputChannel(3);
    await eng.saveDeviceSettings({ inputChannel: '3' });
    ctx.gate = false;
    ctx.parked[0]();
    await run;
    assert.equal(eng.channel, 3);
    assert.equal(eng.savedChannel, '3');
});

test('a cancelled run with nothing changed meanwhile still restores the channel', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {}, saved: '2' });
    const ctx = load(eng);
    ctx.gate = true;
    const run = ctx.api.autoDetect();
    await flush();
    cancel(ctx);
    ctx.gate = false;
    ctx.parked[0]();
    await run;
    assert.equal(eng.channel, 2, 'not left on the Mono step');
});

test('with no saved channel, a no-result probe falls back to Mono', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {}, saved: null });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    assert.equal(ctx._calWizardState.channelProbeResult.ok, false);
    assert.equal(eng.channel, -1, 'not left on Ch 4, the last channel tried');
});

test('with no saved channel, the live channel the engine reports wins over Mono', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: {}, saved: '', liveChannel: 2 });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    assert.equal(eng.channel, 2);
});

test('a guitar heard on both Ch 3 and Ch 4 is ambiguous, not a silent pick', async () => {
    const eng = fakeEngine({ names: ASIO4ALL, levels: { [-1]: 0.3, 0: 0.02, 1: 0.02, 2: 0.6, 3: 0.58 }, saved: '0' });
    const ctx = load(eng);
    await ctx.api.autoDetect();
    const r = ctx._calWizardState.channelProbeResult;
    assert.equal(r.ok, 'ambiguous');
    assert.equal(r.suggestedCh, 2);
    assert.equal(r.alternateCh, 3);
    assert.equal(eng.channel, 0, 'original channel back until the user picks');
    const html = ctx.api.pickHtml(r);
    assert.match(html, /data-ch="2"/);
    assert.match(html, /data-ch="3"/);
    assert.doesNotMatch(html, /Dry \/ Clean/);
    assert.match(ctx.api.format(r), /Ch 3 and Ch 4 are very close/);
});

test('the tie check uses the two loudest inputs, not Ch 1 / Ch 2', () => {
    const ctx = load(fakeEngine({ names: ASIO4ALL, levels: {} }));
    const t = (ch, l) => ({ ch, label: String(ch), maxLevel: l, avgLevel: l, maxPeak: l });
    // Headset mic close on Ch 1/2, guitar well clear on Ch 3: a clear answer.
    let a = plain(ctx.api.analyze([t(-1, 0.2), t(0, 0.15), t(1, 0.15), t(2, 0.7)]));
    assert.equal(a.ambiguous, false);
    assert.equal(a.best.ch, 2);
    // Two-input device, exact tie: still ambiguous, Ch 2 suggested (Spark LIVE).
    a = plain(ctx.api.analyze([t(-1, 0.5), t(0, 0.5), t(1, 0.5)]));
    assert.equal(a.ambiguous, true);
    assert.equal(a.suggested.ch, 1);
    assert.equal(a.alternate.ch, 0);
    const html = ctx.api.pickHtml({ suggestedCh: 1, alternateCh: 0 });
    assert.match(html, /data-ch="0">Ch 1 — Dry \/ Clean/);
    assert.match(html, /data-ch="1">Ch 2 — Wet \/ FX/);
    assert.match(ctx.api.format({ ok: 'ambiguous', suggestedCh: 1, alternateCh: 0, trials: [] }), /Ch 1 and Ch 2 are very close/);
});
