import { COMMANDS, MOVEMENT, normalizeModelURL, suggestCommand, PoseGate, CommandChannel } from './control.mjs';

const $ = (id) => document.getElementById(id);
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const MODEL_DEFAULT = 'https://teachablemachine.withgoogle.com/models/bqZqF3_sY/';
let session = null;
let loading = false;
let loadVersion = 0;
let btVersion = 0;
let device = null;
let channel = null;
let connecting = false;
let auto = false;
let manual = null;
let commandCount = 0;
let actionVersion = 0;
let rows = [];
let mapping = Object.create(null);
let gate = new PoseGate();
let toastTimer;
let dependencies;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500);
}

function status(id, message, state = '') {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle('state-ready', state === 'ready');
  element.classList.toggle('state-error', state === 'error');
}

function updateControls() {
  $('load-model').disabled = loading;
  $('load-model').textContent = loading ? '모델과 카메라 준비 중…' : (session?.ready ? '모델 다시 불러오기' : '모델 불러오기');
  $('model-url').disabled = loading;
  $('connect-bt').disabled = connecting || !!channel;
  $('connect-bt').textContent = connecting ? '기기 연결 중…' : (channel ? '마이크로비트 연결됨' : '마이크로비트 연결');
  $('disconnect-bt').disabled = !channel && !connecting;
  $('auto-toggle').disabled = !channel || !session?.ready || loading;
  $('auto-toggle').textContent = auto ? '포즈 운전 잠시 멈추기' : '포즈 운전 시작';
  $('auto-toggle').classList.toggle('is-active', auto);
  $('mode-badge').textContent = auto ? '포즈 운전 중' : manual ? '수동 운전 중' : '대기';
  $('mode-badge').classList.toggle('is-active', auto || !!manual);
  document.querySelectorAll('[data-drive], [data-action]').forEach((button) => {
    button.disabled = !channel;
    button.classList.toggle('is-active', button.dataset.drive === manual);
  });
}

function appendLog(command, reason) {
  const row = document.createElement('li');
  row.className = 'log-row';
  const time = document.createElement('time');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const code = document.createElement('span');
  code.className = 'log-command';
  code.textContent = command;
  const description = document.createElement('span');
  description.className = 'log-reason';
  description.textContent = reason || COMMANDS[command];
  row.append(time, code, description);
  $('command-log').prepend(row);
  while ($('command-log').children.length > 30) $('command-log').lastElementChild.remove();
  $('current-command').textContent = `${COMMANDS[command]} · ${command}`;
  $('command-count').textContent = String(++commandCount);
}

function newGate() {
  gate = new PoseGate({ threshold: Number($('confidence-threshold').value) / 100, stableMs: Number($('stability-delay').value), lossMs: 450 });
}

function stop(reason = '정지 버튼', notify = false) {
  ++actionVersion;
  auto = false;
  manual = null;
  gate.reset();
  const result = channel?.request('STOP', { force: true, reason }) || Promise.resolve(false);
  updateControls();
  if (!channel) $('current-command').textContent = '정지 · 연결 대기';
  if (notify) toast('포즈 운전을 멈췄어요. 다시 움직이려면 운전을 시작하세요.');
  return result;
}

function sendCommand(command, reason) {
  if (!channel) return;
  const version = ++actionVersion;
  const target = channel;
  if (!MOVEMENT.has(command) && command !== 'STOP') {
    // Auxiliary commands in the supplied firmware leave the drive motors unchanged.
    target.request('STOP', { force: true, reason: '보조 동작 전 정지' }).then((sent) => {
      if (sent && channel === target && actionVersion === version) target.request(command, { force: true, reason });
    });
  } else {
    target.request(command, { reason });
  }
}

function readPreferences(url) {
  try { return JSON.parse(localStorage.getItem(`pose-drive:${url}`) || '{}'); } catch { return {}; }
}

function savePreferences() {
  if (!session?.url) return;
  try { localStorage.setItem(`pose-drive:${session.url}`, JSON.stringify({ mapping })); } catch { /* Storage is optional. */ }
}

