// rostro_animado/src/tracking/FaceSelector.js
/* ============================================================
 * FaceSelector.js — Selección temporal del rostro objetivo (multi-cara).
 * Puro, sin DOM, testeable en Node (mismo patrón que Filters.js).
 *
 * Criterios (plan §3):
 *   1. Continuidad espacial: bbox actual vs predicción por velocidad (suavizado
 *      exponencial) → decaimiento gaussiano del bonus de lock.
 *   2. Estabilidad temporal: el rostro bloqueado solo se suelta si otro lo
 *      supera durante holdMs (histéresis anti-parpadeo de identidad).
 *   3. Actividad de habla: varianza de apertura de labios en ventana deslizante
 *      (indicio, NO prueba de quién habla). Punto de inyección para VAD externo
 *      vía setVoiceActivity(faceKeyHint, level) — contrato desacoplado.
 *   4. Tamaño y posición: área normalizada + centralidad como desempate.
 *
 * Contrato de entrada: faces = [{ lm:[[x,y]×478], key?:string|number }]
 *   - `key` opcional: si el backend provee tracking-id estable, la continuidad
 *     se ancla a la clave y la IoU pasa a criterio secundario.
 * Salida select(): { index, face, score, locked, switched } | null
 * ============================================================ */
(function (global) {
  'use strict';

  /* Landmarks de boca MediaPipe FaceMesh (extremos + centro vertical) */
  var MOUTH_L = 61, MOUTH_R = 291, LIP_T = 13, LIP_B = 14;

  function clamp(v, a, b) { v = +v; if (!isFinite(v)) return a; return v < a ? a : (v > b ? b : v); }

  function bboxOf(lm) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < lm.length; i++) {
      var p = lm[i]; if (!p) continue;
      var x = +p[0], y = +p[1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) return null;
    return { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX, h: maxY - minY };
  }

  function mouthOpen(lm) {
    var t = lm[LIP_T], b = lm[LIP_B], l = lm[MOUTH_L], r = lm[MOUTH_R];
    if (!t || !b || !l || !r) return 0;
    var spanW = Math.hypot(r[0] - l[0], r[1] - l[1]) || 1e-6;
    return Math.abs(t[1] - b[1]) / spanW;
  }

  function centerDist(bb) {
    return Math.hypot((bb.x0 + bb.x1) / 2 - 0.5, (bb.y0 + bb.y1) / 2 - 0.5);
  }

  /**
   * @param {Object} opts
   *   maxFaces        caras evaluadas por frame (def. 3)
   *   lockBonus       peso del bonus de continuidad (def. 0.35)
   *   sigma           tolerancia espacial en fracción del tamaño facial (def. 0.6)
   *   talkWeight      peso de la actividad de habla/varianza labial (def. 0.20)
   *   vadWeight       peso de la señal VAD externa inyectada (def. 0.45)
   *   areaWeight      peso de tamaño (def. 0.20)
   *   centerWeight    peso de centralidad (def. 0.10)
   *   switchHoldMs    histéresis antes de cambiar de objetivo (def. 1200)
   *   lostGraceMs     frames sin match antes de liberar el lock (def. 1500)
   *   talkWindowMs    ventana de varianza labial (def. 1500)
   */
  function create(opts) {
    opts = opts || {};
    var cfg = {
      maxFaces: clamp(opts.maxFaces != null ? opts.maxFaces : 3, 1, 8) | 0,
      lockBonus: clamp(opts.lockBonus != null ? opts.lockBonus : 0.35, 0, 1),
      sigma: clamp(opts.sigma != null ? opts.sigma : 0.6, 0.1, 2),
      talkWeight: opts.talkWeight != null ? opts.talkWeight : 0.20,
      vadWeight: opts.vadWeight != null ? opts.vadWeight : 0.45,
      areaWeight: opts.areaWeight != null ? opts.areaWeight : 0.20,
      centerWeight: opts.centerWeight != null ? opts.centerWeight : 0.10,
      switchHoldMs: clamp(opts.switchHoldMs != null ? opts.switchHoldMs : 1200, 0, 10000),
      lostGraceMs: clamp(opts.lostGraceMs != null ? opts.lostGraceMs : 1500, 100, 10000),
      talkWindowMs: clamp(opts.talkWindowMs != null ? opts.talkWindowMs : 1500, 200, 10000)
    };

    var tracks = [];            /* tracklets: { key, box, vel, lastSeen, talkSamples[], talkVar, vadLevel } */
    var lockedTrack = null;     /* referencia al tracklet objetivo */
    var bestChallenger = null;  /* tracklet con mayor score sin lock */
    var bestChallengerSince = 0;
    var lastSwitchAt = -1e9;

    function trackKeyOf(face, i) {
      return face && face.key != null ? String(face.key) : 'i' + i;
    }

    function findTrack(key) {
      for (var i = 0; i < tracks.length; i++) if (tracks[i].key === key) return tracks[i];
      return null;
    }

    function pushTalk(tr, open, now) {
      tr.talkSamples.push({ t: now, o: open });
      while (tr.talkSamples.length && now - tr.talkSamples[0].t > cfg.talkWindowMs) tr.talkSamples.shift();
      if (tr.talkSamples.length >= 4) {
        var sum = 0, sum2 = 0, n = tr.talkSamples.length;
        for (var i = 0; i < n; i++) { var o = tr.talkSamples[i].o; sum += o; sum2 += o * o; }
        var mean = sum / n;
        tr.talkVar = Math.max(0, sum2 / n - mean * mean);
      }
    }

    /** Normaliza [0,1]: varianza labial típica 0..~0.01 → escala práctica. */
    function talkScore(tr) { return clamp(tr.talkVar / 0.004, 0, 1); }

    /**
     * Evalúa las caras del frame y devuelve el objetivo según la política.
     * @param {Array} faces  raw.faces del backend ({lm:[[x,y]...]} [+ key])
     * @param {number} nowMs performance.now() del frame
     */
    function select(faces, nowMs) {
      var now = +nowMs;
      if (!isFinite(now)) now = 0;
      if (!faces || !faces.length) return null;

      /* 1. Sincronizar tracklets con detecciones (por key o índice estable). */
      var seenKeys = {};
      var limited = faces.slice(0, cfg.maxFaces);
      var evals = [];

      for (var i = 0; i < limited.length; i++) {
        var face = limited[i];
        if (!face || !face.lm || face.lm.length < 16) continue;
        var bb = bboxOf(face.lm);
        if (!bb || bb.w <= 0 || bb.h <= 0) continue;
        var key = trackKeyOf(face, i);
        seenKeys[key] = true;

        var tr = findTrack(key);
        if (!tr) {
          tr = { key: key, box: bb, vel: { x: 0, y: 0 }, lastSeen: now,
                 talkSamples: [], talkVar: 0, vadLevel: 0 };
          tracks.push(tr);
        } else {
          var dt = Math.max(now - tr.lastSeen, 1);
          var nx = (bb.x0 + bb.x1) / 2, ny = (bb.y0 + bb.y1) / 2;
          var px = (tr.box.x0 + tr.box.x1) / 2, py = (tr.box.y0 + tr.box.y1) / 2;
          var a = clamp(dt / 120, 0.05, 0.5);              /* suavizado de velocidad */
          tr.vel.x = tr.vel.x + a * ((nx - px) / dt - tr.vel.x);
          tr.vel.y = tr.vel.y + a * ((ny - py) / dt - tr.vel.y);
          tr.box = bb; tr.lastSeen = now;
        }
        pushTalk(tr, mouthOpen(face.lm), now);
        evals.push({ index: i, face: face, tr: tr, bb: bb });
      }

      /* 2. Poda: tracklets invisibles más allá de lostGraceMs (salvo lock reciente). */
      tracks = tracks.filter(function (tr) {
        if (seenKeys[tr.key]) return true;
        return now - tr.lastSeen <= cfg.lostGraceMs;
      });

      if (!evals.length) return null;

      /* 3. Scoring por candidato. Continuidad espacial: distancia del centro
       *    actual al centro PREDICHO por velocidad del tracklet (decaimiento
       *    gaussiano). Con keys estables del backend la predicción es casi
       *    exacta; sin keys (reasignación por índice) penaliza los saltos. */
      var scored = evals.map(function (e) {
        var sizeAvg = Math.max((e.tr.box.w + e.tr.box.h) / 2, 1e-3);
        var dtPred = clamp(now - e.tr.lastSeen, 0, 250);
        var predCx = (e.bb.x0 + e.bb.x1) / 2 + e.tr.vel.x * dtPred;
        var predCy = (e.bb.y0 + e.bb.y1) / 2 + e.tr.vel.y * dtPred;
        var spatialErr = Math.hypot((e.bb.x0 + e.bb.x1) / 2 - predCx,
                                    (e.bb.y0 + e.bb.y1) / 2 - predCy);
        var cont = Math.exp(-(spatialErr * spatialErr) /
                            (2 * Math.pow(cfg.sigma * sizeAvg, 2)));
        var area = clamp(e.bb.w * e.bb.h / 0.25, 0, 1);          /* cara ≥25% de área → 1 */
        var centr = clamp(1 - centerDist(e.bb) / 0.7, 0, 1);
        var base = cfg.areaWeight * area + cfg.centerWeight * centr +
                   cfg.talkWeight * talkScore(e.tr) + cfg.vadWeight * clamp(e.tr.vadLevel, 0, 1);
        var isLocked = lockedTrack && lockedTrack.key === e.tr.key;
        e.score = clamp(base + (isLocked ? cfg.lockBonus * cont : 0), 0, 2);
        e.locked = !!isLocked;
        return e;
      });

      /* 4. Candidato top sin considerar lock. */
      var top = scored.reduce(function (a, b) { return b.score > a.score ? b : a; });

      /* 5. Histéresis de cambio: si el lock existe y top no es el lock, exigir
       *    superación sostenida switchHoldMs y respetar cooldown anti-ping-pong. */
      var switched = false;
      var chosen = top;
      if (lockedTrack && top.tr.key !== lockedTrack.key) {
        var lockedEval = null;
        for (var li = 0; li < scored.length; li++) if (scored[li].tr.key === lockedTrack.key) lockedEval = scored[li];
        if (!lockedEval) {
          /* el lock desapareció del frame → soltar (el bridge gestionará LOST) */
          lockedTrack = null; bestChallenger = null; bestChallengerSince = 0;
        } else if (top.score > lockedEval.score) {
          if (bestChallenger !== top.tr.key) { bestChallenger = top.tr.key; bestChallengerSince = now; }
          if (now - bestChallengerSince >= cfg.switchHoldMs && now - lastSwitchAt > cfg.switchHoldMs) {
            lockedTrack = top.tr; switched = true; lastSwitchAt = now;
            bestChallenger = null; bestChallengerSince = 0;
          } else {
            chosen = lockedEval;   /* aún no: mantener objetivo */
          }
        } else {
          bestChallenger = null; bestChallengerSince = 0;
          chosen = lockedEval;
        }
      } else if (!lockedTrack) {
        lockedTrack = top.tr;
        bestChallenger = null; bestChallengerSince = 0;
      }

      return {
        index: chosen.index,
        face: chosen.face,
        score: +chosen.score.toFixed(4),
        locked: !!chosen.locked || lockedTrack === chosen.tr,
        switched: switched
      };
    }

    /**
     * Inyección VAD/diarización (contrato futuro, plan §3): hint identifica la
     * cara (key del backend o índice numérico) y level ∈ [0,1] su actividad de voz.
     */
    function setVoiceActivity(hint, level) {
      var key = hint == null ? null : String(hint);
      var lvl = clamp(level, 0, 1);
      for (var i = 0; i < tracks.length; i++) {
        var tr = tracks[i];
        if (key === null || tr.key === key || tr.key === 'i' + key) tr.vadLevel = lvl;
        else tr.vadLevel = 0;
      }
    }

    function reset() {
      tracks = []; lockedTrack = null;
      bestChallenger = null; bestChallengerSince = 0; lastSwitchAt = -1e9;
    }

    return {
      config: cfg,
      select: select,
      setVoiceActivity: setVoiceActivity,
      reset: reset,
      get lockedKey() { return lockedTrack ? lockedTrack.key : null; },
      trackCount: function () { return tracks.length; }
    };
  }

  global.MM_Tracking = global.MM_Tracking || {};
  global.MM_Tracking.FaceSelector = { create: create };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.MM_Tracking.FaceSelector;
})(typeof window !== 'undefined' ? window : globalThis);
