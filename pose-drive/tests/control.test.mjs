import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, MOVEMENT, normalizeModelURL, suggestCommand, PoseGate, CommandChannel } from '../control.mjs';

const pose = (command, confidence = 0.95, posePresent = true) => ({ command, confidence, posePresent });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('model URLs normalize only known HTTPS shared models', () => {
  const base = 'https://teachablemachine.withgoogle.com/models/bqZqF3_sY/';
  assert.equal(normalizeModelURL(base), base);
  assert.equal(normalizeModelURL(base.slice(0, -1)), base);
  assert.equal(normalizeModelURL(`${base}model.json?refresh=1#x`), base);
  assert.equal(normalizeModelURL(`${base}metadata.json`), base);
  for (const bad of ['http://teachablemachine.withgoogle.com/models/a/', 'https://example.com/models/a/',
    'https://teachablemachine.withgoogle.com.evil.com/models/a/',
    'https://user@teachablemachine.withgoogle.com/models/a/',
    'https://teachablemachine.withgoogle.com:444/models/a/',
    'https://teachablemachine.withgoogle.com/train/pose', 'not a URL']) {
    assert.throws(() => normalizeModelURL(bad));
  }
});

test('class mapping never guesses arbitrary pose classes or treats B as servo', () => {
  assert.equal(suggestCommand(' B '), 'B');
  assert.equal(suggestCommand('전진'), 'F');
  assert.equal(suggestCommand('Turn Left'), 'L');
  assert.equal(suggestCommand('오른쪽'), 'R');
  assert.equal(suggestCommand('NOT'), 'STOP');
  assert.equal(suggestCommand('Class 1'), 'STOP');
  assert.equal(suggestCommand('양손을 들어요'), 'STOP');
  assert.equal(COMMANDS.B, '후진');
  assert.deepEqual([...MOVEMENT], ['F', 'B', 'L', 'R']);
});

test('movement requires a continuous stable pose; repeated output is suppressed', () => {
  const gate = new PoseGate();
  assert.equal(gate.update(pose('F'), 0), null);
  assert.equal(gate.update(pose('F'), 249), null);
  assert.equal(gate.update(pose('F'), 250), 'F');
  assert.equal(gate.update(pose('F'), 500), null);
  assert.equal(gate.update(pose('L'), 600), null);
  assert.equal(gate.update(pose('F'), 700), null);
  assert.equal(gate.update(pose('L'), 800), null);
  assert.equal(gate.update(pose('L'), 1050), 'L');
});

test('confident STOP is immediate and reset requires fresh stabilization', () => {
  const gate = new PoseGate();
  gate.update(pose('F'), 0);
  assert.equal(gate.update(pose('F'), 250), 'F');
  assert.equal(gate.update(pose('STOP'), 251), 'STOP');
  assert.equal(gate.update(pose('STOP'), 252), null);
  gate.update(pose('B'), 300);
  gate.reset();
  assert.equal(gate.update(pose('B'), 600), null);
  assert.equal(gate.update(pose('B'), 850), 'B');
});

test('low-confidence frames cannot extend movement and clear stability candidates', () => {
  const gate = new PoseGate();
  gate.update(pose('F'), 0);
  assert.equal(gate.update(pose('F'), 250), 'F');
  assert.equal(gate.update(pose('L', 0.3), 400), null);
  assert.equal(gate.update(pose('F', 0.3), 650), null);
  assert.equal(gate.update(pose('F', 0.3), 700), 'STOP');
  assert.equal(gate.update(pose('F'), 701), null);
  assert.equal(gate.update(pose('F'), 951), 'F');
});

test('no-pose and stalled inference both stop exactly once', () => {
  const gate = new PoseGate();
  gate.update(pose('R'), 0);
  gate.update(pose('R'), 250);
  assert.equal(gate.update(pose('R', 0.99, false), 699), null);
  assert.equal(gate.tick(700), 'STOP');
  assert.equal(gate.tick(900), null);
  gate.update(pose('R'), 1000);
  gate.update(pose('R'), 1250);
  assert.equal(gate.tick(1700), 'STOP');
});

test('alternating confident candidates cannot keep an old movement running', () => {
  const gate = new PoseGate();
  gate.update(pose('F'), 0);
  assert.equal(gate.update(pose('F'), 250), 'F');
  assert.equal(gate.update(pose('L'), 300), null);
  assert.equal(gate.update(pose('R'), 400), null);
  assert.equal(gate.update(pose('L'), 500), null);
  assert.equal(gate.update(pose('R'), 600), null);
  assert.equal(gate.update(pose('L'), 700), 'STOP');
  assert.equal(gate.update(pose('R'), 800), null);
  assert.equal(gate.current, 'STOP');
});

test('a long stable candidate survives the previous movement timing out', () => {
  const gate = new PoseGate({ stableMs: 600, lossMs: 450 });
  for (const time of [0, 200, 400]) assert.equal(gate.update(pose('F'), time), null);
  assert.equal(gate.update(pose('F'), 600), 'F');
  for (const time of [650, 850, 1049]) assert.equal(gate.update(pose('L'), time), null);
  assert.equal(gate.tick(1050), 'STOP');
  assert.equal(gate.update(pose('L'), 1100), null);
  assert.equal(gate.update(pose('L'), 1250), 'L');
  assert.equal(gate.update(pose('L'), 1500), null);
  assert.equal(gate.tick(1949), null);
  assert.equal(gate.tick(1950), 'STOP');
});

