/** Protocol shared with the user's newline-delimited micro:bit UART program. */
export const COMMANDS = Object.freeze({
  F: '전진', B: '후진', L: '좌회전', R: '우회전', STOP: '정지',
  A: '서보 A', C: '웃음소리', D: '하트',
});
export const MOVEMENT = new Set(['F', 'B', 'L', 'R']);
const isCommand = (value) => typeof value === 'string' && Object.hasOwn(COMMANDS, value);

export function normalizeModelURL(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Teachable Machine 포즈 모델의 공유 주소를 입력해 주세요.'); }
  const match = url.pathname.match(/^\/models\/([A-Za-z0-9_-]+)(?:\/(?:model\.json|metadata\.json)?)?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'teachablemachine.withgoogle.com' ||
      url.port || url.username || url.password || !match) {
    throw new Error('https://teachablemachine.withgoogle.com/models/모델ID/ 형식의 주소를 입력해 주세요.');
  }
  return `https://teachablemachine.withgoogle.com/models/${match[1]}/`;
}

/** Guess only explicit command names. Unrecognized poses start safely at STOP. */
export function suggestCommand(label) {
  const name = String(label ?? '').trim();
  const upper = name.toUpperCase();
  if (isCommand(upper)) return upper;
  const alias = name.toLowerCase().replace(/[\s_-]+/g, '');
  const groups = {
    F: ['forward', 'forwards', 'front', '전진', '앞', '앞으로', '직진'],
    B: ['back', 'backward', 'backwards', 'reverse', '후진', '뒤', '뒤로'],
    L: ['left', 'turnleft', '좌회전', '왼쪽', '왼쪽으로', '좌'],
    R: ['right', 'turnright', '우회전', '오른쪽', '오른쪽으로', '우'],
    STOP: ['stop', 'neutral', 'idle', 'none', 'not', 'background', '정지', '멈춤', '멈춰', '중립', '대기', '배경'],
    A: ['servoa', '서보a'], C: ['giggle', 'laugh', '웃음', '웃음소리'], D: ['heart', '하트'],
  };
  for (const [command, names] of Object.entries(groups)) if (names.includes(alias)) return command;
  return 'STOP';
}

/** Stable pose decisions, independent from camera/Bluetooth/browser timing. */
export class PoseGate {
  constructor({ threshold = 0.85, stableMs = 250, lossMs = 450 } = {}) {
    this.threshold = threshold;
    this.stableMs = stableMs;
    this.lossMs = lossMs;
    this.reset();
  }

  reset() {
    this.current = 'STOP';
    this.candidate = null;
    this.candidateSince = null;
    this.lastValidAt = null;
    this.lastConfirmedAt = null;
  }

  update({ command, confidence, posePresent }, nowMs = performance.now()) {
    const confident = posePresent === true && isCommand(command) &&
      Number.isFinite(confidence) && confidence >= this.threshold;
    if (!confident) {
      this.candidate = null;
      this.candidateSince = null;
      return this.tick(nowMs);
    }
    // A gap in inference must not count toward a candidate's stability window.
    if (this.lastValidAt !== null && nowMs - this.lastValidAt >= this.lossMs) {
      this.candidate = null;
      this.candidateSince = null;
    }
    this.lastValidAt = nowMs;
    if (command === 'STOP') {
      this.candidate = null;
      this.candidateSince = null;
      return this._change('STOP', nowMs);
    }
    if (command === this.current) {
      this.lastConfirmedAt = nowMs;
      this.candidate = null;
      this.candidateSince = null;
      return null;
    }
    if (command !== this.candidate) {
      this.candidate = command;
      this.candidateSince = nowMs;
    }
    if (nowMs - this.candidateSince >= this.stableMs) {
      this.candidate = null;
      this.candidateSince = null;
      return this._change(command, nowMs);
    }
    // Other confident poses do not extend the life of an old motor command.
    return this.tick(nowMs);
  }

  /** Call from an independent timer so a stalled prediction also stops the car. */
  tick(nowMs = performance.now()) {
    if (this.lastValidAt !== null && nowMs - this.lastValidAt >= this.lossMs) {
      this.candidate = null;
      this.candidateSince = null;
    }
    if (this.current !== 'STOP' && this.lastConfirmedAt !== null &&
        nowMs - this.lastConfirmedAt >= this.lossMs) {
      // Keep a fresh candidate: e.g. a 600 ms hold can complete after the old
      // movement times out at 450 ms, with the car stopped in the meantime.
      return this._change('STOP', nowMs);
    }
    return null;
  }

  _change(command, nowMs) {
    if (this.current === command) return null;
    this.current = command;
    this.lastConfirmedAt = nowMs;
    return command;
  }
}

/**
 * One Bluetooth write at a time. STOP removes all waiting intentions and is the
 * next write after any write already in progress. A later deliberate command
 * may queue behind STOP, but can never replace it. Failed or closed channels
 * resolve every outstanding request false, without late UI success callbacks.
 */
export class CommandChannel {
  constructor({ write, onSent = () => {}, onError = () => {} }) {
    if (typeof write !== 'function') throw new TypeError('write must be a function');
    this.write = write;
    this.onSent = onSent;
    this.onError = onError;
    this.closed = false;
    this.lastSent = null;
    this.queue = [];
    this.active = null;
    this.draining = false;
    this.encoder = new TextEncoder();
  }

  request(command, { force = false, reason = '' } = {}) {
    if (this.closed || !isCommand(command)) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (command === 'STOP') {
        const waitingStop = this.queue.find((entry) => entry.command === 'STOP');
        for (const entry of this.queue) if (entry !== waitingStop) this._settle(entry, false);
        this.queue = waitingStop ? [waitingStop] : [];
        if (waitingStop) { waitingStop.resolvers.push(resolve); return; }
        if (this.active?.command === 'STOP' && !force) {
          this.active.resolvers.push(resolve);
          return;
        }
      } else {
        const waiting = this.queue.find((entry) => entry.command !== 'STOP');
        if (waiting?.command === command && !force) { waiting.resolvers.push(resolve); return; }
        for (const entry of this.queue) if (entry.command !== 'STOP') this._settle(entry, false);
        this.queue = this.queue.filter((entry) => entry.command === 'STOP');
      }

      if (!force && this.queue.length === 0) {
        if (this.active?.command === command) { this.active.resolvers.push(resolve); return; }
        if (!this.active && this.lastSent === command) { resolve(true); return; }
      }
      this.queue.push({ command, reason, resolvers: [resolve] });
      void this._drain();
    });
  }

  close() {
    this.closed = true;
    for (const entry of this.queue) this._settle(entry, false);
    this.queue = [];
    if (this.active) this._settle(this.active, false);
  }

  _settle(entry, result) {
    for (const resolve of entry.resolvers.splice(0)) resolve(result);
  }

  async _drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length) {
        const entry = this.queue.shift();
        this.active = entry;
        try {
          await this.write(this.encoder.encode(`${entry.command}\n`));
        } catch (error) {
          if (!this.closed) {
            this.close();
            try { this.onError(error); } catch { /* UI callbacks cannot strand requests. */ }
          }
          break;
        }
        if (this.closed) { this._settle(entry, false); break; }
        this.lastSent = entry.command;
        try { this.onSent(entry.command, entry.reason); } catch { /* Preserve queue progress. */ }
        this._settle(entry, true);
        this.active = null;
      }
    } finally {
      this.active = null;
      this.draining = false;
    }
  }
}
