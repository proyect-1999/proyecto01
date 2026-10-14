// rostro_animado/src/tracking/Filters.js
/* ============================================================
 * Filters.js — Matemática pura del tracking (sin DOM, testeable en Node).
 *
 *   • OneEuroFilter (D17): suavizado adaptativo corte-velocidad. Opera a la
 *     frecuencia del tracker (~30 Hz), INDEPENDIENTE del suavizado exponencial
 *     del motor (que trabaja a 60 fps sobre objetivos ya filtrados): no hay
 *     doble suavizado redundante, cada uno cumple su función.
 *   • eyeAspectRatio / opennessFromEAR (D6): apertura de párpado a partir de
 *     landmarks canónicos de MediaPipe FaceMesh.
 *   • irisGaze (D7): mirada relativa del iris dentro del contorno ocular ±1.
 *   • yawFromLandmarks (D9/D10): yaw/pitch/roll aproximados; se entrega como
 *     canal lookYaw SEPARADO del body.yaw del motor (los giros de spin siguen
 *     siendo exclusivos de spin/fx y no se disparan con la cabeza del usuario).
 *
 * Convención de ejes (D8): x+ derecha, y+ abajo, origen arriba-izquierda del
 * frame normalizado [0,1]. Con imagen espejada el caller pasa mirror=true.
 * Saneo: cualquier NaN/Infinity se sustituye por neutro antes de llegar al motor.
 * ============================================================ */
