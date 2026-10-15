# ENTREGA v2.5.3 (overlay) — copia respetando rutas sobre tu repo

ARCHIVOS NUEVOS/MODIFICADOS:
- tools/selftest.html        -> AUTOCONTENIDO: detecta su raiz real, carga MpLoader el solo y muestra diagnosticos. Sirvelo desde cualquier ruta.
- src/tracking/MpLoader.js   -> vendorBase() con respaldo location.href si document.baseURI es anoma/a; VENDOR_BASE getter dinamico.
- src/tracking/Backends.js   -> WORKER_VERSION '253...' (worker recargado SIEMPRE).
- call.html                  -> cache-busters ?v=253 en los 5 modulos de tracking.
- src/tracking/TrackingBridge.js, track.worker.js, tools/fetch-mediapipe.sh (sin cambios funcionales respecto a 2.5.2; incluidos por coherencia).

IMPSCINDIBLE (si aun no lo copiaste): assets/vendor/mediapipe/** completo (vision_bundle.mjs 136KB, face_landmarker.task 3.7MB, wasm/* 4 archivos ~19MB).
Sin esos binarios NINGUN version de JS funcionara: el error "respuesta vacia" significa que el servidor no tiene vision_bundle.mjs o esta en 0 bytes.

COMPROBACION EN TU MAQUINA:
1) python3 -m http.server 8080 --directory <ruta>/rostro_animado
2) Abre http://localhost:8080/tools/selftest.html  -> debe decir VEREDICTO: TODO OK.
   Si sale "No se pudo cargar ...src/tracking/MpLoader.js (404...)" => esa ruta no existe en TU servidor: revisa donde apunta la raiz del server.
3) Recarga dura Ctrl+Shift+R en call.html.
