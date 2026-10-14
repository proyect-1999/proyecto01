// rostro_animado/src/tracking/TrackingBridge.js
/* ============================================================
 * TrackingBridge.js — Orquestador del seguimiento facial.
 *
 *   MM_Media (cámara, permisos)  →  backend (Worker|Main)  →  Filters
 *                                                            (One Euro)
 *                                   ↓
 *                          EngineAdapter → motor MoodMates
 *
 * FSM de PRESENCIA (D11 fusionado): IDLE → ACQUIRING → ACTIVE ⇄ LOST, ERROR.
 * La FSM SOLO gestiona presencia: NO decide emociones de reposo/sueño por
 * tiempo (eso ya lo hace el motor vía opts.idle standbyAfter/sleepAfter);
 * mientras hay rostro el bridge llama resetIdle() y el reloj de inactividad
 * se reinicia solo. M6 del plan queda absorbido.
 *
 * Emociones: MM_EmotionPolicy (mapa tracking inyectable + validación exists).
 * Exclusión mutua D13: al arrancar/parar se notifica 'tracking-state' para
 * que el host conmute policy.setOwner('tracking'|'call').
 *
 * Gaze/párpados/yaw (fusiones 5-6): setGaze con {source:'tracker', priority:10}
 * (el árbitro del motor da prioridad al tracker sobre el puntero), setEyeOpen
 * [0,1] o null, setLookYaw(rad) por canal propio lookYaw — body.yaw sigue
 * reservado para spin/fx.
 * ============================================================ */