test('missing observations do not count as a continuous stable hold', () => {
  const gate = new PoseGate({ stableMs: 600 });
  assert.equal(gate.update(pose('F'), 0), null);
  assert.equal(gate.update(pose('F'), 700), null);
  assert.equal(gate.update(pose('F'), 1000), null);
  assert.equal(gate.update(pose('F'), 1300), 'F');
});

test('auxiliary actions are edge-triggered and must stabilize again after STOP', () => {
  const gate = new PoseGate();
  gate.update(pose('C'), 0);
  assert.equal(gate.update(pose('C'), 250), 'C');
  assert.equal(gate.update(pose('C'), 1000), null);
  assert.equal(gate.update(pose('STOP'), 1001), 'STOP');
  assert.equal(gate.update(pose('C'), 1002), null);
  assert.equal(gate.update(pose('C'), 1252), 'C');
});

test('writes serialize; STOP drops pending movement and precedes newer movement', async () => {
  const writes = [], sent = [], pending = [];
  let overlap = 0, peak = 0;
  const channel = new CommandChannel({
    write: async (bytes) => {
      overlap++; peak = Math.max(peak, overlap);
      writes.push(new TextDecoder().decode(bytes));
      const d = deferred(); pending.push(d); await d.promise; overlap--;
    },
    onSent: (command) => sent.push(command),
  });
  const f = channel.request('F');
  const l = channel.request('L');
  const stop = channel.request('STOP', { reason: 'release' });
  const b = channel.request('B');
  assert.equal(await l, false);
  assert.deepEqual(writes, ['F\n']);
  pending[0].resolve(); await flush();
  assert.deepEqual(writes, ['F\n', 'STOP\n']);
  pending[1].resolve(); await flush();
  assert.deepEqual(writes, ['F\n', 'STOP\n', 'B\n']);
  pending[2].resolve();
  assert.deepEqual(await Promise.all([f, stop, b]), [true, true, true]);
  assert.equal(peak, 1);
  assert.deepEqual(sent, ['F', 'STOP', 'B']);
});

test('latest queued command wins and repeated commands deduplicate unless forced', async () => {
  const writes = [], first = deferred();
  const channel = new CommandChannel({ write: async (bytes) => {
    writes.push(new TextDecoder().decode(bytes));
    if (writes.length === 1) await first.promise;
  } });
  const f = channel.request('F');
  const duplicate = channel.request('F');
  const l = channel.request('L');
  const r = channel.request('R');
  assert.equal(await l, false);
  first.resolve();
  assert.deepEqual(await Promise.all([f, duplicate, r]), [true, true, true]);
  assert.equal(await channel.request('R'), true);
  assert.deepEqual(writes, ['F\n', 'R\n']);
  await channel.request('R', { force: true });
  assert.deepEqual(writes, ['F\n', 'R\n', 'R\n']);
});

test('a second STOP while one is active cancels queued restart', async () => {
  const first = deferred(), writes = [];
  const channel = new CommandChannel({ write: async (bytes) => {
    writes.push(new TextDecoder().decode(bytes)); await first.promise;
  } });
  const stop1 = channel.request('STOP');
  const f = channel.request('F');
  const stop2 = channel.request('STOP');
  assert.equal(await f, false);
  first.resolve();
  assert.deepEqual(await Promise.all([stop1, stop2]), [true, true]);
  assert.deepEqual(writes, ['STOP\n']);
});

test('closing settles requests immediately and suppresses stale write success', async () => {
  const first = deferred(), sent = [], errors = [];
  const channel = new CommandChannel({ write: () => first.promise,
    onSent: (command) => sent.push(command), onError: (error) => errors.push(error) });
  const f = channel.request('F');
  const stop = channel.request('STOP');
  channel.close();
  assert.deepEqual(await Promise.all([f, stop]), [false, false]);
  first.resolve(); await flush();
  assert.deepEqual(sent, []);
  assert.deepEqual(errors, []);
  assert.equal(await channel.request('L'), false);
});

test('write failure closes channel and settles all requests without retry', async () => {
  const first = deferred(), errors = [], writes = [];
  const channel = new CommandChannel({ write: (bytes) => {
    writes.push(new TextDecoder().decode(bytes)); return first.promise;
  }, onError: (error) => errors.push(error.message) });
  const f = channel.request('F');
  const stop = channel.request('STOP');
  first.reject(new Error('disconnected'));
  assert.deepEqual(await Promise.all([f, stop]), [false, false]);
  assert.equal(await channel.request('STOP'), false);
  assert.deepEqual(writes, ['F\n']);
  assert.deepEqual(errors, ['disconnected']);
});

test('invalid protocol input never reaches UART', async () => {
  const writes = [];
  const channel = new CommandChannel({ write: async (bytes) => writes.push(bytes) });
  for (const command of ['F\nB', 'VAR:F_P0:180', '', null, 'constructor']) {
    assert.equal(await channel.request(command), false);
  }
  assert.deepEqual(writes, []);
});
