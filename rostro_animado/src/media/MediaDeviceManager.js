
// rostro_animado/src/media/MediaDeviceManager.js
/* ============================================================
 * MediaDeviceManager.js —— Coordinador de dispositivos multimedia
 * (capa base para la experiencia "videollamada con bot animado")
 *
 * Arquitectura:
 *
 *                     MediaDeviceManager
 *                            │
 *           ┌────────────────┼────────────────┐
 *           ▼                ▼                ▼
 *      CameraManager   MicrophoneManager  SpeakerManager
 *           │                │                │
 *           ▼                ▼                ▼
 *     getUserMedia()    getUserMedia()    setSinkId()
 *           │                │                │
 *           └────────────────┼────────────────┘
 *                            ▼
 *                     MediaDevices API
 *
 * Puntos clave:
 *   1. Se piden permisos ANTES de enumerateDevices(): sin permiso concedido,
 *      los navegadores ocultan el campo `label` de los dispositivos.
 *   2. La bocina NO se obtiene con getUserMedia(): se selecciona con
 *      HTMLMediaElement.setSinkId(deviceId).
 *   3. El cambio de cámara/micrófono en caliente usa applyConstraints +
 *      re-enumera dispositivos ante devicechange (conexión/desconexión).
 *   4. Expone getLocalStream() → MediaStream combinado listo para WebRTC
 *      (addTrack sobre una RTCPeerConnection).
 *   5. Cada sub-gestor emite eventos ('start' | 'stop' | 'error' | 'change')
 *      para que la capa de UI o el bot animado reaccionen.
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- Utilidades compartidas ---------------- */

  function supportsMediaDevices() {
    return !!(global.navigator && global.navigator.mediaDevices &&
              global.navigator.mediaDevices.getUserMedia);
  }

  /** Compara deviceId preferido vs real; devuelve true si hubo fallback silencioso. */
  function trackDeviceMismatch(track, wantedId) {
    if (!wantedId || !track) return false;
    var s = (track.getSettings && track.getSettings()) || {};
    return !!s.deviceId && s.deviceId !== wantedId;
  }

  /* ---------------- PermissionManager ---------------- */

  function PermissionManager(core) {
    this.core = core;
    this.granted = { video: false, audio: false };
  }

  /**
   * Solicita permisos y guarda el resultado. `stopAfter` controla si las
   * pistas de sondeo se apagan al terminar (útil para pedir consentimiento
   * inicial sin dejar la cámara encendida).
   */
  PermissionManager.prototype.request = async function (opts) {
    opts = opts || {};
    if (!supportsMediaDevices()) {
      throw new Error('La API MediaDevices no está disponible en este navegador.');
    }
    var constraints = {
      video: !!opts.video,
      audio: !!opts.audio
    };
    var stream = await this.core.getUserMedia(constraints);
    try {
      if (opts.video) this.granted.video = stream.getVideoTracks().length > 0;
      if (opts.audio) this.granted.audio = stream.getAudioTracks().length > 0;
    } finally {
      if (opts.stopAfter !== false) {
        stream.getTracks().forEach(function (t) { t.stop(); });
      }
    }
    return this.granted;
  };

  /* ---------------- Base común de tracks (cámara / micrófono) ---------------- */

  function TrackManager(core, kind) {
    this.core = core;
    this.kind = kind;               /* 'videoinput' | 'audioinput' */
    this.stream = null;             /* MediaStream activo */
    this.track = null;              /* MediaStreamTrack principal */
    this.deviceId = '';             /* deviceId seleccionado en el select */
    /* FIX bug histórico: CameraManager.__name se define sobre la FUNCIÓN
     * constructora tras reasignar el prototipo; cualquier instancia creada por
     * otra vía (o subclase futura sin __name) emitía data.manager === undefined
     * y CallSession nunca reaccionaba a start/stop/mute vía onChange.
     * Fuente única ahora: _mmName asignado por el coordinador. */
    this._mmName = kind === 'videoinput' ? 'camera' : 'microphone';
    this.extraConstraints = null;   /* { width, height, frameRate, facingMode } — tracking D14 */
    this.listeners = [];
  }

  TrackManager.prototype.on = function (fn) {
    if (typeof fn === 'function') this.listeners.push(fn);
    return this;
  };

  TrackManager.prototype._emit = function (evt, payload) {
    var data = Object.assign({ manager: this._mmName || 'unknown', kind: this.kind }, payload || {});
    this.listeners.slice().forEach(function (fn) {
      try { fn(evt, data); } catch (e) { console.error(e); }
    });
    if (this.core && this.core.onChange) {
      try { this.core.onChange(evt, data); } catch (e) { console.error(e); }
    }
  };

  TrackManager.prototype.isRunning = function () {
    return !!(this.stream && this.track && this.track.readyState === 'live');
  };

  /** Construye las constraints específicas del tipo de pista. */
  TrackManager.prototype._constraintsFor = function (deviceId) {
    /* FIX D14: antes solo se admitía deviceId; ahora `extraConstraints` permite
     * a la cámara de tracking pedir resolución/tasa bajas sin tocar el resto. */
    var extra = (this.extraConstraints && typeof this.extraConstraints === 'object')
      ? this.extraConstraints : null;
    var base = deviceId ? { deviceId: { exact: deviceId } } : true;
    if (this.kind === 'videoinput') {
      if (base === true) {
        return { video: extra ? Object.assign({ facingMode: 'user' }, extra) : true, audio: false };
      }
      return { video: Object.assign({}, base, extra || {}), audio: false };
    }
    /* Micrófono: cadena completa de procesamiento de voz por defecto. */
    var audio = base === true
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : Object.assign({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }, base);
    return { video: false, audio: audio };
  };

  /** Enciende la pista con el deviceId actual (o el predeterminado si está vacío). */
  TrackManager.prototype.start = async function (deviceId) {
    if (arguments.length > 0) this.deviceId = deviceId || '';
    this.stop();
    try {
      this.stream = await this.core.getUserMedia(this._constraintsFor(this.deviceId));
      this.track = this.kind === 'videoinput'
        ? this.stream.getVideoTracks()[0]
        : this.stream.getAudioTracks()[0];

      /* D14: si hay constraints extra, refinar la pista ya abierta (los navegadores
       * aceptan mal deviceId+width simultáneos en algunos HW; applyConstraints es
       * la vía robusta y degrada con aviso, nunca aborta el arranque). */
      if (this.kind === 'videoinput' && this.extraConstraints &&
          this.track && this.track.applyConstraints) {
        try {
          await this.track.applyConstraints(this.extraConstraints);
        } catch (e) {
          this._emit('warning', { message: 'applyConstraints parcial: ' + e.message });
        }
      }

      var actual = ((this.track.getSettings && this.track.getSettings()) || {}).deviceId;
      if (this.deviceId && actual && actual !== this.deviceId) {
        /* El navegador devolvió otro dispositivo pese a `exact`: avisar. */
        this._emit('error', { message: 'Dispositivo ocupado/no disponible; se usó un sustituto.', fallback: true });
        return this.stream;
      }
      this._emit('start', { deviceId: actual || this.deviceId, label: this.track.label });
      return this.stream;
    } catch (error) {
      this.stop();
      this._emit('error', { message: error.message, name: error.name });
      throw error;
    }
  };

  /** Apaga la pista y libera recursos. */
  TrackManager.prototype.stop = function () {
    if (!this.stream) return;
    this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    this.track = null;
    this._emit('stop', {});
  };

  /** Mute/unmute sin apagar la pista (el hardware permanece como en una call real). */
  TrackManager.prototype.setMuted = function (muted) {
    if (!this.track) return false;
    this.track.enabled = !muted;
    this._emit('mute', { muted: !!muted });
    return this.track.enabled === false;
  };

  TrackManager.prototype.isMuted = function () {
    return !!(this.track && this.track.enabled === false);
  };

  /** Cambio de dispositivo en caliente vía applyConstraints (sin reiniciar el stream). */
  TrackManager.prototype.switchDevice = async function (deviceId) {
    this.deviceId = deviceId || '';
    if (!this.track) return false;
    var advanced = [{ deviceId: { exact: this.deviceId } }];
    try {
      await this.track.applyConstraints({ advanced: advanced });
      this._emit('change', { deviceId: this.deviceId });
      return true;
    } catch (e) {
      /* applyConstraints falló (p. ej. dispositivo ocupado): reinicio completo. */
      await this.start(this.deviceId);
      return true;
    }
  };

  /* ---------------- CameraManager ---------------- */

  function CameraManager(core) {
    TrackManager.call(this, core, 'videoinput');
  }
  CameraManager.prototype = Object.create(TrackManager.prototype);
  CameraManager.prototype.constructor = CameraManager;
  CameraManager.__name = 'camera';

  /* ---------------- MicrophoneManager ---------------- */

  function MicrophoneManager(core) {
    TrackManager.call(this, core, 'audioinput');
  }
  MicrophoneManager.prototype = Object.create(TrackManager.prototype);
  MicrophoneManager.prototype.constructor = MicrophoneManager;
  MicrophoneManager.__name = 'microphone';

  /* ---------------- SpeakerManager (salida de audio) ---------------- */

  function SpeakerManager(core, mediaElements) {
    this.core = core;
    /* Elementos <audio>/<video> que reciben setSinkId (el remote de la llamada, etc.). */
    this.elements = mediaElements || [];
    this.deviceId = '';
    this.listeners = [];
  }

  SpeakerManager.prototype.on = TrackManager.prototype.on;

  SpeakerManager.prototype._emit = function (evt, payload) {
    var data = Object.assign({ manager: this._mmName || 'speaker' }, payload || {});
    this.listeners.slice().forEach(function (fn) {
      try { fn(evt, data); } catch (e) { console.error(e); }
    });
    if (this.core && this.core.onChange) {
      try { this.core.onChange(evt, data); } catch (e) { console.error(e); }
    }
  };

  SpeakerManager.supportsSetSinkId = function (el) {
    return typeof el.setSinkId === 'function';
  };

  /** Detiene la reproducción asociada a un elemento (helper simétrico a stopCamera). */
  SpeakerManager.addElement = function (list, el) {
    if (el && list.indexOf(el) === -1) list.push(el);
    return list;
  };

  /** Cambia la salida de TODOS los elementos gestionados. No usa getUserMedia. */
  SpeakerManager.prototype.setDevice = async function (deviceId) {
    this.deviceId = deviceId || '';
    if (!this.deviceId) return false;
    if (!this.elements.length) {
      var noEls = new Error('No hay elementos de audio registrados para setSinkId().');
      this._emit('error', { message: noEls.message });
      throw noEls;
    }
    var supported = this.elements.filter(SpeakerManager.supportsSetSinkId);
    if (!supported.length) {
      var err = new Error('Este navegador no soporta setSinkId().');
      this._emit('error', { message: err.message });
      throw err;
    }
    for (var i = 0; i < supported.length; i++) {
      await supported[i].setSinkId(this.deviceId);
    }
    this._emit('change', { deviceId: this.deviceId });
    return true;
  };

  /* ---------------- MediaDeviceManager (coordinador) ---------------- */

  /**
   * options:
   *   - videoElement / audioElements: elementos HTML donde se pintan/escuchan los streams
   *   - onChange(evt, data): callback central de eventos
   *   - getUserMedia: inyección para pruebas/simulación
   */
  function MediaDeviceManager(options) {
    if (!supportsMediaDevices()) {
      throw new Error('MediaDevices API no está disponible.');
    }
    options = options || {};
    this.options = options;
    this.onChange = options.onChange || null;

    /* getUserMedia envuelto para poder auditar/anular en pruebas. */
    this._gum = options.getUserMedia ||
      function (c) { return global.navigator.mediaDevices.getUserMedia(c); };

    this.permissions = new PermissionManager(this);
    this.camera = new CameraManager(this);
    this.microphone = new MicrophoneManager(this);
    this.speaker = new SpeakerManager(this, options.audioElements || []);

    /* Registry explícito de nombres (fuente única para los eventos _emit;
     * sustituye al frágil this.constructor.__name__). */
    this.camera._mmName = 'camera';
    this.microphone._mmName = 'microphone';
    this.speaker._mmName = 'speaker';

    /* D14 fusionado: segunda CameraManager dedicada al seguimiento facial.
     * Reutiliza PermissionManager, getUserMedia inyectable y la tubería de
     * eventos — cero lógica de permisos/cámara duplicada. No toca
     * this.videoElement (el visible es de la llamada; el del tracking lo
     * gestiona MM_Tracking con su propio <video>). */
    this.trackingCamera = new CameraManager(this);
    this.trackingCamera._mmName = 'trackingCamera';

    this.videoElement = options.videoElement || null;
    this.devices = { videoinputs: [], audioinputs: [], audiooutputs: [] };
    this._deviceChangeHandler = null;
  }

  MediaDeviceManager.prototype.getUserMedia = function (constraints) {
    return this._gum(constraints);
  };

  /** Paso 1: solicitar permisos (necesario para ver labels reales). */
  MediaDeviceManager.prototype.requestPermissions = async function () {
    return this.permissions.request({ video: true, audio: true, stopAfter: true });
  };

  /** Paso 2: enumerar dispositivos y clasificarlos por kind. */
  MediaDeviceManager.prototype.refreshDevices = async function () {
    var list = await global.navigator.mediaDevices.enumerateDevices();
    this.devices = {
      videoinputs: list.filter(function (d) { return d.kind === 'videoinput'; }),
      audioinputs: list.filter(function (d) { return d.kind === 'audioinput'; }),
      audiooutputs: list.filter(function (d) { return d.kind === 'audiooutput'; })
    };
    if (this.onChange) {
      try { this.onChange('devices', this.devices); } catch (e) { console.error(e); }
    }
    return this.devices;
  };

  /** Observa conexión/desconexión de dispositivos (hot-plug). */
  MediaDeviceManager.prototype.watchDeviceChanges = function (onRefresh) {
    var self = this;
    this._deviceChangeHandler = function () {
      self.refreshDevices().then(function (devices) {
        if (typeof onRefresh === 'function') onRefresh(devices);
      });
    };
    global.navigator.mediaDevices.addEventListener('devicechange', this._deviceChangeHandler);
  };

  MediaDeviceManager.prototype.unwatchDeviceChanges = function () {
    if (this._deviceChangeHandler) {
      global.navigator.mediaDevices.removeEventListener('devicechange', this._deviceChangeHandler);
      this._deviceChangeHandler = null;
    }
  };

  /* ---- API de alto nivel ---- */

  MediaDeviceManager.prototype.startCamera = function (deviceId) {
    var self = this;
    return this.camera.start(deviceId).then(function (stream) {
      if (self.videoElement) self.videoElement.srcObject = stream;
      return stream;
    });
  };

  MediaDeviceManager.prototype.stopCamera = function () {
    this.camera.stop();
    if (this.videoElement) this.videoElement.srcObject = null;
  };

  /**
   * D14 fusionado: enciende la SEGUNDA cámara (tracking facial) con constraints
   * configurables de baja resolución. Reutiliza todo el stack de MM_Media:
   * getUserMedia inyectable, detección de fallback, eventos 'start/stop/error'
   * con manager='trackingCamera'. Devuelve el MediaStream para que MM_Tracking
   * lo enganche a su <video>.
   */
  MediaDeviceManager.prototype.startTrackingCamera = async function (constraints, deviceId) {
    var tc = this.trackingCamera;
    tc.extraConstraints = Object.assign(
      { width: 320, height: 240, frameRate: 30 },
      constraints && typeof constraints === 'object' ? constraints : {}
    );
    return tc.start(deviceId != null && deviceId !== undefined ? deviceId : tc.deviceId);
  };

  MediaDeviceManager.prototype.stopTrackingCamera = function () {
    this.trackingCamera.stop();
  };

  MediaDeviceManager.prototype.startMicrophone = function (deviceId) {
    return this.microphone.start(deviceId);
  };

  MediaDeviceManager.prototype.stopMicrophone = function () {
    this.microphone.stop();
  };

  MediaDeviceManager.prototype.selectSpeaker = function (deviceId) {
    return this.speaker.setDevice(deviceId);
  };

  /** Mute combinado de micrófono (y opcionalmente cámara) como en una videollamada. */
  MediaDeviceManager.prototype.setMuted = function (muted, target) {
    target = target || 'microphone';
    if (target === 'camera') return this.camera.setMuted(muted);
    return this.microphone.setMuted(muted);
  };

  /**
   * Stream local combinado listo para WebRTC:
   *   mm.getLocalStream() → pc.addTrack(track, stream) para cada pista viva.
   */
  MediaDeviceManager.prototype.getLocalStream = function () {
    var stream = new MediaStream();
    if (this.camera.track) stream.addTrack(this.camera.track);
    if (this.microphone.track) stream.addTrack(this.microphone.track);
    return stream;
  };

  /** Estado agregado para la UI (botones de llamada, indicadores). */
  MediaDeviceManager.prototype.getState = function () {
    return {
      cameraOn: this.camera.isRunning(),
      trackingCameraOn: this.trackingCamera.isRunning(),
      micOn: this.microphone.isRunning(),
      micMuted: this.microphone.isMuted(),
      cameraMuted: this.camera.isMuted(),
      speakerId: this.speaker.deviceId,
      permissions: this.permissions.granted
    };
  };

  /** Detiene todo y libera listeners. */
  MediaDeviceManager.prototype.dispose = function () {
    this.stopCamera();
    this.stopTrackingCamera();
    this.stopMicrophone();
    this.unwatchDeviceChanges();
    this.onChange = null;
  };

  /* ---------------- Export ---------------- */

  var api = {
    MediaDeviceManager: MediaDeviceManager,
    CameraManager: CameraManager,
    MicrophoneManager: MicrophoneManager,
    SpeakerManager: SpeakerManager,
    PermissionManager: PermissionManager,
    supportsMediaDevices: supportsMediaDevices,
    trackDeviceMismatch: trackDeviceMismatch
  };

  global.MM_Media = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
