# Parches para el resto de archivos

`site/app.js` y `site/shared-policy.js` se entregan completos. Estos son los cambios exactos en los demás archivos.

---

## 1. `index.html`

### 1a. Botón de seguimiento + badge (barra superior)
Dentro de `<div class="top-actions">`, **antes** del botón `#callToggle`:

```html
<span id="trackBadge" class="track-badge" role="status" aria-live="polite"></span>
<button type="button" id="faceTrackToggle" class="icon-btn" aria-pressed="false" aria-label="Seguimiento facial" title="Activar seguimiento facial (cámara)">
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
</button>
```

### 1b. Texto del hero (ya no hay mirada por ratón)
```html
<p class="hero-hint" data-i18n="heroHint">Activa la cámara (icono superior) y te seguirá con la mirada · Haz clic para ver su movimiento distintivo</p>
```

### 1c. Bloque de scripts (sustituir todo desde `<!-- Orden de carga …` hasta `</body>`)
```html
  <script src="src/core/geometry.js"></script>
  <script src="src/core/render.js?v=22d"></script>
  <script src="src/core/features.js"></script>
  <script src="src/core/fx.js?v=21a"></script>
  <script src="src/data/emotions.js?v=22a"></script>
  <script src="src/core/engine.js?v=22d"></script>
  <script src="src/characters/nimbo.js?v=21a"></script>
  <script src="src/characters/twinkle.js"></script>

  <!-- Tracking + política compartida (EmotionPolicy DEBE cargar antes de CallSession.js:
       éste captura MM_EmotionPolicy en tiempo de carga) -->
  <script src="src/tracking/Filters.js"></script>
  <script src="src/tracking/MpLoader.js"></script>
  <script src="src/tracking/Backends.js"></script>
  <script src="src/media/EmotionPolicy.js"></script>
  <script src="site/shared-policy.js"></script>
  <script src="src/tracking/FaceSelector.js"></script>
  <script src="src/tracking/TrackingBridge.js?v=25a"></script>

  <!-- Capa multimedia -->
  <script src="src/media/MediaDeviceManager.js"></script>
  <script src="src/media/WebRTCClient.js"></script>
  <script src="src/media/CallSession.js"></script>

  <script src="site/i18n.js?v=25a"></script>
  <script src="site/app.js?v=25a"></script>
  <script src="site/call.js?v=25a"></script>
</body>
```
(Se elimina el `FaceSelector.js` suelto del final: cargaba después de `app.js`.)

---

## 2. `src/tracking/TrackingBridge.js`

### 2a. Opciones: añadir tras `var oe = opts.oneEuro || {};`
```js
    /* mode 'attend' (defecto): el avatar MIRA a la persona (posición del rostro → mirada/giro).
     * mode 'mimic': comportamiento antiguo (copia el iris y la pose de la cabeza del usuario). */
    var mode = opts.mode === 'mimic' ? 'mimic' : 'attend';
    var attendGain = opts.attendGain != null ? opts.attendGain : 1.5;
    var attendYaw = opts.attendYaw != null ? opts.attendYaw : 0.45;
    var epoch = 0;   /* generación: invalida start() en vuelo si llega stop()/destroy() */
    function dz(v) { return Math.abs(v) < 0.04 ? 0 : v; }
    function absUrl(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } }
```

### 2b. Las señales de emoción pasan a ser opt-in
```diff
-      var emotional = opts.signals !== false && !!policy;
+      var emotional = opts.signals === true && !!policy;
```

### 2c. `onFrame`: sustituir desde `var earL = …` hasta `var f = bank.filter(…)` (inclusive)
```js
      var earL = F.eyeAspectRatio(lmArr, 'left');
      var earR = F.eyeAspectRatio(lmArr, 'right');
      var openAvg = F.opennessFromEAR((earL + earR) / 2, earClosed, earOpen);

      var gazeX, gazeY, yawOut;
      if (mode === 'mimic') {
        var gazeL = F.irisGaze(lmArr, 'left');
        var gazeR = F.irisGaze(lmArr, 'right');
        var pose = F.yawFromLandmarks(lmArr, false);
        yawOut = mirror ? -pose.yaw : pose.yaw;
        gazeX = (gazeL.x + gazeR.x) / 2;
        gazeY = (gazeL.y + gazeR.y) / 2;
      } else {
        /* attend: dónde ESTÁ la persona en el encuadre → hacia dónde mira/gira el avatar.
         * x+ derecha de pantalla. Con mirror=true (físicamente correcto): persona a la
         * izquierda del usuario-pantalla → el avatar mira a la izquierda. */
        var bx0 = 1, bx1 = 0, by0 = 1, by1 = 0;
        for (var li = 0; li < lmArr.length; li++) {
          var q = lmArr[li];
          if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x;
          if (q.y < by0) by0 = q.y; if (q.y > by1) by1 = q.y;
        }
        var nx = ((bx0 + bx1) / 2 - 0.5) * 2;
        var ny = ((by0 + by1) / 2 - 0.45) * 2;   /* los rostros suelen quedar algo por encima del centro */
        if (mirror) nx = -nx;
        gazeX = dz(nx * attendGain);
        gazeY = dz(ny * attendGain * 0.9);
        yawOut = F.clamp(gazeX, -1, 1) * attendYaw;   /* gira la cabeza hacia la persona */
      }
      var g = F.sanitizeVec(gazeX, gazeY);

      var f = bank.filter(now / 1000, { gx: g.x, gy: g.y, open: openAvg, yaw: yawOut });
```