function renderClasses(labels, url) {
  const saved = readPreferences(url);
  mapping = Object.create(null);
  $('class-list').replaceChildren();
  $('mapping-empty').hidden = labels.length > 0;
  rows = labels.map((label) => {
    const savedCommand = saved.mapping && Object.prototype.hasOwnProperty.call(saved.mapping, label) ? saved.mapping[label] : undefined;
    mapping[label] = Object.prototype.hasOwnProperty.call(COMMANDS, savedCommand) ? savedCommand : suggestCommand(label);
    const row = document.createElement('div'); row.className = 'class-row';
    const info = document.createElement('div'); info.className = 'class-info';
    const name = document.createElement('span'); name.className = 'class-label'; name.textContent = label;
    const probability = document.createElement('span'); probability.className = 'class-prob'; probability.textContent = '0%';
    info.append(name, probability);
    const track = document.createElement('div'); track.className = 'class-meter';
    const bar = document.createElement('div'); bar.className = 'class-meter-fill'; track.append(bar);
    const select = document.createElement('select'); select.className = 'mapping-select';
    select.setAttribute('aria-label', `${label} 포즈의 자동차 명령`);
    for (const [command, title] of Object.entries(COMMANDS)) {
      const option = document.createElement('option'); option.value = command; option.textContent = `${title} (${command})`; select.append(option);
    }
    select.value = mapping[label];
    select.addEventListener('change', () => {
      stop('포즈 명령 변경');
      mapping[label] = select.value;
      savePreferences();
      toast('명령을 저장했어요. 확인 후 포즈 운전을 다시 시작하세요.');
    });
    row.append(info, track, select); $('class-list').append(row);
    return { label, row, probability, bar };
  });
}

function loadScript(url, globalName) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url; script.async = true; script.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { script.remove(); reject(new Error('AI 도구 다운로드 시간이 초과됐어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')); }, 30000);
    script.onload = () => { clearTimeout(timer); window[globalName] ? resolve() : reject(new Error('AI 도구를 초기화하지 못했어요.')); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('AI 도구를 불러오지 못했어요. 인터넷 연결이나 학교 네트워크의 CDN 차단 여부를 확인해 주세요.')); };
    document.head.append(script);
  });
}

async function ensureDependencies() {
  if (!dependencies) dependencies = (async () => {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@1.3.1/dist/tf.min.js', 'tf');
    await loadScript('https://cdn.jsdelivr.net/npm/@teachablemachine/pose@0.8.3/dist/teachablemachine-pose.min.js', 'tmPose');
  })().catch((error) => { dependencies = null; throw error; });
  return dependencies;
}

function disposeModel(model) {
  if (!model) return;
  try { model.model?.dispose(); } catch { /* Already released. */ }
  try { model.posenetModel?.dispose(); } catch { /* Already released. */ }
}

function stopWebcam(webcam) {
  const video = webcam?.webcam;
  if (video?.srcObject) { video.srcObject.getTracks().forEach((track) => track.stop()); video.srcObject = null; }
  video?.pause();
}

function closeSession(current) {
  if (!current) return;
  current.cancelled = true;
  cancelAnimationFrame(current.frame);
  stopWebcam(current.webcam);
  const release = () => { disposeModel(current.model); current.model = null; };
  if (current.pending) current.pending.then(release, release); else release();
}

