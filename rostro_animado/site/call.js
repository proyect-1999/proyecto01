// rostro_animado/site/call.js
/* ============================================================
 * call.js — Integración de la videollamada (call.html) dentro de index.html
 *
 * Estrategia de integración:
 *   1. index.html ya carga el motor MoodMates (MM.create) y ahora también la
 *      capa multimedia (MM_Media / MM_WebRTC / MM_Call). Este script es el
 *      "glue" que replica la lógica del script embebido en call.html pero
 *      montada sobre un overlay/modal en lugar de una página aparte.
 *   2. El botón ☎ de la topbar (#callToggle) abre el overlay; al abrirlo por
 *      primera vez se hace setup() (permisos → enumerateDevices, en ese orden,
 *      porque los `label` solo existen tras conceder permiso).
 *   3. La sesión usa MM_Call.create(...) con un bot propio (mate de llamada),
 *      de modo que las emociones del bot reaccionan a eventos de media/WebRTC
 *      sin interferir con el bot de la galería.
 *   4. Señalización loopback local por defecto (sin servidor). Para backend
 *      real usar call.html con modo WebSocket, o inyectar options.signal.
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MM = window.MoodMates;

  var toggleBtn = $('callToggle');
  var overlay = $('callOverlay');
  var mask = $('callMask');
  if (!toggleBtn || !overlay || !mask) return;   /* la página no tiene el modal */

  var statusEl = $('callStatus');
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  var started = false;      /* setup() solo una vez (lazy al primer abrir) */
  var mate = null;          /* instancia del bot dentro del overlay */
  var session = null;       /* MM_Call.create(...) */

  /* ---------------- Bot animado del overlay ---------------- */
  function buildBot(charId) {
    if (!MM || typeof MM.create !== 'function') {
      throw new Error('El motor MoodMates no está disponible. Verifica el orden de carga de engine.js.');
    }
    var botBox = $('callBotBox');
    if (!botBox) throw new Error('No se encontró el contenedor #callBotBox.');
    if (mate) { try { mate.destroy(); } catch (e) {} mate = null; }
    mate = MM.create(botBox, {
      character: charId || 'nimbo',
      emotion: '02',
      idle: true
    });
    mate.on('change', function (e) {
      var name = e.def ? (e.def.name || e.def.id) : e.id;
      $('callBotEmo').textContent = e.id + ' · ' + name;
    });
    if (session) session.setMate(mate);
  }

  /* ---------------- Rellenado de selects de dispositivos ---------------- */
  function fillSelect(sel, devices, defaultName) {
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    var opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = 'Predeterminado';
    sel.appendChild(opt0);
    (devices || []).forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || (defaultName + ' ' + (i + 1));
      sel.appendChild(o);
    });
    if (prev && sel.querySelector('option[value="' + CSS.escape(prev) + '"]')) sel.value = prev;
  }

  function refreshDeviceLists(devices) {
    fillSelect($('callCameraSelect'), devices.videoinputs, 'Cámara');
    fillSelect($('callMicSelect'), devices.audioinputs, 'Micrófono');
    fillSelect($('callSpeakerSelect'), devices.audiooutputs, 'Bocina');
  }

  /* ---------------- Señalización loopback (demo sin servidor) -----------
   * Dos RTCPeerConnection locales enlazadas por un canal simulado: permite
   * probar toda la tubería getUserMedia → tracks → offer/answer/ICE → ontrack
   * sin backend. (Misma implementación que call.html.) */
  function makeLoopbackSignal() {
    function mkSide() {
      return {
        _h: {},
        on: function (evt, fn) { (this._h[evt] = this._h[evt] || []).push(fn); return this; },
        open: function () { var self = this; return Promise.resolve().then(function () { self._fire('open'); }); },
        send: function (obj) {
          var other = this.other;
          setTimeout(function () { if (other) other._fire('message', obj); }, 30);
          return true;
        },
        close: function () {},
        _fire: function (evt, p) { (this._h[evt] || []).forEach(function (f) { f(p); }); }
      };
    }
    var s1 = mkSide(), s2 = mkSide();
    s1.other = s2; s2.other = s1;
    s2.on('message', async function (msg) {
      if (!s2.pc) {
        s2.pc = new RTCPeerConnection({ iceServers: [] });
        s2.pc.onicecandidate = function (ev) { if (ev.candidate) s2.send({ type: 'ice', candidate: ev.candidate }); };
        s2.pc.ontrack = function (ev) { s2.remoteStream = ev.streams[0]; };
      }
      if (msg.type === 'offer') {
        await s2.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        var ans = await s2.pc.createAnswer();
        await s2.pc.setLocalDescription(ans);
        s2.send({ type: 'answer', sdp: s2.pc.localDescription });
      } else if (msg.type === 'ice' && s2.pc) {
        try { await s2.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) {}
      }
    });
    return s1;
  }

  /* ---------------- Creación diferida de la sesión ---------------- */
  function ensureSession() {
    if (session) return session;
    buildBot($('callCharSelect') ? $('callCharSelect').value : 'nimbo');

    session = MM_Call.create({
      mate: mate,
      videoElement: $('callLocalVideo'),
      audioElements: [$('callRemoteAudio')],
      roomId: 'bot-call-index',
      signal: makeLoopbackSignal(),
      onMediaEvent: function (evt, data) { console.log('[media]', evt, data); },
      onCallEvent: function (evt, data) {
        console.log('[call]', evt, data);
        var badge = $('callRtcState');
        if (evt === 'state' && badge) {
          badge.textContent = data.state;
          badge.className = 'call-badge ' + data.state;
        }
      },
      onDevicesChanged: function (devices) {
        refreshDeviceLists(devices);
        setStatus('Dispositivos detectados (hot-plug): ' +
          devices.videoinputs.length + ' cámaras · ' +
          devices.audioinputs.length + ' micrófonos · ' +
          devices.audiooutputs.length + ' salidas');
      }
    });
    return session;
  }

  function lazySetup() {
    if (started) return;
    started = true;
    Promise.resolve().then(function () { return ensureSession().setup(); }).then(function (devices) {
      refreshDeviceLists(devices);
      setStatus('Sistema multimedia listo (' +
        devices.videoinputs.length + ' cámaras · ' +
        devices.audioinputs.length + ' micrófonos · ' +
        devices.audiooutputs.length + ' salidas). Pulsa «Iniciar llamada».');
    }).catch(function (e) {
      started = false;
      setStatus('Error: ' + (e && e.message ? e.message : String(e)));
    });
  }

  /* ---------------- Abrir / cerrar overlay ---------------- */
  function openCall() {
    mask.hidden = false;
    requestAnimationFrame(function () { mask.classList.add('show'); });
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    lazySetup();
  }
  function closeCall() {
    mask.classList.remove('show');
    setTimeout(function () { mask.hidden = true; }, 300);
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    /* al cerrar, colgar si estaba en llamada para liberar dispositivos */
    if (session && session.rtc && session.rtc.pc) {
      session.endCall();
      resetButtons();
    }
  }

  toggleBtn.addEventListener('click', openCall);
  $('callClose').addEventListener('click', closeCall);
  mask.addEventListener('click', closeCall);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeCall();
  });

  if ($('callCharSelect')) {
    $('callCharSelect').addEventListener('change', function () { buildBot(this.value); });
  }

  /* ---------------- Eventos de dispositivos ---------------- */
  $('callCameraSelect').addEventListener('change', async function () {
    if (!session) return;
    session.media.camera.deviceId = this.value;
    if (session.media.camera.isRunning()) {
      if (session.rtc && session.rtc.pc) await session.switchCamera(this.value);
      else await session.media.startCamera(this.value);
      setStatus('Cámara cambiada en caliente (applyConstraints + replaceTrack).');
    }
  });

  $('callMicSelect').addEventListener('change', async function () {
    if (!session) return;
    session.media.microphone.deviceId = this.value;
    if (session.media.microphone.isRunning()) {
      if (session.rtc && session.rtc.pc) await session.switchMicrophone(this.value);
      else await session.media.startMicrophone(this.value);
      setStatus('Micrófono cambiado en caliente.');
    }
  });

  $('callSpeakerSelect').addEventListener('change', async function () {
    if (!session || !this.value) return;
    try {
      await session.selectSpeaker(this.value);
      setStatus('Salida de audio cambiada con setSinkId().');
    } catch (e) {
      setStatus('Error de salida de audio: ' + e.message);
    }
  });

  /* ---------------- Controles de llamada ---------------- */
  function resetButtons() {
    var s = $('callStartBtn'), m = $('callMuteBtn'), c = $('callCamBtn'), en = $('callEndBtn');
    if (s) s.disabled = false;
    if (m) { m.disabled = true; m.textContent = '🎤 Silenciar'; m.className = 'btn'; }
    if (c) { c.disabled = true; c.textContent = '📷 Cámara OFF'; }
    if (en) en.disabled = true;
  }

  $('callStartBtn').addEventListener('click', async function () {
    this.disabled = true;
    try {
      await ensureSession().startCall();
      $('callMuteBtn').disabled = false;
      $('callCamBtn').disabled = false;
      $('callEndBtn').disabled = false;
      setStatus('Llamada iniciada: cámara + micrófono → WebRTC (loopback).');
    } catch (e) {
      setStatus('No se pudo iniciar la llamada: ' + e.message);
      this.disabled = false;
    }
  });

  $('callMuteBtn').addEventListener('click', function () {
    var muted = session.toggleMute();
    this.textContent = muted ? '🔇 Reactivar micrófono' : '🎤 Silenciar';
    this.className = muted ? 'btn ghost' : 'btn';
    setStatus(muted ? 'Micrófono silenciado (track.enabled=false).' : 'Micrófono activo.');
  });

  $('callCamBtn').addEventListener('click', function () {
    var on = session.toggleCamera();
    this.textContent = on ? '📷 Cámara OFF' : '📷 Cámara ON';
    setStatus(on ? 'Cámara encendida.' : 'Cámara apagada (track.enabled=false).');
  });

  $('callEndBtn').addEventListener('click', function () {
    session.endCall();
    resetButtons();
    setStatus('Llamada finalizada. Dispositivos locales liberados.');
  });

  /* Enlace profundo: index.html?call=1 abre el overlay directamente */
  if (/[?&]call=1/.test(location.search)) openCall();
})();
