/* Prueba de humo con mocks: MediaDeviceManager + WebRTCClient + CallSession
   sin navegador. Valida permisos→enumerate, start/stop, mute, setSinkId,
   hot-swap applyConstraints y flujo de señalización offer/answer/ice. */
'use strict';

/* ---- Mocks mínimos de la plataforma ---- */
function FakeTrack(kind, deviceId, label) {
  this.kind = kind; this.readyState = 'live'; this.enabled = true;
  this.label = label;
  this._settings = { deviceId: deviceId };
}
FakeTrack.prototype.stop = function () { this.readyState = 'ended'; };
FakeTrack.prototype.getSettings = function () { return this._settings; };
FakeTrack.prototype.applyConstraints = async function (c) {
  var want = c.advanced && c.advanced[0] && c.advanced[0].deviceId && c.advanced[0].deviceId.exact;
  if (want === 'BUSY-CAM') throw new Error('NotReadableError');
  if (want) this._settings.deviceId = want;
};

function FakeStream(tracks) { this._tracks = tracks || []; }
FakeStream.prototype.getTracks = function () { return this._tracks.slice(); };
FakeStream.prototype.getVideoTracks = function () { return this._tracks.filter(t => t.kind === 'video'); };
FakeStream.prototype.getAudioTracks = function () { return this._tracks.filter(t => t.kind === 'audio'); };
FakeStream.prototype.addTrack = function (t) { this._tracks.push(t); };

let gumCalls = [];
const fakeDevices = [
  { kind: 'videoinput', deviceId: 'cam1', label: '' },
  { kind: 'videoinput', deviceId: 'cam2', label: '' },
  { kind: 'audioinput', deviceId: 'mic1', label: '' },
  { kind: 'audiooutput', deviceId: 'spk1', label: '' },
];

global.MediaStream = FakeStream;
global.navigator = {
  mediaDevices: {
    getUserMedia: async (constraints) => {
      gumCalls.push(constraints);
      const tracks = [];
      if (constraints.video) {
        const id = typeof constraints.video === 'object' && constraints.video.deviceId
          ? constraints.video.deviceId.exact : 'cam1';
        if (id === 'NOPE') throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
        tracks.push(new FakeTrack('video', id, 'Camera ' + id));
      }
      if (constraints.audio) {
        const id = typeof constraints.audio === 'object' && constraints.audio.deviceId
          ? constraints.audio.deviceId.exact : 'mic1';
        tracks.push(new FakeTrack('audio', id, 'Mic ' + id));
      }
      /* tras el permiso, los labels quedan visibles */
      fakeDevices.forEach(d => { d.label = d.kind + '-' + d.deviceId; });
      return new FakeStream(tracks);
    },
    enumerateDevices: async () => fakeDevices.slice(),
    addEventListener: () => {}, removeEventListener: () => {}
  }
};

/* PeerConnection simulada */
let pcInstances = [];
global.RTCPeerConnection = function (cfg) {
  const pc = {
    _senders: [], connectionState: 'new', localDescription: null, remoteDescription: null,
    config: cfg,
    addTrack(track, stream) { pc._senders.push({ track, replaceTrack: async (t) => { pc._senders[pc._senders.findIndex(s => s.track === track || s.replaced)].track = t; } }); },
    getSenders() { return pc._senders.slice(); },
    createOffer: async () => ({ type: 'offer', sdp: 'SDP-OFFER' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'SDP-ANSWER' }),
    setLocalDescription: async (d) => { pc.localDescription = d; },
    setRemoteDescription: async (d) => { pc.remoteDescription = d; if (pc.onconnectionstatechange) { pc.connectionState = 'connected'; pc.onconnectionstatechange(); } },
    addIceCandidate: async () => {},
    close() { pc.closed = true; }
  };
  pcInstances.push(pc);
  return pc;
};
global.RTCSessionDescription = function (d) { Object.assign(this, d); };
global.RTCIceCandidate = function (d) { Object.assign(this, d); };

/* Elemento de audio con setSinkId */
const sinkLog = [];
function fakeEl(name, withSink) {
  return { srcObject: null, setSinkId: withSink ? async (id) => { sinkLog.push([name, id]); } : undefined };
}

/* ---- Cargar módulos ---- */
require('../src/media/MediaDeviceManager.js');
require('../src/media/WebRTCClient.js');
require('../src/media/CallSession.js');

