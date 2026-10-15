// rostro_animado/site/shared-policy.js
/* ============================================================
 * shared-policy.js — Instancia ÚNICA de MM_EmotionPolicy para toda la página.
 *
 * Problema que resuelve: CallSession.create() y TrackingBridge.create() creaban
 * cada uno su propia política si no recibían opts.policy → dos "dueños" del bot
 * que no se veían entre sí (D13 roto por diseño).
 *
 * Ahora: app.js, call.js y los puentes reciben window.MM_SHARED_POLICY.
 * Propietario fijo = 'call' (IA/backend). El tracker NO gobierna emociones:
 * además se crea con signals:false, de modo que nunca llama a handleAIMessage.
 *
 * Orden de carga: DESPUÉS de src/media/EmotionPolicy.js y de engine.js,
 * ANTES de CallSession.js / TrackingBridge.js / site/app.js / site/call.js.
 * ============================================================ */
(function (global) {
  'use strict';

  if (!global.MM_EmotionPolicy) {
    console.error('[shared-policy] cargue primero src/media/EmotionPolicy.js');
    return;
  }

  var policy = global.MM_EmotionPolicy.create({
    exists: function (id) {
      var cfg = global.MoodMates && global.MoodMates.config;
      return !!(cfg && cfg.getRaw && cfg.getRaw(id));
    }
  });
  policy.setOwner('call');

  global.MM_SHARED_POLICY = policy;
})(typeof window !== 'undefined' ? window : globalThis);