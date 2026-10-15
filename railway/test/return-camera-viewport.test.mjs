import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const line = name => html.split('\n').find(x => x.startsWith('function '+name+'(') || x.startsWith('async function '+name+'('));

for (const [start, stop, resultId, videoId, inputId, lookup] of [
  ['startKaspiReturnScan', 'stopKaspiReturnScan', 'kaspiReturnResult', 'kaspiReturnVideo', 'kaspiReturnCode', 'lookupKaspiReturn'],
  ['startWbReturnScan', 'stopWbReturnScan', 'wbReturnResult', 'wbReturnVideo', 'wbReturnCode', 'lookupWbReturn'],
  ['startWbQrIdentifyScan', 'stopWbReturnScan', 'wbQrIdentifyResult', 'wbQrIdentifyVideo', null, 'identifyWbQr'],
]) {
  test(start+' reveals a bounded complete preview before camera permission and retains recognition/cleanup', async () => {
    const calls = [], input = {}, video = { readyState: 4, async play() { calls.push('play'); } };
    const box = { innerHTML: '', scrollIntoView(options) { calls.push(['scroll', options]); } };
    const stream = { getTracks: () => [{ stop() { calls.push('stop'); } }] };
    let scan;
    class Detector {
      static async getSupportedFormats() { return ['qr_code', 'code_128']; }
      async detect(v) { assert.equal(v, video); return [{ rawValue: '1108602755' }]; }
    }
    const ctx = {
      window: { BarcodeDetector: Detector }, BarcodeDetector: Detector,
      navigator: { mediaDevices: { async getUserMedia(options) { calls.push('permission'); assert.equal(options.video.facingMode.ideal, 'environment'); assert.equal(options.audio, false); return stream; } } },
      document: { getElementById(id) { return id === resultId ? box : id === videoId ? video : id === inputId ? input : null; } },
      setInterval(fn) { scan = fn; return 1; }, clearInterval() { calls.push('clear'); },
      alert(message) { throw Error(message); }, isWbMarket: () => true, returnMarketLabel: () => 'WB2', esc: x => String(x),
      [lookup]: async value => { calls.push(['lookup', value]); },
    };
    vm.runInNewContext('let returnOrderMarket="WB2",wbQrIdentified=null,kaspiReturnScannerStream=null,kaspiReturnScannerTimer=0,wbReturnScannerStream=null,wbReturnScannerTimer=0;\n'+line(stop)+'\n'+line(start), ctx);
    await ctx[start]();
    assert.equal(calls[0][0], 'scroll');
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { block: 'start', behavior: 'smooth' });
    assert.ok(calls.indexOf('permission') > 0);
    assert.match(box.innerHTML, /height:40vh;max-height:320px;object-fit:contain/);
    assert.equal(video.srcObject, stream);
    await scan();
    assert.ok(calls.includes('stop')); assert.ok(calls.includes('clear'));
    assert.deepEqual(calls.find(x => Array.isArray(x) && x[0] === 'lookup'), ['lookup', '1108602755']);
    if (inputId) assert.equal(input.value, '1108602755');
    ctx[stop]();
    assert.equal(calls.filter(x => x === 'stop').length, 1);
  });
}
