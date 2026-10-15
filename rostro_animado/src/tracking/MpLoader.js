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

  /* v2.5.1 — F2: VENDOR_BASE queda ABSOLUTA respecto a document.baseURI.
   * Antes era relativa ('assets/vendor/mediapipe/'): dentro de un worker de
   * origen opaco (data:) o bajo ciertas resoluciones, el import()/fetch la
   * interpretaban contra un base incorrecto → 404 silencioso. Absoluta,
   * funciona igual servido en raíz o en subruta (GitHub Pages). */
  function absUrl(rel, base) {
    try { return new URL(rel || '', base || document.baseURI).href; }
    catch (e) { return rel; }
  }

  /* v2.5.3 — F2 residual: la constante de módulo se resuelve SIEMPRE contra
   * document.baseURI en el momento del uso (los usos son asíncronos y por
   * tanto posteriores a la carga del documento). Si baseURI falta o es
   * anómala (entornos sandbox sin URL base), respaldo determinista:
   * location.href recortado al directorio actual. */
  function vendorBase() {
    var rel = 'assets/vendor/mediapipe/';
    var abs = absUrl(rel);
    if (/^https?:\/\//.test(abs)) return abs;
    try {
      var href = (typeof location !== 'undefined' && location.href) || '';
      var dir = href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
      abs = absUrl(rel, dir);
      if (/^https?:\/\//.test(abs)) return abs;
    } catch (e) { /* noop */ }
    return rel; /* último recurso: relativo (funciona servido en raíz) */
  }
  var _cache = null;
  var _attempts = 0;

  function assert(cond, msg) {
    if (!cond) throw new Error('MpLoader: ' + msg);
  }

  /** Cache-buster con versión única por intento: evita reimportar un módulo
   *  envenenado del grafo y fuerza recarga de workers/módulos obsoletos (F3/F4). */
  function withV(url) {
    var u = absUrl(url);
    u += (u.indexOf('?') >= 0 ? '&' : '?') + 'v=252' + (++_attempts) + Date.now().toString(36);
    return u;
  }

  /**
   * Validación semántica previa al import(): un deploy roto o un portal cautivo
   * pueden servir HTML con status 200; import() entonces produce errores
   * opacos ("Failed to resolve module specifier") que envenenan la caché de
   * módulos. Se exige: res.ok, content-type JS/ESM y firma del bundle.
   */
  async function fetchValidatedEsModule(url, expect) {
    var res;
    try {
      res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      throw new Error('MpLoader: fetch falló para ' + url + ' — ' + e.message);
    }
    if (!res.ok) {
      throw new Error('MpLoader: HTTP ' + res.status + ' al pedir ' + url +
        ' (¿faltan los binarios en assets/vendor/mediapipe/? ¿subruta mal servida?)');
    }
    var ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (/text\/html/.test(ct)) {
      throw new Error('MpLoader: el servidor devolvió HTML (SPA fallback/portal cautivo) en lugar de JS para ' + url);
    }
    var text = await res.text();
    if (!text.trim()) {
      throw new Error('MpLoader: respuesta vacía desde ' + url);
    }
    if (/<(!doctype|html)/i.test(text.slice(0, 512))) {
      throw new Error('MpLoader: contenido HTML servido como módulo en ' + url);
    }
    if (expect && text.indexOf(expect) < 0) {
      throw new Error('MpLoader: el bundle de ' + url + ' no contiene "' + expect +
        '" (¿versión incorrecta de @mediapipe/tasks-vision?)');
    }
    return text;
  }

  /**
   * Importa un texto ESM ya validado vía data: URL. Así el import() real nunca
   * puede quedarse con una copia cacheada obsoleta ni con contenido inválido:
   * lo que se ejecuta es exactamente lo que se descargó y validó.
   */
  async function importEsText(text) {
    var dataUrl = 'data:text/javascript;base64,' + bytesToB64(text);
    return import(/* webpackIgnore: true */ dataUrl);
  }

  function bytesToB64(text) {
    var bytes = new TextEncoder().encode(text);
    var CH = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += CH) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
    }
    return btoa(parts.join(''));
  }

  /**
   * Devuelve { FaceLandmarker, FilesetResolver, resolver } (memoizado).
   * @param {Object} opts { bundleUrl?, cdnBase?, wasmPaths?, forceReload? }
   */
  function load(opts) {
    opts = opts || {};
    if (_cache && !opts.forceReload) return _cache;

    _cache = (async function () {
      var base = opts.bundleUrl || vendorBase() + 'vision_bundle.mjs';
      var mod;
      try {
        /* Camino estricto: fetch + validación semántica + import del texto. */
        var text = await fetchValidatedEsModule(withV(base), 'FilesetResolver');
        mod = await importEsText(text);
      } catch (e) {
        /* Reserva: import directo (solo si el host configuró cdnBase explícito) */
        var fb = opts.cdnBase ? (opts.cdnBase + 'vision_bundle.mjs') : base;
        try {
          mod = await import(/* webpackIgnore: true */ fb);
        } catch (e2) {
          /* Permitir reintento con distinta query en la próxima llamada. */
          _cache = null;
          throw new Error('MpLoader: no se pudo cargar ' + base + ' — ' +
            (e && e.message || e) + ' | respaldo: ' + (e2 && e2.message || e2));
        }
      }
      assert(mod.FaceLandmarker, 'el bundle no exporta FaceLandmarker (¿versión correcta de tasks-vision?)');
      assert(mod.FilesetResolver, 'el bundle no exporta FilesetResolver');

      var wasmRoot = absUrl(opts.wasmPaths ||
        (opts.cdnBase ? opts.cdnBase + 'wasm/' : vendorBase() + 'wasm/'));
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
        modelAssetPath: hasBuffer ? undefined : (opts.modelPath || (vendorBase() + 'face_landmarker.task')),
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
    absUrl: absUrl,
    /* v2.5.2 — getter dinámico: document.baseURI puede cambiar tras la
     * carga del script (history.pushState / redirecciones SPA). Un valor
     * congelado en tiempo de carga reintroduce F2 en subtítulos. */
    get VENDOR_BASE() { return vendorBase(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
