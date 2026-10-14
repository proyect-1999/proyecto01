// rostro_animado/src/tracking/MpLoader.js
/* ============================================================
 * MpLoader.js — Carga única de @mediapipe/tasks-vision desde assets/vendor/.
 *
 * Dos caminos sin reescribir código (decisión 4 del plan):
 *   1. local  (por defecto): WASM + .task servidos desde el repo
 *      → sin CDN, sin CORS externo, sin cuotas; robusto en sandbox/CI.
 *   2. remote (override): opts.cdnBase permite apuntar a un CDN si el
 *      producto prefiere no servir ~7 MB de binarios.
 *
 * El modelo también puede inyectarse como ArrayBuffer vía opts.modelBuffer
 * (fetch propio del host) evitando el segundo request.
 *
 * La Promise de carga se memoiza: una sola import por página.
 * ============================================================ */
(function (global) {
  'use strict';

  var VENDOR_BASE = 'assets/vendor/mediapipe/';
  var _cache = null;

  function assert(cond, msg) {
    if (!cond) throw new Error('MpLoader: ' + msg);
  }

  /**
   * Devuelve { FaceLandmarker, FilesetResolver, resolver } (memoizado).
   * @param {Object} opts { bundleUrl?, cdnBase?, wasmPaths?, forceReload? }
   */
  function load(opts) {
    opts = opts || {};
    if (_cache && !opts.forceReload) return _cache;

    _cache = (async function () {
      var base = opts.bundleUrl || (VENDOR_BASE + 'vision_bundle.mjs');
      var mod;
      try {
        mod = await import(/* webpackIgnore: true */ base);
      } catch (e) {
        /* Reserva remota solo si el host configuró cdnBase explícitamente. */
        if (!opts.cdnBase) {
          throw new Error('MpLoader: no se pudo cargar ' + base + ' — ' + e.message);
        }
        mod = await import(/* webpackIgnore: true */ opts.cdnBase + 'vision_bundle.mjs');
      }
      assert(mod.FaceLandmarker, 'el bundle no exporta FaceLandmarker (¿versión correcta de tasks-vision?)');
      assert(mod.FilesetResolver, 'el bundle no exporta FilesetResolver');

      var wasmRoot = opts.wasmPaths ||
        (opts.cdnBase ? opts.cdnBase + 'wasm/' : VENDOR_BASE + 'wasm/');
      var resolver = await mod.FilesetResolver.forVisionTasks(wasmRoot);
      return {
        FaceLandmarker: mod.FaceLandmarker,
        FilesetResolver: mod.FilesetResolver,
        resolver: resolver
      };
    })().catch(function (e) {
      _cache = null;   /* permitir reintento tras fallo de red/deploy */
      throw e;
    });

    return _cache;
  }

  /**
   * Crea el FaceLandmarker con delegación GPU→CPU automática (mitiga R1 del plan:
   * WebGL bloqueado/fallback en headless o GPUs antiguas).
   * @param {Object} opts { modelPath?, modelBuffer?, delegate?, numFaces?,
   *                        minFaceDetectionConfidence?, minTrackingConfidence?,
   *                        outputFaceBlendshapes? } + opciones de load()
   */
  async function createLandmarker(opts) {
    opts = opts || {};
    var m = await load(opts);
    var hasBuffer = opts.modelBuffer instanceof ArrayBuffer ||
      (typeof Uint8Array !== 'undefined' && opts.modelBuffer instanceof Uint8Array);
    var baseOpts = {
      baseOptions: {
        modelAssetPath: hasBuffer ? undefined : (opts.modelPath || (VENDOR_BASE + 'face_landmarker.task')),
        modelAssetBuffer: hasBuffer ? opts.modelBuffer : undefined,
        delegate: opts.delegate || 'GPU'
      },
      runningMode: 'VIDEO',
      numFaces: opts.numFaces || 1,
      minFaceDetectionConfidence: opts.minFaceDetectionConfidence != null ? opts.minFaceDetectionConfidence : 0.5,
      minTrackingConfidence: opts.minTrackingConfidence != null ? opts.minTrackingConfidence : 0.5,
      outputFaceBlendshapes: !!opts.outputFaceBlendshapes
    };
    try {
      return await m.FaceLandmarker.createFromOptions(m.resolver, baseOpts);
    } catch (gpuErr) {
      if (opts.delegate === 'CPU') throw gpuErr;
      console.warn('[MpLoader] delegate GPU falló (' + gpuErr.message + '), reintentando CPU.');
      baseOpts.baseOptions.delegate = 'CPU';
      return await m.FaceLandmarker.createFromOptions(m.resolver, baseOpts);
    }
  }

  global.MM_Tracking = global.MM_Tracking || {};
  global.MM_Tracking.MpLoader = {
    load: load,
    createLandmarker: createLandmarker,
    VENDOR_BASE: VENDOR_BASE
  };
})(typeof window !== 'undefined' ? window : globalThis);
