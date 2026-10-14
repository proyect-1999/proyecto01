// rostro_animado/src/media/EmotionPolicy.js
/* ============================================================
 * EmotionPolicy.js — MM_EmotionPolicy
 * Mapa estado→emoción INYECTABLE y validado. Único dueño del
 * contrato emotionId: lo consumen CallSession (mapa 'call') y
 * TrackingBridge (mapa 'tracking').
 *
 * Fusión con el plan de tracking:
 *   • D12: el mapa tracking es inyectable (setTrackingMap / opts.tracking).
 *   • D13: exclusión mutua call|tracking vía setOwner()/owner().
 *   • D16/R7: validación exists(id) → recada al fallback '02' si la
 *     emoción no está registrada en MoodMates.config.
 *
 * Sin dependencias; carga ANTES que CallSession.js y TrackingBridge.js.
 * ============================================================ */
(function (global) {
  'use strict';

  var FALLBACK = '02';

  /* Mapas canónicos por defecto: idénticos a los que estaban hardcodeados
   * en CallSession.EMO → migración sin cambio de comportamiento. */
  var CALL_MAP = {
    standby: '02',
    curious: '03',
    happy: '10',
    surprise: '13',
    thinking: '30',
    done: '33',
    error: '34',
    reject: '38'
  };

  var TRACKING_MAP = {
    present: '03',    /* ACTIVE: rostro presente (el backend manda la emoción real; este id es semilla) */
    lost: '02',       /* LOST → espera (reemplaza M6 del plan) */
    inactive: '00',   /* INACTIVE → dormir (señal explícita; los tiempos los gestiona el motor) */
    error: '34'
  };

  function isValidId(id) {
    return typeof id === 'string' && /^[0-9]{2,}$/.test(id);
  }

  function sanitize(src, label) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    Object.keys(src).forEach(function (k) {
      if (isValidId(src[k])) out[k] = src[k];
      else console.warn('[EmotionPolicy] entrada descartada (' + label + '.' + k + '): ' + JSON.stringify(src[k]));
    });
    return out;
  }

  /**
   * Crea una política con setters validados.
   * @param {Object} opts
   *   call?:     patch sobre CALL_MAP
   *   tracking?: patch sobre TRACKING_MAP
   *   exists?:   function(string):boolean — validador de catálogo (p. ej.
   *              MoodMates.config.getRaw)
   */
  function create(opts) {
    opts = opts || {};
    var callMap = Object.assign({}, CALL_MAP, sanitize(opts.call, 'call'));
    var trackMap = Object.assign({}, TRACKING_MAP, sanitize(opts.tracking, 'tracking'));
    var exists = typeof opts.exists === 'function' ? opts.exists : null;

    function resolve(map, key) {
      var id = map[key] != null ? map[key] : null;
      if (id == null) return FALLBACK;
      if (exists && !exists(id)) {
        console.warn('[EmotionPolicy] emoción inexistente "' + id + '" para "' + key + '", recayendo en fallback');
        return FALLBACK;
      }
      return id;
    }

    return {
      /* Exclusión mutua D13: quién manda sobre el bot. En reposo normal
       * manda la llamada; mientras el tracker está ACTIVE/ACQUIRING pasa a
       * 'tracking' y CallSession debe NO reaccionar (react() se ignora). */
      _owner: 'call',
      owner: function () { return this._owner; },
      setOwner: function (o) {
        if (o !== 'call' && o !== 'tracking') {
          throw new Error('EmotionPolicy.setOwner: valor inválido "' + o + '" (esperado "call" | "tracking")');
        }
        this._owner = o;
        return this;
      },
      call: function (key) { return resolve(callMap, key); },
      tracking: function (key) { return resolve(trackMap, key); },
      setCallMap: function (patch) { callMap = Object.assign(callMap, sanitize(patch, 'call')); return this; },
      setTrackingMap: function (patch) { trackMap = Object.assign(trackMap, sanitize(patch, 'tracking')); return this; },
      maps: function () {
        return { call: Object.assign({}, callMap), tracking: Object.assign({}, trackMap) };
      }
    };
  }

  var api = {
    create: create,
    DEFAULT_CALL_MAP: CALL_MAP,
    DEFAULT_TRACKING_MAP: TRACKING_MAP,
    FALLBACK_ID: FALLBACK,
    isValidId: isValidId
  };

  global.MM_EmotionPolicy = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