(function (global) {
  'use strict';

  var T = (global.MM_Tracking = global.MM_Tracking || {});

  var STATES = ['IDLE', 'ACQUIRING', 'ACTIVE', 'LOST', 'ERROR'];
  var TRACKER_PRIORITY = 10;    /* > puntero (1) — árbitro del motor */

  function requireFilters() {
    if (!T.Filters) throw new Error('MM_Tracking: cargue primero src/tracking/Filters.js');
    return T.Filters;
  }

  /* ---------------- EngineAdapter (D16: fachada de capacidades) ---------------- */

  /**
   * Adapta una instancia MoodMates a las necesidades del tracker SIN asumir
   * versión del motor: feature detection puro. Motores antiguos simplemente
   * pierden párpados/pose (no-op) pero conservan la mirada.
   */
  T.EngineAdapter = function (mate) {
    if (!mate || typeof mate.handleAIMessage !== 'function') {
      throw new Error('EngineAdapter: se requiere una instancia del motor MoodMates');
    }
    return {
      mate: mate,   /* referencia para que el host detecte cambios de instancia */
      setGaze: function (x, y, meta) {
        mate.setGaze(x, y, meta || { source: 'tracker', priority: TRACKER_PRIORITY });
      },
      clearGaze: function (meta) {
        mate.clearGaze(meta || { source: 'tracker' });
      },
      setEyeOpen: typeof mate.setEyeOpen === 'function'
        ? function (v) { mate.setEyeOpen(v); }
        : function () {},
      setLookYaw: typeof mate.setLookYaw === 'function'
        ? function (rad) { mate.setLookYaw(rad); }
        : function () {},
      handleAIMessage: function (msg) { return mate.handleAIMessage(msg); },
      resetIdle: function () { if (typeof mate.resetIdle === 'function') mate.resetIdle(); },
      hasEyeControl: typeof mate.setEyeOpen === 'function',
      hasPoseChannel: typeof mate.setLookYaw === 'function'
    };
  };

  /* ---------------- Factoría del bridge ---------------- */

  /**
   * @param {Object} opts
   *   mate            instancia MoodMates (obligatoria)
   *   media           MediaDeviceManager existente → usa startTrackingCamera (D14)
   *   stream          MediaStream externo compartido (modo overlay de llamada)
   *   videoElement    <video> propio del host (si quiere ver el feed)
   *   policy          MM_EmotionPolicy.create(...) — si falta se crea default
   *   constraints     { width, height, frameRate } para la cámara de tracking
   *   deviceId        cámara concreta para tracking (opcional)
   *   backend         'auto'|'worker'|'main'
   *   workerUrl       ruta del track.worker.js (default 'src/tracking/track.worker.js')
   *   loader          override MpLoader {bundleUrl, wasmPaths, modelPath, modelBuffer, cdnBase}
   *   delegate        'GPU'|'CPU' (default GPU con fallback CPU automático)
   *   lostAfterMs     sin rostro N ms → LOST (default 800)
   *   probeEveryMs    frecuencia de sondeo en LOST/ERROR (default 500)
   *   earClosed / earOpen  umbrales de calibración EAR (default 0.06/0.22)
   *   mirror          espejar horizontalmente (default true)
   *   oneEuro         { minCutoff, beta, dCutoff } (default 1.0/0.007/1.0)
   *   onState(evt,data)/onError(err)  atajos además de .on()
   */
  T.create = function (opts) {
    opts = opts || {};
    var F = requireFilters();
    if (!opts.mate) throw new Error('MM_Tracking.create: opts.mate es obligatorio');

    var adapter = T.EngineAdapter(opts.mate);
    var policy = opts.policy ||
      (global.MM_EmotionPolicy && global.MM_EmotionPolicy.create({
        tracking: opts.trackingMap,
        exists: global.MoodMates && global.MoodMates.config
          ? function (id) { return !!global.MoodMates.config.getRaw(id); }
          : null
      }));
    if (!policy) throw new Error('MM_Tracking.create: no hay MM_EmotionPolicy disponible (cargue src/media/EmotionPolicy.js)');

    var lostAfterMs = opts.lostAfterMs != null ? opts.lostAfterMs : 800;
    var probeEveryMs = opts.probeEveryMs != null ? opts.probeEveryMs : 500;
    var earClosed = opts.earClosed != null ? opts.earClosed : 0.06;
    var earOpen = opts.earOpen != null ? opts.earOpen : 0.22;
    var mirror = opts.mirror !== false;
    var oe = opts.oneEuro || {};

    var state = 'IDLE';
    var listeners = [];
    var rafId = 0;
    var stopped = true;
    var lastSeenAt = 0;
    var lastProbeAt = 0;
    var inflight = false;
    var backend = null;
    var ownStream = !opts.stream;   /* ¿gestionamos la cámara o compartimos la del host? */

    var bank = F.oneEuroBank(['gx', 'gy', 'open', 'yaw'],
      oe.minCutoff != null ? oe.minCutoff : 1.0,
      oe.beta != null ? oe.beta : 0.007,
      oe.dCutoff != null ? oe.dCutoff : 1.0);

    /* ---- vídeo de captura (oculto salvo que el host dé uno visible) ---- */
    var video = opts.videoElement || document.createElement('video');
    if (!opts.videoElement) {
      video.muted = true; video.playsInline = true; video.autoplay = true;
      video.style.position = 'absolute';
      video.style.width = '1px';
      video.style.height = '1px';
      video.style.opacity = '0';
      video.style.pointerEvents = 'none';
      document.body.appendChild(video);
    }
    video.setAttribute('aria-hidden', 'true');

    var canvas = document.createElement('canvas');
    canvas.width = opts.captureWidth || 320;
    canvas.height = opts.captureHeight || 240;
    var ctx = canvas.getContext('2d');

    /* ---- eventos ---- */
    function emit(evt, data) {
      listeners.slice().forEach(function (fn) {
        try { fn(evt, data); } catch (e) { console.error('[MM_Tracking]', e); }
      });
    }

    function setState(s, why) {
      if (s === state) return;
      var prev = state;
      state = s;
      var payload = { from: prev, to: s, reason: why || null };
      emit('state', payload);
      /* D13 exclusión mutua: el host decide cómo propagar el owner; se expone
       * como evento para que app/call.js haga policy.setOwner(...) y reacciones. */
      emit('tracking-state', payload);
      /* v2.3.1 — Señales emocionales SOLO si el bridge es dueño del bot (D13)
       * y hay política configurada. Antes se emitía handleAIMessage en todo
       * start/stop/lost: en modo standalone (sin backend de IA) eso secuestraba
       * la expresión del personaje con '03'/'02' arbitrarios y reiniciaba
       * transiciones — el usuario veía la animación "luchar" contra el tracker.
       * opts.signals:false desactiva por completo las señales de emoción. */
      /* Owner por defecto 'call': si nadie gestiona el owner (modo standalone),
       * las señales de emoción se suprimen — el tracking solo mueve mirada,
       * párpados y giro de cabeza, nunca la expresión. */
      var emotional = opts.signals !== false && !!policy;
      if (s === 'LOST') {
        if (emotional && policy.owner() === 'tracking') {
          adapter.handleAIMessage({ emotionId: policy.tracking('lost') });
        }
        adapter.setEyeOpen(null);
        adapter.clearGaze({ source: 'tracker' });
        adapter.setLookYaw(0);
      } else if (s === 'ERROR') {
        if (emotional && policy.owner() === 'tracking') {
          adapter.handleAIMessage({ emotionId: policy.tracking('error') });
        }
        emit('error', { message: why || 'error de tracking' });
      } else if (s === 'ACTIVE' && prev === 'LOST') {
        /* Recuperación desde LOST: semilla 'present'. Desde ACQUIRING NO se
         * emite — al arrancar, el motor ya está en su estado natural. */
        if (emotional && policy.owner() === 'tracking') {
          adapter.handleAIMessage({ emotionId: policy.tracking('present') });
        }
      }
    }

    /* ---- procesamiento de un resultado crudo del backend ---- */
    function onFrame(raw) {
      if (stopped) return;
      var now = performance.now();
      if (!raw || !raw.faces || !raw.faces.length) {
        if ((state === 'ACTIVE' || state === 'ACQUIRING') && now - lastSeenAt > lostAfterMs) {
          setState('LOST', 'timeout-presencia');
        }
        return;
      }
      lastSeenAt = now;
      if (state !== 'ACTIVE') setState('ACTIVE', 'rostro-detectado');

      var lmArr = raw.faces[0].lm.map(function (p) { return { x: p[0], y: p[1] }; });

      var earL = F.eyeAspectRatio(lmArr, 'left');
      var earR = F.eyeAspectRatio(lmArr, 'right');
      var gazeL = F.irisGaze(lmArr, 'left');
      var gazeR = F.irisGaze(lmArr, 'right');
      /* Convención de signo (v2.3.2): el escenario NO aplica scaleX(-1) al
       * personaje, así que la pantalla coincide con las coordenadas crudas de
       * la cámara. Con mirror=true (vista espejada del usuario) se voltea x:
       * cabeza girada a la derecha del usuario → yaw positivo → bot gira a su
       * derecha en pantalla. yawFromLandmarks(mirror=false) entrega el yaw
       * crudo de imagen; aquí se aplica el volteo una sola vez. */
      var pose = F.yawFromLandmarks(lmArr, false);
      var yawOut = mirror ? -pose.yaw : pose.yaw;

      /* v2.3.2 FIX — Doble inversión eliminada: irisGaze ya devuelve x en
       * coordenadas de CABEZA (el ojo derecho se voltea internamente con sx=-1).
       * Multiplicar otra vez por (mirror?-1:1) invertía la mirada horizontal:
       * el bot miraba al lado contrario del usuario y el efecto parecía "no
       * seguir el rostro". mirror solo afecta a yawFromLandmarks. */
      var g = F.sanitizeVec(
        (gazeL.x + gazeR.x) / 2,
        (gazeL.y + gazeR.y) / 2
      );
      var openAvg = F.opennessFromEAR((earL + earR) / 2, earClosed, earOpen);

      var f = bank.filter(now / 1000, { gx: g.x, gy: g.y, open: openAvg, yaw: yawOut });
      var s = F.sanitizeVec(f.gx, f.gy);

      adapter.setGaze(s.x, s.y, { source: 'tracker', priority: TRACKER_PRIORITY });
      adapter.setLookYaw(F.clamp(f.yaw, -0.6, 0.6));
      adapter.setEyeOpen(F.clamp(f.open, 0, 1));
      adapter.resetIdle();          /* fusión D11/M6: presencia ≠ emoción; el motor decide tiempos */
    }

    /* ---- bucle rAF con backpressure de 1 inferencia en vuelo ---- */
    async function loop() {
      if (stopped) return;
      rafId = requestAnimationFrame(loop);
      if (inflight || !backend) return;
      if (video.readyState < 2) return;
      if (state === 'LOST' || state === 'ERROR') {
        var n = performance.now();
        if (n - lastProbeAt < probeEveryMs) return;
        lastProbeAt = n;
      }
      inflight = true;
      try {
        var t = performance.now();
        var raw;
        if (backend.kind === 'worker') {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var bmp = await createImageBitmap(canvas);
          raw = await backend.frame(bmp, t);
        } else {
          raw = await backend.frame(video, t);
        }
        onFrame(raw);
      } catch (e) {
        if (state !== 'ERROR') setState('ERROR', String((e && e.message) || e));
      } finally {
        inflight = false;
      }
    }

    /* ---- adquisición de stream (D14: siempre a través de MM_Media cuando existe) ---- */
    async function acquireStream() {
      if (opts.stream) {
        video.srcObject = opts.stream;
        ownStream = false;
        return;
      }
      if (opts.media && typeof opts.media.startTrackingCamera === 'function') {
        /* Camino canónico: segunda CameraManager dentro de MM_Media —
         * permisos, getUserMedia inyectable y eventos ya resueltos allí. */
        video.srcObject = await opts.media.startTrackingCamera(opts.constraints, opts.deviceId);
        return;
      }
      /* Sin MM_Media (páginas de demo): getUserMedia directo con constraints
       * bajos; el consentimiento lo debe haber gestionado el host antes. */
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia no disponible y no se proveyó opts.media/stream');
      }
      var stream = await navigator.mediaDevices.getUserMedia({
        video: Object.assign({ facingMode: 'user' }, opts.constraints || { width: 320, height: 240, frameRate: 30 }),
        audio: false
      });
      video.srcObject = stream;
    }

    function releaseStream() {
      if (!ownStream) return;
      if (opts.media && typeof opts.media.stopTrackingCamera === 'function') {
        opts.media.stopTrackingCamera();
      } else if (video.srcObject) {
        video.srcObject.getTracks().forEach(function (tr) { tr.stop(); });
      }
      video.srcObject = null;
    }

    /* ---- ciclo de vida ---- */
    var bridge = {
      states: STATES,
      get state() { return state; },
      get kind() { return backend ? backend.kind : null; },
      adapter: adapter,
      policy: policy,

      on: function (fn) {
        if (typeof fn === 'function') listeners.push(fn);
        return bridge;
      },

      start: async function () {
        if (state === 'ACQUIRING' || state === 'ACTIVE') return;
        setState('ACQUIRING', 'start');
        try {
          var cfg = Object.assign({
            bundleUrl: 'assets/vendor/mediapipe/vision_bundle.mjs',
            wasmPaths: 'assets/vendor/mediapipe/wasm/',
            modelPath: 'assets/vendor/mediapipe/face_landmarker.task',
            delegate: opts.delegate || 'GPU',
            numFaces: 1,
            /* v2.3.2 — umbrales bajados de 0.5 (default) a 0.3: con iluminación
             * mediocre/webcams de portátil el detector por debajo de 0.5 no
             * entregaba caras y el bridge nunca llegaba a ACTIVE ("no sigue el
             * rostro" sin ningún error en consola). */
            minFaceDetectionConfidence: opts.minFaceDetectionConfidence != null ? opts.minFaceDetectionConfidence : 0.3,
            minTrackingConfidence: opts.minTrackingConfidence != null ? opts.minTrackingConfidence : 0.3
          }, opts.loader || {});
          /* Normalización de claves: MpLoader usa modelPath; el worker usa
           * modelUrl. Sin esto, en el camino Worker el landmarker se creaba sin
           * modelo (modelAssetPath undefined) y la inferencia devolvía 0 caras:
           * "no sigue el rostro" incluso con todo lo demás correcto. */
          cfg.modelUrl = cfg.modelUrl || cfg.modelPath;
          backend = T.Backends
            ? T.Backends.create(opts.backend || 'auto', {
                workerUrl: opts.workerUrl,
                onError: function (e) { emit('warning', { message: e.message }); }
              })
            : null;
          if (!backend) throw new Error('cargue primero src/tracking/Backends.js');
          await backend.init(cfg);
          await acquireStream();
          await video.play();
          stopped = false;
          lastSeenAt = performance.now();
          loop();
        } catch (e) {
          stopped = true;
          setState('ERROR', String((e && e.message) || e));
          if (backend) { backend.dispose(); backend = null; }
          throw e;
        }
      },

      stop: function () {
        stopped = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (backend) { backend.dispose(); backend = null; }
        releaseStream();
        bank.reset();
        adapter.setEyeOpen(null);
        adapter.clearGaze({ source: 'tracker' });
        adapter.setLookYaw(0);
        setState('IDLE', 'stop');
      },

      /* Overlay de llamada: suspende sin destruir (stream compartido) o libera
       * la cámara propia si es exclusiva (evita dos luces LED encendidas). */
      suspend: function () {
        if (ownStream) { bridge.stop(); return; }
        stopped = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        setState('LOST', 'suspendido-por-llamada');
      },
      resume: function () {
        if (ownStream) { bridge.start().catch(function () { /* ERROR ya emitido */ }); return; }
        if (stopped) {
          stopped = false;
          lastSeenAt = performance.now();
          setState('ACQUIRING', 'resume');
          loop();
        }
      },

      /* API pública de remapeo (pregunta abierta §7.1 del plan → resuelta sí): */
      setEmotionMap: function (patch) {
        policy.setTrackingMap(patch);
        return bridge;
      },

      destroy: function () {
        bridge.stop();
        listeners.length = 0;
        if (!opts.videoElement && video.parentNode) video.parentNode.removeChild(video);
      }
    };

    if (opts.onError) bridge.on(function (evt, data) { if (evt === 'error') opts.onError(data); });
    if (opts.onState) bridge.on(function (evt, data) { if (evt === 'state') opts.onState(data); });

    return bridge;
  };
})(typeof window !== 'undefined' ? window : globalThis);