const assert = require('assert');
(async () => {
  /* ===== 1. MediaDeviceManager ===== */
  const localVideo = fakeEl('localVideo', false);
  const remoteAudio = fakeEl('remoteAudio', true);
  const mm = new MM_Media.MediaDeviceManager({
    videoElement: localVideo, audioElements: [remoteAudio]
  });

  await mm.requestPermissions();
  assert.strictEqual(mm.permissions.granted.video, true, 'permiso vídeo');
  assert.strictEqual(gumCalls.length, 1, 'sondeo único de permisos');
  gumCalls = [];

  const devices = await mm.refreshDevices();
  assert.strictEqual(devices.videoinputs.length, 2, 'dos cámaras');
  assert.strictEqual(devices.audiooutputs.length, 1, 'una salida');
  assert.ok(devices.videoinputs[0].label, 'labels visibles tras permiso');

  await mm.startCamera('cam1');
  assert.ok(mm.camera.isRunning(), 'cámara corriendo');
  assert.strictEqual(localVideo.srcObject, mm.camera.stream, 'stream enganchada al <video>');
  assert.deepStrictEqual(gumCalls[0], { video: { deviceId: { exact: 'cam1' } }, audio: false }, 'constraints cámara');

  await mm.startMicrophone('mic1');
  assert.ok(mm.microphone.isRunning(), 'micrófono corriendo');
  assert.strictEqual(gumCalls[1].audio.echoCancellation, true, 'echoCancellation activo');

  /* mute sin apagar */
  mm.setMuted(true, 'microphone');
  assert.ok(mm.microphone.isMuted(), 'mic silenciado');
  assert.ok(mm.microphone.isRunning(), 'mic sigue vivo (enabled=false)');
  mm.setMuted(false, 'microphone');
  assert.ok(!mm.microphone.isMuted(), 'mic reactivado');

  /* bocina vía setSinkId (no getUserMedia) */
  await mm.selectSpeaker('spk1');
  assert.deepStrictEqual(sinkLog[0], ['remoteAudio', 'spk1'], 'setSinkId invocado');
  const gumCountBefore = gumCalls.length;
  await mm.selectSpeaker('spk1');
  assert.strictEqual(gumCalls.length, gumCountBefore, 'speaker NO usa getUserMedia');

  /* getLocalStream combinado para WebRTC */
  const combined = mm.getLocalStream();
  assert.strictEqual(combined.getTracks().length, 2, 'stream combinada = cam + mic');

  /* stop limpia */
  mm.stopCamera();
  assert.strictEqual(localVideo.srcObject, null, 'srcObject liberado');
  assert.ok(!mm.camera.isRunning());

  /* hot-swap con applyConstraints; fallback a restart si falla */
  await mm.startCamera('cam1');
  await mm.camera.switchDevice('cam2');
  assert.strictEqual(mm.camera.track._settings.deviceId, 'cam2', 'applyConstraints cambió dispositivo');
  await mm.camera.switchDevice('BUSY-CAM');   /* fuerza fallo → reinicio */
  assert.strictEqual(mm.camera.deviceId, 'BUSY-CAM');
  assert.ok(mm.camera.isRunning(), 'sigue viva tras fallback');

  /* ===== 2. WebRTCClient con señalización mock ===== */
  function mockSignalPair() {
    const client = { _h: {}, on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; },
      _fire(e, p) { (this._h[e] || []).forEach(f => f(p)); },
      open: () => Promise.resolve(), send: (o) => { client.sent.push(o); return true; }, sent: [], close: () => {} };
    return client;
  }
  const sig = mockSignalPair();
  const remoteVideo = fakeEl('remoteVideo', true);
  const mm2 = new MM_Media.MediaDeviceManager({ audioElements: [remoteVideo] });
  await mm2.startCamera('cam1'); await mm2.startMicrophone('mic1');

  const states = [];
  const rtc = new MM_WebRTC.WebRTCClient({
    mediaManager: mm2, signal: sig, roomId: 'demo', remoteVideoElement: remoteVideo,
    onEvent: (evt, d) => { if (evt === 'state') states.push(d.state); }
  });
  await rtc.connect();
  assert.ok(sig.sent.some(m => m.type === 'join' && m.roomId === 'demo'), 'join enviado');
  assert.ok(sig.sent.some(m => m.type === 'offer'), 'offer enviada');
  const pc = rtc.pc;
  assert.strictEqual(pc._senders.length, 2, 'dos pistas locales añadidas a la PC');
  assert.strictEqual(pc.config.iceServers.length, 2, 'STUN por defecto');

  /* respuesta del peer remoto */
  sig._fire('message', { type: 'answer', sdp: { type: 'answer', sdp: 'REMOTE' } });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(states.includes('connected'), 'estado conectado tras answer');

  /* ICE entrante no rompe nada */
  sig._fire('message', { type: 'ice', candidate: { candidate: 'x' } });
  await new Promise(r => setTimeout(r, 5));

  /* remote stream engancha elemento + speaker heredado */
  const fakeTrack = new FakeTrack('video', 'rem1', 'remote');
  const remStream = new FakeStream([fakeTrack]);
  pc.ontrack({ streams: [remStream], track: fakeTrack });
  assert.strictEqual(remoteVideo.srcObject, remStream, 'remote enganchada al <video>');
  assert.ok(mm2.speaker.elements.includes(remoteVideo), 'elemento remoto registrado en SpeakerManager');
  assert.strictEqual(mm2.speaker.deviceId, '', 'sin sink previo');

  /* replaceLocalTrack durante la llamada */
  await rtc.replaceLocalTrack(mm2.camera.track, 'video');
  assert.strictEqual(pc._senders[0].track, mm2.camera.track, 'sender reemplazado');

  rtc.disconnect();
  assert.ok(pc.closed, 'PC cerrada al colgar');

  /* ===== 3. CallSession completa con mate falso ===== */
  const emoSeen = [];
  const fakeMate = {
    handleAIMessage(msg) { emoSeen.push(msg.emotionId); },
    celebrate() { emoSeen.push('celebrate'); }
  };
  const session = MM_Call.create({
    mate: fakeMate,
    videoElement: fakeEl('v', false),
    remoteVideoElement: fakeEl('r', true),
    audioElements: [],
    signal: mockSignalPair(),
  });
  await session.setup();
  await session.startCall();
  assert.ok(emoSeen.includes('30'), 'bot "pensando" al conectar');
  /* simular answer → connected */
  session.rtc.signal._fire('message', { type: 'answer', sdp: { type: 'answer', sdp: 'X' } });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(emoSeen.includes('33') && emoSeen.includes('celebrate'), 'bot celebra conexión');
  const muted = session.toggleMute();
  assert.ok(muted && emoSeen.includes('38'), 'mute dispara emoción rechazar');
  session.endCall();
  assert.ok(emoSeen.lastIndexOf('02') > emoSeen.indexOf('33'), 'vuelve a espera al colgar');

  console.log('ALL MEDIA LAYER TESTS PASSED ✔');
})().catch(e => { console.error('TEST FAIL:', e); process.exit(1); });
