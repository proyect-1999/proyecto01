// rostro_animado/src/tracking/Backends.js
/* ============================================================
 * Backends.js — Interfaz única de inferencia facial (D3):
 *
 *   backend.init(config)            → Promise<void>
 *   backend.frame(input, tMs)       → Promise<{ t, faces:[{ lm:[[x,y]×N] }] }>
 *   backend.dispose()               → void
 *
 * El payload `rawResult` es IDÉNTICO en ambos caminos, por lo que
 * TrackingBridge/Filters no conocen el backend concreto.
 *
 * Caminos:
 *   • WorkerBackend      — MediaPipe en worker dedicado (primario).
 *   • MainThreadBackend  — MediaPipe en el hilo principal (respaldo funcional).
 *
 * Alcance de navegadores (decisión 3): Safari >= 17 por defecto; bajo esa
 * premisa WorkerBackend es siempre viable y MainThreadBackend NO es camino
 * crítico — queda como fallback explícito ({backend:'main'}) para entornos
 * sin Worker o con CSP que lo prohíba. Revisable si cambia el mínimo soportado.
 * ============================================================ */
(function (global) {
  'use strict';

  var T = (global.MM_Tracking = global.MM_Tracking || {});

  /* ---------------- WorkerBackend ---------------- */

  function WorkerBackend(opts) {
    opts = opts || {};
    var worker = null;
    var ready = false;
    var pending = null;          /* resolver del frame en vuelo (backpressure: 1 in-flight) */
    var lastTs = 0;
    var disposed = false;

    function init(config) {
      config = config || {};
      return new Promise(function (resolve, reject) {
        if (disposed) { reject(new Error('WorkerBackend: backend destruido')); return; }
        try {
          worker = new Worker(opts.workerUrl || 'src/tracking/track.worker.js');
        } catch (e) {
          reject(new Error('WorkerBackend: no se pudo crear el Worker — ' + e.message));
          return;
        }
        var settled = false;
        var to = setTimeout(function () {
          if (settled) return;
          settled = true;
          terminateQuiet();
          reject(new Error('WorkerBackend: timeout de init (' + (config.initTimeoutMs || 15000) + ' ms)'));
        }, config.initTimeoutMs || 15000);

        worker.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.type === 'ready') {
            clearTimeout(to);
            if (!settled) { settled = true; ready = true; resolve(); }
          } else if (m.type === 'result') {
            if (pending) {
              var r = pending; pending = null;
              lastTs = m.t || lastTs;
              r({ t: m.t, faces: m.faces || [] });
            }
          } else if (m.type === 'error') {
            clearTimeout(to);
            var err = new Error('WorkerBackend: ' + m.message);
            if (!settled) { settled = true; terminateQuiet(); reject(err); }
            else if (opts.onError) opts.onError(err);
          } else if (m.type === 'warning' && opts.onWarning) {
            opts.onWarning(new Error(m.message));
          }
        };
        worker.onerror = function (e) {
          clearTimeout(to);
          var err = new Error('WorkerBackend crash: ' + (e && e.message ? e.message : 'desconocido'));
          if (!settled) { settled = true; terminateQuiet(); reject(err); }
          else if (opts.onError) opts.onError(err);
        };
        worker.postMessage({ type: 'init', config: config });
      });
    }

    /** input: ImageBitmap (se TRANSFIERE y consume). Devuelve rawResult o vacío si cae. */
    function frame(input, t) {
      if (!ready || disposed || !worker) {
        if (input && input.close) input.close();
        return Promise.resolve({ t: t, faces: [] });
      }
      /* ts monótono estricto (detectForVideo lo exige): si el reloj retrocede, se descarta el frame. */
      if (t <= lastTs) {
        if (input && input.close) input.close();
        return Promise.resolve({ t: lastTs, faces: [] });
      }
      return new Promise(function (resolve) {
        var settled = false;
        var done = function (res) {
          if (settled) return;
          settled = true;
          pending = null;
          resolve(res);
        };
        pending = function (res) { done(res); };
        try {
          worker.postMessage({ type: 'frame', bitmap: input, t: t }, [input]);
        } catch (e) {
          if (input && input.close) input.close();
          done({ t: t, faces: [] });
          return;
        }
        /* Red de seguridad: worker colgado ⇒ no bloquear el bucle de animación. */
        setTimeout(function () { done({ t: t, faces: [] }); }, 1000);
      });
    }

    function terminateQuiet() {
      if (worker) {
        try { worker.terminate(); } catch (e) { /* noop */ }
        worker = null;
      }
      ready = false;
    }

    function dispose() {
      disposed = true;
      if (worker) { try { worker.postMessage({ type: 'dispose' }); } catch (e) { /* noop */ } }
      terminateQuiet();
      pending = null;
    }

    return { kind: 'worker', init: init, frame: frame, dispose: dispose };
  }

  /* ---------------- MainThreadBackend ---------------- */

  function MainThreadBackend(opts) {
    opts = opts || {};
    var landmarker = null;
    var lastTs = 0;

    async function init(config) {
      if (!T.MpLoader) throw new Error('MainThreadBackend: cargue primero src/tracking/MpLoader.js');
      landmarker = await T.MpLoader.createLandmarker(config || {});
    }

    /** input: HTMLVideoElement directamente (sin copia a canvas). */
    async function frame(input, t) {
      if (!landmarker || !input) return { t: t, faces: [] };
      if (t <= lastTs) return { t: lastTs, faces: [] };
      try {
        var res = landmarker.detectForVideo(input, t);
        lastTs = t;
        return {
          t: t,
          faces: (res.faceLandmarks || []).map(function (lm) {
            var out = new Array(lm.length);
            for (var i = 0; i < lm.length; i++) out[i] = [lm[i].x, lm[i].y];
            return { lm: out };
          })
        };
      } catch (e) {
        if (opts.onError) opts.onError(e);
        return { t: t, faces: [] };
      }
    }

    function dispose() {
      if (landmarker && landmarker.close) landmarker.close();
      landmarker = null;
    }

    return { kind: 'main', init: init, frame: frame, dispose: dispose };
  }

  /**
   * Selección automática (feature detection, no version detection — D16):
   * Worker + ImageBitmap disponibles → worker; si no, hilo principal.
   */
  function autoKind() {
    return (typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined')
      ? 'worker' : 'main';
  }

  function create(kind, opts) {
    var k = kind === 'auto' || kind == null ? autoKind() : kind;
    if (k === 'worker') return WorkerBackend(opts);
    if (k === 'main') return MainThreadBackend(opts);
    throw new Error('Backends.create: backend desconocido "' + k + '" (esperado "worker"|"main"|"auto")');
  }

  T.Backends = {
    WorkerBackend: WorkerBackend,
    MainThreadBackend: MainThreadBackend,
    autoKind: autoKind,
    create: create
  };
})(typeof window !== 'undefined' ? window : globalThis);
