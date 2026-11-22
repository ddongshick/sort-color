import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [appSource, controlSource, html] = await Promise.all([
  readFile(new URL('app.mjs', root), 'utf8'),
  readFile(new URL('control.mjs', root), 'utf8'),
  readFile(new URL('index.html', root), 'utf8'),
]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.listeners = new Map(); this.children = [];
    this.dataset = {}; this.style = {}; this.attributes = {}; this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false; this.checked = false;
    const classes = new Set();
    this.classList = { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x),
      toggle: (x, on) => { if (on ?? !classes.has(x)) classes.add(x); else classes.delete(x); } };
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  async emit(type, values = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values };
    await Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }
  append(...nodes) { nodes.forEach((node) => { node.parent = this; this.children.push(node); }); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  get lastElementChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attributes[name] = value; }
  setPointerCapture() {}
  closest() { return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(this.tagName) ? this : null; }
  getContext() { return { drawImage() {} }; }
}

async function harness({ labels = ['F', 'STOP'], failConnect = false, metadataGate = null } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.checked = /\bchecked\b/.test(match[2]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(match[3], element);
  }
  elements.get('stability-delay').value = '250';
  const drives = new Map(['F', 'L', 'R', 'B'].map((command) => {
    const button = new Element('button'); button.dataset.drive = command; return [command, button];
  }));
  const actions = new Map(['A', 'C', 'D'].map((command) => {
    const button = new Element('button'); button.dataset.action = command; return [command, button];
  }));
  const document = new Element(); document.head = new Element('head'); document.hidden = false;
  document.getElementById = (id) => {
    assert.ok(elements.has(id), `Real index.html must provide #${id}`);
    return elements.get(id);
  };
  document.createElement = (tag) => new Element(tag);
  document.querySelectorAll = (selector) => selector === '[data-drive]' ? [...drives.values()] :
    selector === '[data-action]' ? [...actions.values()] : [...drives.values(), ...actions.values()];
  const window = new Element(); window.isSecureContext = true; window.tf = {};
  const frames = new Map(), timers = new Map(), intervals = new Map();
  let clock = 0, nextId = 1, writeGate = null, modelLoads = 0, fetches = 0, disconnects = 0;
  const writes = [], apiCalls = [], characteristics = [], services = [];
  const track = new Element(); track.stop = () => apiCalls.push('track.stop');
  let predictions = labels.map((className, i) => ({ className, probability: i ? 0.01 : 0.99 }));
  const embedding = new Float32Array([1, 2, 3]);
  const pose = { score: 0.95, keypoints: Array.from({ length: 17 }, () => ({ score: 0.9 })) };
  const model = {
    getTotalClasses: () => labels.length,
    model: { dispose: () => apiCalls.push('classifier.dispose') },
    posenetModel: { dispose: () => apiCalls.push('posenet.dispose') },
    estimatePose: async () => { apiCalls.push('estimatePose'); return { pose, posenetOutput: embedding }; },
    predict: async (input) => { assert.equal(input, embedding, 'classifier receives pose features, not camera pixels'); apiCalls.push('predict'); return predictions; },
  };
  window.tmPose = {
    load: async (url, metadata) => { modelLoads++; assert.match(url, /bqZqF3_sY\/model\.json\?refresh=/); assert.equal(metadata.packageName, '@teachablemachine/pose'); return model; },
    Webcam: class {
      constructor() { this.canvas = new Element('canvas'); this.webcam = { srcObject: { getVideoTracks: () => [track], getTracks: () => [track] }, pause() {} }; }
      async setup() { apiCalls.push('camera.setup'); }
      async play() { apiCalls.push('camera.play'); }
      update() { apiCalls.push('camera.update'); }
    },
    drawKeypoints() {}, drawSkeleton() {},
  };
  const characteristic = {
    properties: { writeWithoutResponse: true },
    writeValueWithoutResponse: async (bytes) => {
      writes.push(new TextDecoder().decode(bytes));
      if (writeGate) { const gate = writeGate; writeGate = null; await gate.promise; }
    },
  };
  const device = new Element(); device.name = 'BBC micro:bit test';
  device.gatt = {
    connected: false,
    async connect() { if (failConnect) throw new Error('Test GATT unavailable'); this.connected = true; return this; },
    async getPrimaryService(uuid) { services.push(uuid); return { getCharacteristic: async (id) => { characteristics.push(id); return characteristic; } }; },
    disconnect() { this.connected = false; disconnects++; void device.emit('gattserverdisconnected'); },
  };
  const navigator = { mediaDevices: { getUserMedia() {} }, bluetooth: { requestDevice: async () => device } };
  window.navigator = navigator;
  const context = vm.createContext({
    document, window, navigator, URL, AbortController, TextEncoder, TextDecoder,
    performance: { now: () => clock }, console,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url) => { fetches++; assert.match(String(url), /bqZqF3_sY\/metadata\.json$/); if (metadataGate) await metadataGate.promise; return { ok: true, json: async () => ({ packageName: '@teachablemachine/pose', labels }) }; },
    requestAnimationFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback, ms) => { const id = nextId++; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, ms) => { const id = nextId++; intervals.set(id, { callback, ms }); return id; },
  });
  const control = new vm.SourceTextModule(controlSource, { context, identifier: 'control.mjs' });
  const app = new vm.SourceTextModule(appSource, { context, identifier: 'app.mjs' });
  await app.link((specifier) => { assert.equal(specifier, './control.mjs'); return control; });
  await app.evaluate();
  return {
    elements, drives, actions, writes, services, characteristics, apiCalls, document, window, device,
    get: (id) => elements.get(id), click: (id) => elements.get(id).emit('click'),
    setWriteGate: (gate) => { writeGate = gate; },
    counts: () => ({ modelLoads, fetches, disconnects }),
    setPredictions: (next) => { predictions = next; },
    async frame(time) {
      clock = time;
      const [id, callback] = frames.entries().next().value || [];
      assert.ok(callback, 'camera frame scheduled'); frames.delete(id); await callback(time); await flush();
    },
    async tick(time) { clock = time; for (const { callback } of intervals.values()) callback(); await flush(); },
  };
}

