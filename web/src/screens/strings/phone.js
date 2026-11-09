// #/camera copy in every language (src/i18n.js).
import { dict } from '../../i18n.js';

export const title = { es: 'Cámara del teléfono', en: 'Phone camera' };

export const { T, L } = dict({
  head: { es: 'Este teléfono es la cámara', en: 'This phone is the camera' },
  lead: { es: 'Lo que filmes se copia en el robot de la pantalla grande.', en: 'Whatever you film is copied by the robot on the big screen.' },
  tap: { es: 'Toca el botón y acepta usar la cámara.', en: 'Tap the button and allow the camera.' },
  use: { es: 'Usar la cámara', en: 'Use the camera' },
  end: { es: 'Terminar', en: 'Finish' },
  step1: { es: 'Apunta a la persona con el cuerpo entero en cuadro; de perfil si va a caminar.', en: 'Aim at the person with the whole body in frame; from the side if they will walk.' },
  step2: { es: 'Mantén la pantalla encendida y el teléfono quieto.', en: 'Keep the screen on and the phone still.' },
  step3: { es: 'En la pantalla grande, Grabar guarda el movimiento como siempre.', en: 'On the big screen, recording saves the motion as usual.' },
  badLink: { es: 'Este enlace no trae una sesión válida. Vuelve a escanear el código de la pantalla grande.', en: 'This link has no valid session. Scan the code on the big screen again.' },
  noServer: { es: 'No sé dónde está el servidor. Vuelve a escanear el código de la pantalla grande.', en: 'I do not know where the server is. Scan the code on the big screen again.' },
  offline: { es: 'Sin conexión con el servidor. Sigo intentando…', en: 'No connection to the server. Still trying…' },
  unwatched: { es: 'La pantalla grande no está escuchando. ¿Sigue abierta En vivo?', en: 'The big screen is not listening. Is Live still open?' },
  nobody: { es: 'No veo a nadie. Que se vea al menos de la cintura para arriba.', en: 'I see nobody. Show at least from the waist up.' },
  half: { es: 'Se ve a medias: que entren los hombros, los brazos y las manos.', en: 'Only part is visible: get the shoulders, arms and hands in.' },
  ok: { es: 'Conectado. El robot copia a quien filmas.', en: 'Connected. The robot copies whoever you film.' },
  framesOne: { es: '1 cuadro por segundo', en: '1 frame per second' },
  framesMany: { es: '{n} cuadros por segundo', en: '{n} frames per second' },
  slow: { es: ' · lento: el robot puede moverse a saltos', en: ' · slow: the robot may move in jumps' },
  ended: { es: 'La pantalla grande terminó la sesión. Puedes cerrar esta página.', en: 'The big screen ended the session. You can close this page.' },
  stopped: { es: 'La pantalla grande dejó de escuchar hace {s} s. Vuelve a escanear el código.', en: 'The big screen stopped listening {s} s ago. Scan the code again.' },
  preparing: { es: 'Preparando la cámara…', en: 'Preparing the camera…' },
  noTridi: { es: 'No encuentro el servidor de Tridi. En la pantalla grande, vuelve a abrir la sesión del teléfono.', en: 'I cannot find the Tridi server. On the big screen, open the phone session again.' },
  allow: { es: 'Listo. Ahora acepta el permiso de la cámara.', en: 'Ready. Now allow the camera.' },
  waitingPermission: { es: 'Esperando el permiso de la cámara…', en: 'Waiting for camera permission…' },
  connecting: { es: 'Conectando con la pantalla grande…', en: 'Connecting to the big screen…' },
  cameraFailed: { es: 'No se pudo encender la cámara. Recarga la página e intenta de nuevo.', en: 'The camera could not turn on. Reload the page and try again.' },
  done: { es: 'Listo. Puedes cerrar esta página.', en: 'Done. You can close this page.' },
});
