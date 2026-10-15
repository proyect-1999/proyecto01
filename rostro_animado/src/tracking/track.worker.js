// rostro_animado/src/tracking/track.worker.js
/* ============================================================
 * track.worker.js — Backend Worker: inferencia MediaPipe fuera del hilo principal.
 *
 * Protocolo (mensajes planos, sin dependencias externas):
 *   host → worker : { type:'init',  config:{ bundleUrl, wasmPaths, modelUrl|modelBuffer,
 *                                            delegate, numFaces, initTimeoutMs } }
 *                   { type:'frame', bitmap: ImageBitmap (transferible), t }
 *                   { type:'dispose' }
 *   worker → host : { type:'ready' | 'result', t, faces:[{ lm:[[x,y]×478] }] }
 *                   { type:'warning'|'error', message }
 *                   { type:'disposed' }
 *
 * Decisiones de diseño:
 *   • Se reciben ImageBitmap (cero copia de píxeles; el canvas de captura vive
 *     en el host y se transfiere por structured-clone).
 *   • La respuesta es compacta: solo landmarks normalizados a [0,1] con 4
 *     decimales. La matemática de EAR/gaze/pose NO se duplica aquí: vive en
 *     Filters.js y la ejecuta el host, garantizando resultados idénticos entre
 *     WorkerBackend y MainThreadBackend.
 *   • El modelo y el WASM se cargan desde assets/vendor/ (mismas rutas que
 *     MpLoader en el host; los resuelve el caller vía config).
 * ============================================================ */
'use strict';

var landmarker = null;
var mod = null;
var resolver = null;
var seq = 0;

function post(type, payload) {
  self.postMessage(Object.assign({ type: type, seq: ++seq }, payload || {}));
}

/* Codifica texto UTF-8 → base64 en trozos (evita desbordar la pila de
 * fromCharCode con bundles de varios MB). */
function b64FromText(text) {
  var bytes = new TextEncoder().encode(text);
  var CH = 0x8000, parts = [];
  for (var i = 0; i < bytes.length; i += CH) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
  }
  return btoa(parts.join(''));
}

async function initFaceLandmarker(cfg) {
  /* v2.5.1 — Carga estricta (espejo de MpLoader en el host): fetch con
   * validación (res.ok, content-type, firma del bundle, anti-HTML) ANTES de
   * importar. Un error claro tipo "HTTP 404" sustituye al fallo opaco de
   * import(); y si el host no normalizó las rutas (F2), se resuelven aquí
   * contra la URL del propio worker como respaldo. */
  var abs = function (u) { try { return new URL(u, self.location.href).href; } catch (e) { return u; } };
  var bundleUrl = abs(cfg.bundleUrl || 'assets/vendor/mediapipe/vision_bundle.mjs');
  cfg.wasmPaths = abs(cfg.wasmPaths || 'assets/vendor/mediapipe/wasm/');
  if (cfg.modelUrl) cfg.modelUrl = abs(cfg.modelUrl);

  var text;
  try {
    var res = await fetch(bundleUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' al pedir ' + bundleUrl);
    var ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (/text\/html/.test(ct)) throw new Error('el servidor devolvió HTML (no JS) para ' + bundleUrl);
    text = await res.text();
    if (!text.trim()) throw new Error('respuesta vacía desde ' + bundleUrl);
    if (/<(!doctype|html)/i.test(text.slice(0, 512))) throw new Error('contenido HTML servido como módulo en ' + bundleUrl);
    if (text.indexOf('FilesetResolver') < 0) throw new Error('el bundle de ' + bundleUrl + ' no exporta FilesetResolver (versión incorrecta de tasks-vision)');
  } catch (eFetch) {
    /* Reintento único con cache-buster (URL distinta ⇒ sin caché ni módulo
     * envenenado en el grafo); si también falla, se propaga el error claro. */
    var bust = bundleUrl + (bundleUrl.indexOf('?') >= 0 ? '&' : '?') + 'v=' + Date.now().toString(36);
    try {
      var r2 = await fetch(bust, { credentials: 'same-origin', cache: 'no-store' });
      if (!r2.ok) throw new Error('HTTP ' + r2.status);
      text = await r2.text();
      if (!text.trim() || /<(!doctype|html)/i.test(text.slice(0, 512))) throw new Error('contenido inválido');
    } catch (e2) {
      throw new Error('track.worker: no se pudo cargar el bundle MediaPipe — ' +
        (eFetch && eFetch.message || eFetch) + ' | reintento: ' + (e2 && e2.message || e2));
    }
  }
  mod = await import('data:text/javascript;base64,' + b64FromText(text));
  if (!mod.FaceLandmarker || !mod.FilesetResolver) {
    throw new Error('el bundle no exporta FaceLandmarker/FilesetResolver');
  }
  resolver = await mod.FilesetResolver.forVisionTasks(cfg.wasmPaths);
  var hasBuffer = cfg.modelBuffer instanceof ArrayBuffer ||
    (typeof Uint8Array !== 'undefined' && cfg.modelBuffer instanceof Uint8Array);
  var opts = {
    baseOptions: {
      modelAssetPath: hasBuffer ? undefined : (cfg.modelUrl || cfg.modelPath || 'assets/vendor/mediapipe/face_landmarker.task'),
      modelAssetBuffer: hasBuffer ? cfg.modelBuffer : undefined,
      delegate: cfg.delegate || 'GPU'
    },
    runningMode: 'VIDEO',
    numFaces: cfg.numFaces || 1,
    minFaceDetectionConfidence: cfg.minFaceDetectionConfidence != null ? cfg.minFaceDetectionConfidence : 0.5,
    minTrackingConfidence: cfg.minTrackingConfidence != null ? cfg.minTrackingConfidence : 0.5,
    outputFaceBlendshapes: false
  };
  try {
    return await mod.FaceLandmarker.createFromOptions(resolver, opts);
  } catch (gpuErr) {
    if (cfg.delegate === 'CPU') throw gpuErr;
    post('warning', { message: 'GPU no disponible, usando CPU: ' + (gpuErr.message || gpuErr) });
    opts.baseOptions.delegate = 'CPU';
    return await mod.FaceLandmarker.createFromOptions(resolver, opts);
  }
}

self.onmessage = async function (ev) {
  var msg = ev.data || {};
  try {
    if (msg.type === 'init') {
      if (landmarker) { post('ready', {}); return; }
      landmarker = await initFaceLandmarker(msg.config || {});
      post('ready', { delegate: landmarker.baseOptions ? landmarker.baseOptions.delegate : undefined });
      return;
    }

    if (msg.type === 'frame') {
      var bitmap = msg.bitmap;
      if (!landmarker || !bitmap) {
        if (bitmap) bitmap.close();
        return;
      }
      /* ts monótono en ms exigido por detectForVideo; si llega desordenado, se descarta. */
      var ts = +msg.t;
      if (!isFinite(ts)) { bitmap.close(); return; }
      var res = landmarker.detectForVideo(bitmap, ts);
      bitmap.close();
      var faces = (res.faceLandmarks || []).map(function (lm) {
        var out = new Array(lm.length);
        for (var i = 0; i < lm.length; i++) {
          out[i] = [+lm[i].x.toFixed(4), +lm[i].y.toFixed(4)];
        }
        return { lm: out };
      });
      post('result', { t: ts, faces: faces });
      return;
    }

    if (msg.type === 'dispose') {
      if (landmarker && landmarker.close) landmarker.close();
      landmarker = null; mod = null; resolver = null;
      post('disposed', {});
      return;
    }
  } catch (e) {
    post('error', { message: String((e && e.message) || e) });
  }
};