### 2d. `bridge.start`: sustituir el método completo
```js
      start: async function () {
        if (state === 'ACQUIRING' || state === 'ACTIVE') return;
        var myEpoch = ++epoch;
        setState('ACQUIRING', 'start');
        var be = null;
        try {
          var cfg = Object.assign({
            bundleUrl: 'assets/vendor/mediapipe/vision_bundle.mjs',
            wasmPaths: 'assets/vendor/mediapipe/wasm/',
            modelPath: 'assets/vendor/mediapipe/face_landmarker.task',
            delegate: opts.delegate || 'GPU',
            numFaces: selector ? (opts.maxFaces != null ? opts.maxFaces : 3) : 1,
            minFaceDetectionConfidence: opts.minFaceDetectionConfidence != null ? opts.minFaceDetectionConfidence : 0.3,
            minTrackingConfidence: opts.minTrackingConfidence != null ? opts.minTrackingConfidence : 0.3
          }, opts.loader || {});
          cfg.modelUrl = cfg.modelUrl || cfg.modelPath;
          /* FIX: las URLs relativas se resolvían contra src/tracking/track.worker.js
           * dentro del Worker (404 en bundle, WASM y modelo). Se pasan absolutas. */
          ['bundleUrl', 'wasmPaths', 'modelPath', 'modelUrl'].forEach(function (k) {
            if (typeof cfg[k] === 'string') cfg[k] = absUrl(cfg[k]);
          });
          if (!T.Backends) throw new Error('cargue primero src/tracking/Backends.js');
          be = T.Backends.create(opts.backend || 'auto', {
            workerUrl: opts.workerUrl,
            onError: function (e) { emit('warning', { message: e.message }); }
          });
          backend = be;
          await be.init(cfg);
          if (myEpoch !== epoch) { be.dispose(); return; }          /* stop()/destroy() llegó durante init */
          await acquireStream();
          if (myEpoch !== epoch) { if (state === 'IDLE') releaseStream(); return; }
          await video.play();
          if (myEpoch !== epoch) { if (state === 'IDLE') releaseStream(); return; }
          stopped = false;
          lastSeenAt = performance.now();
          loop();
        } catch (e) {
          if (myEpoch !== epoch) { if (be) be.dispose(); return; }  /* abortado: no es un error */
          stopped = true;
          setState('ERROR', String((e && e.message) || e));
          if (be) { be.dispose(); if (backend === be) backend = null; }
          throw e;
        }
      },
```

### 2e. `bridge.stop`: primera línea del cuerpo
```diff
       stop: function () {
+        epoch++;
         stopped = true;
```

---

## 3. `site/call.js`

### 3a. `openCall`: el bot de llamada debe existir antes de enlazar el tracker
(Hoy `mate` es `null` en la primera apertura → `MM_Tracking.create` lanza y se traga con `console.warn`.)
```diff
-    startCallTracking();     /* bridge sobre el bot de llamada (stream compartido si existe) */
+    ensureSession();         /* crea el bot ANTES de enlazar el tracker */
+    startCallTracking();
     lazySetup();
```