async function loadModel() {
  if (loading) return;
  let url;
  try { url = normalizeModelURL($('model-url').value); }
  catch (error) { status('model-status', error.message, 'error'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('model-status', '카메라를 사용할 수 없어요. HTTPS 주소를 PC Chrome 또는 Edge에서 열어 주세요.', 'error'); return;
  }
  const version = ++loadVersion;
  loading = true; updateControls();
  await stop('모델 변경 전 정지');
  if (version !== loadVersion) return;
  closeSession(session); session = null;
  rows = []; $('class-list').replaceChildren(); $('mapping-empty').hidden = false;
  $('camera-placeholder').hidden = false;
  $('pose-name').textContent = '인식 대기'; $('pose-confidence').textContent = '—';
  status('model-status', '포즈 인식 도구와 모델을 준비하고 있어요. 처음에는 조금 걸릴 수 있어요.');
  status('camera-status', '카메라 준비 중');
  let loaded;
  let current;
  let stage = 'model';
  try {
    await ensureDependencies();
    if (version !== loadVersion) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let metadata;
    try {
      const response = await fetch(new URL('metadata.json', url), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('모델 주소를 확인하고 Teachable Machine에서 모델 내보내기 → 업로드를 완료해 주세요.');
      metadata = await response.json();
    } finally { clearTimeout(timer); }
    if (version !== loadVersion) return;
    if (metadata.packageName && metadata.packageName !== '@teachablemachine/pose') throw new Error('이 모델은 포즈 프로젝트가 아니에요. Teachable Machine의 포즈 모델 주소를 넣어 주세요.');
    if (!Array.isArray(metadata.labels) || !metadata.labels.length || metadata.labels.some((label) => typeof label !== 'string' || !label.trim()) || new Set(metadata.labels).size !== metadata.labels.length) throw new Error('모델의 클래스 이름을 읽을 수 없어요. 이름을 확인한 뒤 다시 업로드해 주세요.');
    const modelURL = new URL('model.json', url); modelURL.searchParams.set('refresh', String(Date.now()));
    // A late model is disposed after a timed-out load; it must never replace the active session.
    let timedOut = false;
    let modelTimer;
    const modelPromise = window.tmPose.load(modelURL.href, metadata).then((result) => {
      if (timedOut || version !== loadVersion) { disposeModel(result); return null; }
      return result;
    });
    try {
      loaded = await Promise.race([modelPromise, new Promise((_, reject) => {
        modelTimer = setTimeout(() => { timedOut = true; reject(new Error('모델 준비 시간이 초과됐어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')); }, 90000);
      })]);
    } finally { clearTimeout(modelTimer); }
    if (!loaded || version !== loadVersion) return;
    if (loaded.getTotalClasses() !== metadata.labels.length) throw new Error('모델과 클래스 정보가 서로 맞지 않아요. 모델을 다시 업로드해 주세요.');
    stage = 'camera';
    status('model-status', '모델 준비 완료. 브라우저의 카메라 사용을 허용해 주세요.');
    current = { url, model: loaded, webcam: new window.tmPose.Webcam(400, 400, $('mirror-toggle').checked), cancelled: false, ready: false, frame: null, pending: null, lastFrame: 0 };
    session = current; loaded = null;
    await current.webcam.setup({ facingMode: 'user' });
    if (version !== loadVersion || current.cancelled) { stopWebcam(current.webcam); return; }
    await current.webcam.play();
    if (version !== loadVersion || current.cancelled) { stopWebcam(current.webcam); return; }
    const track = current.webcam.webcam.srcObject?.getVideoTracks()[0];
    track?.addEventListener('ended', () => { if (session === current && !current.cancelled) failCamera(current, '카메라 연결이 끊겼어요. 모델을 다시 불러와 주세요.'); });
    track?.addEventListener('mute', () => { if (session === current && !current.cancelled) stop('카메라 일시 중단'); });
    $('camera-canvas').width = 400; $('camera-canvas').height = 400;
    renderClasses(metadata.labels, url);
    current.ready = true;
    $('camera-placeholder').hidden = true;
    status('model-status', `${metadata.labels.length}개 포즈 준비 완료. 아래에서 각 포즈의 명령을 확인하세요.`, 'ready');
    status('camera-status', '카메라 켜짐', 'ready');
    gate.reset();
    current.frame = requestAnimationFrame((time) => runFrame(current, time));
  } catch (error) {
    if (version !== loadVersion) return;
    if (current) closeSession(current);
    if (session === current) session = null;
    disposeModel(loaded);
    const message = stage === 'camera' ? '카메라를 켜지 못했어요. 카메라 권한과 다른 앱의 사용 여부를 확인한 뒤 다시 눌러 주세요.' : error.name === 'AbortError' ? '모델 정보를 불러오는 시간이 초과됐어요. 인터넷 연결을 확인해 주세요.' : (error.message || '모델을 불러오지 못했어요. 포즈 모델 주소와 인터넷 연결을 확인해 주세요.');
    status('model-status', message, 'error');
    status('camera-status', '카메라 꺼짐');
    $('camera-placeholder').hidden = false;
  } finally {
    if (version === loadVersion) { loading = false; updateControls(); }
  }
}

function failCamera(current, message) {
  stop('카메라 인식 중단');
  closeSession(current);
  if (session === current) session = null;
  status('model-status', message, 'error');
  status('camera-status', '카메라 꺼짐');
  $('camera-placeholder').hidden = false;
  $('pose-name').textContent = '인식 중단'; $('pose-confidence').textContent = '—';
  updateControls();
}

async function infer(current) {
  current.webcam.update();
  const { pose, posenetOutput } = await current.model.estimatePose(current.webcam.canvas);
  if (current.cancelled || session !== current) return null;
  const predictions = await current.model.predict(posenetOutput);
  return { pose, predictions };
}

async function runFrame(current, timestamp) {
  if (current.cancelled || session !== current) return;
  if (document.hidden || timestamp - current.lastFrame < 65) {
    current.frame = requestAnimationFrame((time) => runFrame(current, time)); return;
  }
  current.lastFrame = timestamp;
  const start = performance.now();
  try {
    current.pending = infer(current);
    const result = await current.pending;
    current.pending = null;
    if (current.cancelled || session !== current || !result) return;
    const { pose, predictions } = result;
    const ctx = $('camera-canvas').getContext('2d');
    ctx.drawImage(current.webcam.canvas, 0, 0, 400, 400);
    if (pose && $('skeleton-toggle').checked) {
      window.tmPose.drawKeypoints(pose.keypoints, 0.45, ctx, 4, '#15dbb4', '#083b39');
      window.tmPose.drawSkeleton(pose.keypoints, 0.45, ctx, 3, '#15dbb4');
    }
    const visiblePoints = pose?.keypoints?.filter((point) => point.score >= 0.45).length || 0;
    const posePresent = !!pose && pose.score >= 0.35 && visiblePoints >= 5;
    let best = null;
    for (const prediction of predictions) if (!best || prediction.probability > best.probability) best = prediction;
    for (const row of rows) {
      const prediction = predictions.find((item) => item.className === row.label);
      const confidence = posePresent && prediction ? prediction.probability : 0;
      row.probability.textContent = `${Math.round(confidence * 100)}%`;
      row.bar.style.width = `${confidence * 100}%`;
      row.row.classList.toggle('is-active', posePresent && best?.className === row.label);
    }
    $('pose-name').textContent = posePresent && best ? best.className : '몸이 보이도록 서 주세요';
    $('pose-confidence').textContent = posePresent && best ? `${Math.round(best.probability * 100)}%` : '—';
    $('latency-value').textContent = `${Math.round(performance.now() - start)} ms`;
    if (auto) {
      const command = gate.update({ command: mapping[best?.className] || 'STOP', confidence: best?.probability || 0, posePresent }, performance.now());
      if (command) sendCommand(command, command === 'STOP' ? '포즈 정지 / 인식 대기' : `포즈: ${best?.className}`);
    }
  } catch (error) {
    current.pending = null;
    if (current.cancelled || session !== current) return;
    failCamera(current, '포즈 인식이 중단됐어요. 모델을 다시 불러와 주세요.');
  } finally {
    if (!current.cancelled && session === current) current.frame = requestAnimationFrame((time) => runFrame(current, time));
  }
}

function writer(characteristic) {
  if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) return (data) => characteristic.writeValueWithoutResponse(data);
  if (characteristic.properties.write && characteristic.writeValueWithResponse) return (data) => characteristic.writeValueWithResponse(data);
  if ((characteristic.properties.write || characteristic.properties.writeWithoutResponse) && characteristic.writeValue) return (data) => characteristic.writeValue(data);
  throw new Error('이 기기에서 UART 명령을 받을 수 없어요. 자동차의 블루투스 UART 프로그램을 확인해 주세요.');
}

function clearBluetooth(message, error = false) {
  ++btVersion;
  ++actionVersion;
  const previous = device;
  device = null;
  channel?.close(); channel = null;
  connecting = false; auto = false; manual = null; gate.reset();
  if (previous?.gatt?.connected) previous.gatt.disconnect();
  status('bt-status', message, error ? 'error' : '');
  $('current-command').textContent = '정지 · 연결 대기';
  updateControls();
}

async function connectBluetooth() {
  if (connecting || channel) return;
  if (!window.isSecureContext || !navigator.bluetooth?.requestDevice) {
    status('bt-status', '블루투스를 사용할 수 없어요. 이 페이지를 PC Chrome 또는 Edge의 새 탭에서 열어 주세요.', 'error'); return;
  }
  const version = ++btVersion;
  connecting = true; updateControls();
  status('bt-status', '목록에서 BBC micro:bit 기기를 선택해 주세요.');
  let selected;
  try {
    // requestDevice is invoked directly in the click handler to keep user activation.
    selected = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'BBC micro:bit' }], optionalServices: [UART_SERVICE] });
    if (version !== btVersion) return;
    device = selected;
    selected.addEventListener('gattserverdisconnected', () => {
      if (device === selected) clearBluetooth('연결이 끊겼어요. 자동차를 다시 연결해 주세요.', true);
    });
    const server = await selected.gatt.connect();
    if (version !== btVersion) { if (selected.gatt.connected) selected.gatt.disconnect(); return; }
    const service = await server.getPrimaryService(UART_SERVICE);
    const characteristic = await service.getCharacteristic(UART_RX);
    if (version !== btVersion) return;
    const write = writer(characteristic);
    let writeTimer;
    const target = new CommandChannel({
      write: (data) => Promise.race([
        write(data),
        new Promise((_, reject) => { writeTimer = setTimeout(() => reject(new Error('블루투스 응답 시간 초과')), 1800); })
      ]).finally(() => clearTimeout(writeTimer)),
      onSent: (command, reason) => { if (version === btVersion) appendLog(command, reason); },
      onError: () => { if (version === btVersion) clearBluetooth('신호 전송에 실패해 연결을 해제했어요. 자동차 전원을 확인하고 다시 연결해 주세요.', true); }
    });
    const stopped = await target.request('STOP', { force: true, reason: '연결 시 초기 정지' });
    if (!stopped || version !== btVersion) { target.close(); return; }
    channel = target;
    status('bt-status', `${selected.name || 'micro:bit'} 연결 완료`, 'ready');
    toast('자동차가 연결됐어요. 포즈별 명령을 확인하고 운전을 시작하세요.');
  } catch (error) {
    if (version !== btVersion) return;
    clearBluetooth(error.name === 'NotFoundError' ? '기기 선택을 취소했어요. 다시 연결할 수 있어요.' : error.name === 'SecurityError' ? '브라우저에서 블루투스 접근을 차단했어요. 이 페이지를 새 탭에서 열어 주세요.' : (error.message || '연결에 실패했어요. 자동차 전원과 UART 프로그램을 확인해 주세요.'), error.name !== 'NotFoundError');
  } finally {
    if (version === btVersion) { connecting = false; updateControls(); }
  }
}

