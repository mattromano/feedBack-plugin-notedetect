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
];
const CONSTS = [
    '_CAL_WIZARD_INPUT_CHANNEL_OPTIONS', '_CAL_WIZARD_CHANNEL_PROBE_MAX_INPUTS',
    '_CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK', '_CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO',
];

// A fake engine: `levels[ch]` is what getLevels() reads while on channel ch.
function fakeEngine({ names, levels, saved = '2' }) {
    const eng = {
        channel: Number(saved),
        setCalls: [],
        savedChannel: saved,
        async getCurrentDevice() { return { type: 'ASIO', inputType: 'ASIO', outputType: 'ASIO', input: 'ASIO4ALL v2', output: 'ASIO4ALL v2' }; },
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
        _calWizardState: { channelProbeRunning: false, channelProbeResult: null, channelProbeError: null, channelProbeAbort: null },
    };
    // One getLevels() sample per channel step.
    ctx._calWizardSampleEngineLevels = async () => {
        const lv = await engine.getLevels();
        return { maxLevel: lv.inputLevel, avgLevel: lv.inputLevel, maxPeak: lv.inputPeak };
    };
    const code = [
        ...CONSTS.map((c) => extractConst(c).replace(/^const /, 'var ')),
        ...FUNCS.map(extractFunction),
        'this.api = { autoDetect: _calWizardAutoDetectInputChannel, steps: _calWizardProbeChannelSteps };',
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