### 3b. `startCallTracking`: sustituir la función completa
```js
  function startCallTracking() {
    if (callBridge || !mate || !window.MM_Tracking || !window.MM_SHARED_POLICY) return;
    var stream = (window.MM_TRACKING && window.MM_TRACKING.getStream) ? window.MM_TRACKING.getStream() : null;
    /* Sin stream compartido NO se abre una captura propia: la cámara solo se enciende
     * por acción explícita del usuario (botón de seguimiento o «Iniciar llamada»). */
    if (!stream) return;
    try {
      callBridge = window.MM_Tracking.create({
        mate: mate,
        stream: stream,
        policy: window.MM_SHARED_POLICY,
        signals: false,
        mode: 'attend',
        maxFaces: 3,
        mirror: true,
        lostAfterMs: 800
      });
      window.MM_TRACKING.setCallBridge(callBridge);
      callBridge.on(function (evt, data) {
        if (evt === 'warning') console.warn('[tracking-call]', data.message);
        if (evt === 'error') console.error('[tracking-call]', data.message);
      });
      callBridge.start().then(function () {
        var st = $('callStatus');
        if (st && callBridge && callBridge.state === 'ACTIVE') st.textContent = 'Llamada + seguimiento facial activo.';
      }).catch(function (e) {
        console.warn('[tracking-call] no iniciado:', e.message || e);
        stopCallTracking();
      });
    } catch (e) {
      console.warn('[tracking-call] init falló:', e.message || e);
      stopCallTracking();
    }
  }
```

### 3c. Política compartida en la sesión de llamada
```diff
     session = MM_Call.create({
       mate: mate,
+      policy: window.MM_SHARED_POLICY,
```

---

## 4. `site/i18n.js`

### 4a. Sustituir `heroHint`
```js
// es
heroHint: 'Activa la cámara (icono superior) y te seguirá con la mirada · Haz clic para ver su movimiento distintivo',
// en
heroHint: 'Turn on the camera (top bar) and it will follow you with its eyes · Click for its signature move',
```

### 4b. Añadir en el bloque `es`
```js
trackBtnOn: 'Desactivar seguimiento facial',
trackBtnOff: 'Activar seguimiento facial (cámara)',
trackState_ACQUIRING: 'Iniciando cámara…',
trackState_ACTIVE: 'Siguiéndote',
trackState_LOST: 'Buscando rostro…',
trackState_ERROR: 'Error de seguimiento',
trackState_SUSPENDED: 'En llamada',
toastTrackOn: 'Seguimiento facial activo: el avatar te sigue con la mirada',
toastTrackOff: 'Seguimiento facial desactivado · cámara apagada',
trackErrDenied: 'Permiso de cámara denegado. Habilítalo en el navegador para usar el seguimiento.',
trackErrNoCam: 'No se encontró ninguna cámara.',
trackErrBusy: 'La cámara está en uso por otra aplicación.',
trackErrEnded: 'La cámara se desconectó o se revocó el permiso.',
trackErrInsecure: 'La cámara requiere HTTPS o localhost.',
trackErrFile: 'Abre el sitio desde un servidor (http://localhost): MediaPipe y los Workers no funcionan desde file://.',
trackErrModules: 'Faltan módulos de seguimiento facial (revisa el orden de scripts en index.html).',
trackErrGeneric: 'Seguimiento facial no disponible: {err}',
trackWarn: 'Aviso de seguimiento: {err}',
```

### 4c. Añadir en el bloque `en`
```js
trackBtnOn: 'Turn off face tracking',
trackBtnOff: 'Turn on face tracking (camera)',
trackState_ACQUIRING: 'Starting camera…',
trackState_ACTIVE: 'Following you',
trackState_LOST: 'Looking for a face…',
trackState_ERROR: 'Tracking error',
trackState_SUSPENDED: 'In call',
toastTrackOn: 'Face tracking on: the avatar follows you with its eyes',
toastTrackOff: 'Face tracking off · camera released',
trackErrDenied: 'Camera permission denied. Allow it in the browser to use tracking.',
trackErrNoCam: 'No camera found.',
trackErrBusy: 'The camera is in use by another application.',
trackErrEnded: 'The camera was disconnected or permission was revoked.',
trackErrInsecure: 'The camera requires HTTPS or localhost.',
trackErrFile: 'Open the site from a server (http://localhost): MediaPipe and Workers do not work from file://.',
trackErrModules: 'Face-tracking modules are missing (check script order in index.html).',
trackErrGeneric: 'Face tracking unavailable: {err}',
trackWarn: 'Tracking notice: {err}',
```

---

## 5. `site/style.css` (añadir al final)
```css
/* Badge del seguimiento dentro de la barra superior (el .track-badge base es absolute) */
.topbar .track-badge { position: static; display: none; align-items: center; }
.topbar .track-badge.show { display: inline-flex; }
.track-badge.st-suspended { color: #cfe8ff; }
@media (max-width: 640px) { .topbar .track-badge { display: none !important; } }
```