test('model uses pose extraction, class mapping and UART auto drive with stale-frame stop', async () => {
  const app = await harness();
  await app.click('load-model');
  assert.equal(app.counts().modelLoads, 1);
  assert.equal(app.get('camera-placeholder').hidden, true);
  assert.equal(app.get('class-list').children.length, 2);
  await app.click('connect-bt');
  assert.deepEqual(app.writes, ['STOP\n']);
  assert.equal(app.services[0], '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  assert.equal(app.characteristics[0], '6e400003-b5a3-f393-e0a9-e50e24dcca9e');
  await app.click('auto-toggle');
  await app.frame(100); await app.frame(400);
  assert.deepEqual(app.apiCalls.filter((name) => /estimatePose|predict/.test(name)), ['estimatePose', 'predict', 'estimatePose', 'predict']);
  assert.equal(app.writes.at(-1), 'F\n');
  await app.tick(900);
  assert.equal(app.writes.at(-1), 'STOP\n');
});

test('connection stays disabled until initial STOP succeeds; manual release sends STOP', async () => {
  const app = await harness(); const handshake = deferred(); app.setWriteGate(handshake);
  const connecting = app.click('connect-bt'); await flush();
  assert.equal(app.drives.get('F').disabled, true);
  assert.deepEqual(app.writes, ['STOP\n']);
  handshake.resolve(); await connecting;
  assert.equal(app.drives.get('F').disabled, false);
  await app.drives.get('F').emit('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 1 }); await flush();
  assert.equal(app.writes.at(-1), 'F\n');
  await app.drives.get('F').emit('pointerup'); await flush();
  assert.equal(app.writes.at(-1), 'STOP\n');
  assert.equal(app.get('mode-badge').textContent, '대기');
});

test('emergency stop invalidates an auxiliary action waiting behind its STOP barrier', async () => {
  const app = await harness(); await app.click('connect-bt');
  const pending = deferred(); app.setWriteGate(pending);
  await app.actions.get('A').emit('click'); await flush();
  const emergency = app.click('stop-all'); await flush();
  pending.resolve(); await emergency; await flush();
  assert.equal(app.writes.includes('A\n'), false);
  assert.equal(app.writes.at(-1), 'STOP\n');
});

test('unrecognized classes default to STOP and require an explicit mapping before auto drive', async () => {
  const app = await harness({ labels: ['팔 올리기', '팔 벌리기'] });
  await app.click('load-model'); await app.click('connect-bt');
  for (const row of app.get('class-list').children) assert.equal(row.children.at(-1).value, 'STOP');
  await app.click('auto-toggle');
  await app.frame(100); await app.frame(600);
  assert.deepEqual(app.writes, ['STOP\n']);
  assert.equal(app.get('mode-badge').textContent, '대기');
  assert.match(app.get('toast').textContent, /먼저 지정/);
});

test('GATT connection failure keeps manual and automatic controls disabled', async () => {
  const app = await harness({ failConnect: true });
  await app.click('connect-bt');
  assert.equal(app.drives.get('F').disabled, true);
  assert.equal(app.get('auto-toggle').disabled, true);
  assert.equal(app.get('connect-bt').disabled, false);
  assert.equal(app.get('bt-status').classList.contains('state-error'), true);
  assert.equal(app.writes.length, 0);
});

test('duplicate load clicks share one in-progress model load', async () => {
  const wait = deferred(); const app = await harness({ metadataGate: wait });
  const first = app.click('load-model'); const second = app.click('load-model');
  await flush();
  assert.equal(app.get('load-model').disabled, true);
  assert.equal(app.counts().fetches, 1);
  wait.resolve(); await Promise.all([first, second]);
  assert.equal(app.counts().modelLoads, 1);
  assert.equal(app.get('load-model').disabled, false);
});

test('tab switch stops active driving and requires explicit reactivation', async () => {
  const app = await harness(); await app.click('load-model'); await app.click('connect-bt'); await app.click('auto-toggle');
  await app.frame(100); await app.frame(400);
  app.document.hidden = true; await app.document.emit('visibilitychange'); await flush();
  assert.equal(app.writes.at(-1), 'STOP\n');
  app.document.hidden = false; await app.frame(700); await app.frame(1000);
  assert.equal(app.writes.at(-1), 'STOP\n');
  assert.equal(app.get('mode-badge').textContent, '대기');
});