function startManual(command) {
  if (!channel || document.hidden) return;
  auto = false; gate.reset();
  manual = command;
  sendCommand(command, '수동 조종');
  updateControls();
}

$('load-model').addEventListener('click', loadModel);
$('connect-bt').addEventListener('click', connectBluetooth);
$('disconnect-bt').addEventListener('click', async () => {
  const version = btVersion;
  await stop('연결 해제 전 정지');
  if (version === btVersion) clearBluetooth('연결을 해제했어요.');
});
$('stop-all').addEventListener('click', () => stop('정지 버튼', true));
$('auto-toggle').addEventListener('click', async () => {
  if (auto) { stop('포즈 운전 일시 정지'); return; }
  if (!session?.ready || !channel || document.hidden) return;
  if (!Object.values(mapping).some((command) => command !== 'STOP')) { toast('포즈별 명령에서 움직일 포즈를 먼저 지정해 주세요.'); return; }
  const target = channel;
  const version = ++actionVersion;
  const stopped = await target.request('STOP', { force: true, reason: '포즈 운전 준비' });
  if (!stopped || target !== channel || version !== actionVersion || document.hidden || !session?.ready) return;
  newGate(); auto = true; manual = null; updateControls();
  toast('포즈 운전을 시작했어요. 지정한 포즈를 잠시 유지해 주세요.');
});
$('confidence-threshold').addEventListener('input', () => {
  $('confidence-value').textContent = `${$('confidence-threshold').value}%`;
  stop('인식 기준 변경'); newGate();
});
$('stability-delay').addEventListener('change', () => { stop('인식 유지 시간 변경'); newGate(); });
$('mirror-toggle').addEventListener('change', () => {
  stop('카메라 방향 변경');
  if (session?.webcam) session.webcam.flip = $('mirror-toggle').checked;
});
$('clear-log').addEventListener('click', () => { $('command-log').replaceChildren(); commandCount = 0; $('command-count').textContent = '0'; });
document.querySelectorAll('[data-drive]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); button.setPointerCapture?.(event.pointerId); startManual(button.dataset.drive);
  });
  const release = () => { if (manual === button.dataset.drive) stop('수동 버튼 놓음'); };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('keydown', (event) => {
    if ((event.code === 'Space' || event.code === 'Enter') && !event.repeat) { event.preventDefault(); event.stopPropagation(); startManual(button.dataset.drive); }
  });
  button.addEventListener('keyup', (event) => {
    if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); event.stopPropagation(); release(); }
  });
});
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
  if (!channel) return;
  auto = false; manual = null; gate.reset(); updateControls();
  sendCommand(button.dataset.action, '수동 보조 동작');
}));
const keyCommands = { ArrowUp: 'F', KeyW: 'F', ArrowDown: 'B', KeyS: 'B', ArrowLeft: 'L', KeyA: 'L', ArrowRight: 'R', KeyD: 'R' };
document.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') { event.preventDefault(); stop('키보드 정지', true); return; }
  if (event.target.closest('input,select,textarea,button,[contenteditable]')) return;
  if (event.code === 'Space') { event.preventDefault(); stop('키보드 정지', true); return; }
  if (!event.repeat && keyCommands[event.code]) { event.preventDefault(); startManual(keyCommands[event.code]); }
});
document.addEventListener('keyup', (event) => { if (keyCommands[event.code] === manual) { event.preventDefault(); stop('방향 키 놓음'); } });
window.addEventListener('blur', () => { if (manual || auto) stop('창 전환'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stop('다른 탭으로 이동'); });
window.addEventListener('pagehide', () => {
  ++loadVersion;
  loading = false;
  stop('페이지 종료');
  clearBluetooth('연결 해제'); // The supplied firmware stops its motors on disconnect.
  closeSession(session); session = null;
  $('camera-placeholder').hidden = false;
  $('camera-canvas').getContext('2d').clearRect(0, 0, 400, 400);
  $('pose-name').textContent = '인식 대기'; $('pose-confidence').textContent = '—';
  $('latency-value').textContent = '—';
  status('camera-status', '카메라 꺼짐');
  status('model-status', '모델을 다시 불러오면 카메라가 켜집니다.');
  updateControls();
});
setInterval(() => {
  if (auto && gate.tick(performance.now())) sendCommand('STOP', '인식 신호 대기');
}, 100);

if (!$('model-url').value) $('model-url').value = MODEL_DEFAULT;
if (!navigator.bluetooth?.requestDevice || !window.isSecureContext) {
  $('capability-note').hidden = false;
  status('capability-note', '자동차 연결은 이 페이지의 HTTPS 주소를 PC Chrome 또는 Edge의 새 탭에서 열어 사용해 주세요.', 'error');
} else if (window.top !== window.self) {
  $('capability-note').hidden = false;
  status('capability-note', '미리보기에서는 장치 연결이 제한될 수 있어요. 페이지 아래의 ‘새 탭에서 열기’를 이용해 주세요.');
}
newGate(); updateControls();
