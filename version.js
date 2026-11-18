// Versión de la app: es lo único que hay que cambiar para publicar una actualización.
// La leen la página (se muestra en Archivos) y sw.js (nombre de la caché). Al cambiarla, sw.js también cambia a ojos
// del navegador (importScripts se vigila) y los móviles ven el aviso «hay una versión nueva».
self.APP_VERSION = '2026.11.18-1';
