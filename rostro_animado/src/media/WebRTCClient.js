// rostro_animado/src/media/WebRTCClient.js
/* ============================================================
 * WebRTCClient.js —— Capa de conexión WebRTC para la "videollamada
 * con el bot animado".
 *
 * Flujo (señalización por WebSocket, mensaje tipo offer/answer/ice):
 *
 *   connect() ──► ws.onopen ──► createOffer() ──► 'offer'
 *   'answer'  ──► setRemoteDescription ──► ICE trickle ('ice')
 *   ontrack(remoteStream) ──► evento 'remote-stream' (UI + bot)
 *
 * El cliente NO conoce el servidor: solo habla el protocolo JSON:
 *   { type: 'join', roomId, clientId }        (cliente → servidor)
 *   { type: 'offer' | 'answer', sdp }         (negociación)
 *   { type: 'ice',  candidate }               (trickle ICE)
 *
 * Integración con MoodMates (bot animado):
 *   - Estado 'connecting'  → emoción 30 (pensar)
 *   - Estado 'connected'   → emoción 33 (completado) + celebrate()
 *   - Estado 'disconnected'/'failed' → emoción 34 (error)
 *   La traducción estado→emoción vive en CallSession; aquí solo se emiten.
 * ============================================================ */
(function (global) {
  'use strict';

  var RTC = global.RTCPeerConnection || global.webkitRTCPeerConnection ||
            global.mozRTCPeerConnection;

  function supportsWebRTC() {
    return typeof RTC === 'function' && !!global.RTCSessionDescription &&
           !!(global.MediaStream);
  }

  /* ---------------- Señalización WebSocket ---------------- */

  function WsSignal(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};   /* evt -> [fn] */
  }

  WsSignal.prototype.on = function (evt, fn) {
    (this.handlers[evt] = this.handlers[evt] || []).push(fn);
    return this;
  };

  WsSignal.prototype._fire = function (evt, payload) {
    (this.handlers[evt] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };

  WsSignal.prototype.open = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (typeof global.WebSocket !== 'function') {
        reject(new Error('WebSocket no disponible.'));
        return;
      }
      var ws = new global.WebSocket(self.url);
      self.ws = ws;
      ws.onopen = function () { self._fire('open'); resolve(); };
      ws.onerror = function (e) { self._fire('error', e); reject(new Error('Fallo de señalización WebSocket.')); };
      ws.onclose = function () { self._fire('close'); };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); }
        catch (e) { console.warn('[WebRTCClient] mensaje de señalización no-JSON ignorado'); return; }
        self._fire('message', msg);
      };
    });
  };

  WsSignal.prototype.send = function (obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  };

  WsSignal.prototype.close = function () {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ya cerrada */ } }
    this.ws = null;
  };

  /* ---------------- WebRTCClient ---------------- */

  /**
   * options:
   *   - mediaManager: instancia MM_Media.MediaDeviceManager (fuente de pistas locales)
   *   - signalUrl:    ws://... o wss://... endpoint de señalización
   *   - roomId / clientId: identificadores de sala
   *   - iceServers:   array RTCIceServer (por defecto STUN público)
   *   - remoteVideoElement: <video> donde se engancha la stream remota (y setSinkId)
   */
  function WebRTCClient(options) {
    if (!supportsWebRTC()) {
      throw new Error('WebRTC no está disponible en este navegador.');
    }
    options = options || {};
    this.options = options;
    this.mediaManager = options.mediaManager || null;
    this.state = 'idle';                 /* idle|connecting|connected|disconnected|failed */
    this.pc = null;
    this.signal = null;
    this.remoteStream = null;
    this.listeners = [];
    this._config = {
      iceServers: options.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  WebRTCClient.prototype.on = function (fn) {
    if (typeof fn === 'function') this.listeners.push(fn);
    return this;
  };

  WebRTCClient.prototype._emit = function (evt, data) {
    var payload = Object.assign({ state: this.state }, data || {});
    this.listeners.slice().forEach(function (fn) {
      try { fn(evt, payload); } catch (e) { console.error(e); }
    });
    if (this.options.onEvent) {
      try { this.options.onEvent(evt, payload); } catch (e) { console.error(e); }
    }
  };

  WebRTCClient.prototype._setState = function (s, extra) {
    this.state = s;
    this._emit('state', extra);
  };

  /** Crea PeerConnection + señalización y lanza la oferta. */
  WebRTCClient.prototype.connect = async function () {
    var self = this;
    this._setState('connecting');

    if (!this.signal && !this.options.signalUrl) {
      /* Permite reconfigurar la señalización sobre el objeto options vivo. */
      this.signal = this.options.signal || null;
    }
    if (!this.signal && !this.options.signalUrl) {
      throw new Error('Falta signalUrl para la señalización WebRTC.');
    }
    if (!this.signal) this.signal = new WsSignal(this.options.signalUrl);

    this.pc = new RTC(this._config);

    /* Pistas locales desde el MediaDeviceManager (cámara + micrófono vivos). */
    if (this.mediaManager) {
      this.mediaManager.getLocalStream().getTracks().forEach(function (track) {
        self.pc.addTrack(track, self.mediaManager.getLocalStream());
      });
    } else if (this.options.localStream) {
      this.options.localStream.getTracks().forEach(function (t) {
        self.pc.addTrack(t, self.options.localStream);
      });
    }

    /* Trickle ICE local → señalización. */
    this.pc.onicecandidate = function (ev) {
      if (ev.candidate) self.signal.send({ type: 'ice', candidate: ev.candidate });
    };

    /* Track remoto entrante. */
    this.pc.ontrack = function (ev) {
      self.remoteStream = (ev.streams && ev.streams[0]) || new global.MediaStream([ev.track]);
      var el = self.options.remoteVideoElement;
      if (el) {
        el.srcObject = self.remoteStream;
        /* Engancha el elemento remoto al SpeakerManager para poder cambiar bocina. */
        if (self.mediaManager && self.mediaManager.speaker &&
            self.mediaManager.speaker.elements.indexOf(el) === -1) {
          self.mediaManager.speaker.elements.push(el);
          if (self.mediaManager.speaker.deviceId) {
            el.setSinkId(self.mediaManager.speaker.deviceId).catch(function () {});
          }
        }
      }
      self._emit('remote-stream', { stream: self.remoteStream });
    };

    this.pc.onconnectionstatechange = function () {
      var cs = self.pc.connectionState;
      if (cs === 'connected') self._setState('connected');
      else if (cs === 'disconnected') self._setState('disconnected');
      else if (cs === 'failed') self._setState('failed');
    };

    /* Mensajes de señalización entrantes. */
    this.signal.on('message', async function (msg) {
      try {
        if (msg.type === 'answer') {
          await self.pc.setRemoteDescription(new global.RTCSessionDescription(msg.sdp));
        } else if (msg.type === 'offer') {
          await self.pc.setRemoteDescription(new global.RTCSessionDescription(msg.sdp));
          var answer = await self.pc.createAnswer();
          await self.pc.setLocalDescription(answer);
          self.signal.send({ type: 'answer', sdp: self.pc.localDescription });
        } else if (msg.type === 'ice' && msg.candidate) {
          await self.pc.addIceCandidate(new global.RTCIceCandidate(msg.candidate));
        }
      } catch (e) {
        self._emit('error', { message: e.message, phase: 'signal' });
      }
    });

    await this.signal.open();
    this.signal.send({
      type: 'join',
      roomId: this.options.roomId || 'bot-call',
      clientId: this.options.clientId || ('c-' + Math.random().toString(36).slice(2, 10))
    });
    this._emit('signaling-open');

    var offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await this.pc.setLocalDescription(offer);
    this.signal.send({ type: 'offer', sdp: this.pc.localDescription });
    return this.pc;
  };

  /** Colgó la llamada: cierra pc + señalización sin apagar dispositivos locales. */
  WebRTCClient.prototype.disconnect = function () {
    if (this.pc) {
      this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch (e) { /* ya cerrada */ }
      this.pc = null;
    }
    if (this.signal) { this.signal.close(); this.signal = null; }
    if (this.options.remoteVideoElement) this.options.remoteVideoElement.srcObject = null;
    this.remoteStream = null;
    this._setState('idle');
  };

  /** Reemplaza una pista local en caliente (cambio de cámara durante la llamada). */
  WebRTCClient.prototype.replaceLocalTrack = async function (newTrack, kind) {
    if (!this.pc) return false;
    var sender = this.pc.getSenders().find(function (s) {
      return s.track && s.track.kind === (kind || newTrack.kind);
    });
    if (!sender) return false;
    await sender.replaceTrack(newTrack);
    this._emit('local-track-replaced', { kind: newTrack.kind });
    return true;
  };

  /* ---------------- Export ---------------- */

  global.MM_WebRTC = {
    WebRTCClient: WebRTCClient,
    WsSignal: WsSignal,
    supportsWebRTC: supportsWebRTC
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.MM_WebRTC;
  }
})(typeof window !== 'undefined' ? window : globalThis);