(function (global) {
  'use strict';

  function clamp(v, a, b) {
    v = +v;
    if (!isFinite(v)) return a;
    return v < a ? a : (v > b ? b : v);
  }

  /* ---------------- Filtro de paso bajo (base de One Euro) ---------------- */

  function Lowpass(cutoff) {
    this.cutoff = cutoff;
    this.h = null;
    this.lastT = 0;
  }
  Lowpass.prototype.filter = function (t, x) {
    if (this.h == null) { this.h = x; this.lastT = t; return x; }
    var dt = Math.max(t - this.lastT, 1e-4);
    var tau = 1 / (2 * Math.PI * this.cutoff);
    var a = 1 / (1 + tau / dt);
    this.h = this.h + a * (x - this.h);
    this.lastT = t;
    return this.h;
  };

  /* ---------------- One Euro (Casini et al., CHI 2012) ---------------- */

  function OneEuro(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff != null ? minCutoff : 1.0;
    this.beta = beta != null ? beta : 0.007;
    this.dCutoff = dCutoff != null ? dCutoff : 1.0;
    this.xf = new Lowpass(this.minCutoff);
    this.dxf = new Lowpass(this.dCutoff);
    this.lastT = null;
    this.lastX = null;
  }
  /**
   * Filtra una muestra. t SIEMPRE en segundos (monótono).
   * Muestras basura (NaN/undefined) devuelven la última salida válida.
   */
  OneEuro.prototype.filter = function (t, x) {
    t = +t; x = +x;
    if (!isFinite(t) || !isFinite(x)) {
      return this.xf.h != null ? this.xf.h : 0;
    }
    if (this.lastT == null) {
      this.lastT = t; this.lastX = x;
      this.xf = new Lowpass(this.minCutoff);
      this.dxf = new Lowpass(this.dCutoff);
      return this.xf.filter(t, x);
    }
    var dt = Math.max(t - this.lastT, 1e-4);
    var dx = (x - this.lastX) / dt;
    var dxF = this.dxf.filter(t, dx);
    var cutoff = this.minCutoff + this.beta * Math.abs(dxF);
    this.xf.cutoff = cutoff;
    var out = this.xf.filter(t, x);
    this.lastT = t; this.lastX = x;
    return out;
  };
  OneEuro.prototype.reset = function () {
    this.xf = new Lowpass(this.minCutoff);
    this.dxf = new Lowpass(this.dCutoff);
    this.lastT = null; this.lastX = null;
  };

  /** Banco de filtros OneEuro por clave (una instancia por señal). */
  function oneEuroBank(keys, minCutoff, beta, dCutoff) {
    var bank = {};
    keys.forEach(function (k) { bank[k] = new OneEuro(minCutoff, beta, dCutoff); });
    return {
      filter: function (t, values) {
        var out = {};
        for (var k in bank) {
          out[k] = bank[k].filter(t, values[k]);
        }
        return out;
      },
      reset: function () {
        for (var k in bank) bank[k].reset();
      }
    };
  }

  /* ---------------- Índices canónicos FaceMesh (478 puntos) ---------------- */

  var LM = {
    LEFT_IRIS: [468, 469, 470, 471, 472],
    RIGHT_IRIS: [473, 474, 475, 476, 477],
    LEFT_EYE: { outer: 33, inner: 133, top: 159, bottom: 145 },
    RIGHT_EYE: { outer: 362, inner: 263, top: 386, bottom: 374 },
    NOSE_TIP: 1,
    FACE_CENTER: 168,
    FOREHEAD: 103,
    CHIN: 152,
    LEFT_CHEEK: 234,
    RIGHT_CHEEK: 454
  };

  /** EAR (Eye Aspect Ratio) normalizado ~[0, 0.4]. lm = [{x,y}, …] normalizados. */
  function eyeAspectRatio(lm, side) {
    var e = side === 'left' ? LM.LEFT_EYE : LM.RIGHT_EYE;
    if (!lm[e.outer] || !lm[e.inner] || !lm[e.top] || !lm[e.bottom]) return 0.2;
    var h = Math.hypot(lm[e.outer].x - lm[e.inner].x, lm[e.outer].y - lm[e.inner].y) || 1e-6;
    var v = Math.abs(lm[e.top].y - lm[e.bottom].y);
    return v / h;
  }

  /** Convierte EAR a apertura [0,1] con umbrales calibrables (closed/openRef). */
  function opennessFromEAR(ear, closed, openRef) {
    return clamp((ear - closed) / Math.max(openRef - closed, 1e-4), 0, 1);
  }

  /**
   * Gaze relativo del iris dentro del ojo, ±1 (D7).
   * side: 'left'|'right' (anatomía del usuario, no de la imagen).
   */
  function irisGaze(lm, side) {
    var e = side === 'left' ? LM.LEFT_EYE : LM.RIGHT_EYE;
    var irisIdx = side === 'left' ? LM.LEFT_IRIS[0] : LM.RIGHT_IRIS[0];
    if (!lm[e.outer] || !lm[e.inner] || !lm[e.top] || !lm[e.bottom] || !lm[irisIdx]) {
      return { x: 0, y: 0 };
    }
    var cx = (lm[e.outer].x + lm[e.inner].x) / 2;
    var cy = (lm[e.top].y + lm[e.bottom].y) / 2;
    var hw = Math.abs(lm[e.outer].x - lm[e.inner].x) / 2 || 1e-6;
    var hh = Math.abs(lm[e.top].y - lm[e.bottom].y) / 2 || 1e-6;
    var iris = lm[irisIdx];
    /* Ojo derecho del usuario: el conducto (outer) queda a la izquierda en
     * coordenadas de imagen → se invierte el eje horizontal. */
    var sx = side === 'right' ? -1 : 1;
    return {
      x: clamp(((iris.x - cx) * sx) / (hw * 0.6), -1, 1),
      y: clamp((iris.y - cy) / (hh * 0.6), -1, 1)
    };
  }

  /**
   * Pose aproximada (rad) desde landmarks (equivalente robusto a descomponer
   * la matriz 4x4; más estable numéricamente con un solo rostro).
   * mirror=true corrige el signo de yaw para imágenes espejadas.
   */
  function yawFromLandmarks(lm, mirror) {
    var s = mirror ? -1 : 1;
    var tip = lm[LM.NOSE_TIP], ctr = lm[LM.FACE_CENTER];
    var l = lm[LM.LEFT_CHEEK], r = lm[LM.RIGHT_CHEEK];
    if (!tip || !ctr || !l || !r) return { yaw: 0, pitch: 0, roll: 0 };
    var mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
    var span = Math.hypot(l.x - r.x, l.y - r.y) || 1e-6;
    var yaw = s * Math.atan2(tip.x - mid.x, span * 0.9);
    var pitch = Math.atan2(tip.y - mid.y, span * 0.9);
    var roll = Math.atan2(r.y - l.y, r.x - l.x);
    return {
      yaw: clamp(yaw, -1.2, 1.2),
      pitch: clamp(pitch, -0.9, 0.9),
      roll: clamp(roll, -0.8, 0.8)
    };
  }

  /** Saneo final D8: nunca propagar NaN/Infinity al motor. */
  function sanitizeVec(nx, ny) {
    return {
      x: isFinite(nx) ? clamp(nx, -1, 1) : 0,
      y: isFinite(ny) ? clamp(ny, -1, 1) : 0
    };
  }

  var api = {
    clamp: clamp,
    Lowpass: Lowpass,
    OneEuro: OneEuro,
    oneEuroBank: oneEuroBank,
    LANDMARKS: LM,
    eyeAspectRatio: eyeAspectRatio,
    opennessFromEAR: opennessFromEAR,
    irisGaze: irisGaze,
    yawFromLandmarks: yawFromLandmarks,
    sanitizeVec: sanitizeVec
  };

  global.MM_Tracking = global.MM_Tracking || {};
  global.MM_Tracking.Filters = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
