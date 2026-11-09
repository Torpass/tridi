// #/net copy in every language (src/i18n.js). English is written for a US robotics team.
import { dict } from '../../i18n.js';

export const title = { es: 'La red entrenándose', en: 'The network training' };

export const { T, t } = dict({
  back: { es: '← Volver al inicio', en: '← Back to home' },
  looking: { es: 'Buscando el entrenamiento…', en: 'Looking for the training…' },
  delivery: { es: 'Ver la entrega', en: 'See the delivery' },
  cancel: { es: 'Cancelar el entrenamiento', en: 'Cancel the training' },
  missing: { es: 'Falta el entrenamiento: abre esta página desde la caja de Entrenar.', en: 'No training given: open this page from the Train box.' },
  gone: { es: 'Este entrenamiento ya no existe: se canceló, o el servidor no lo conoce.', en: 'This training no longer exists: it was canceled, or the server does not know it.' },
  done: { es: 'Terminó: el robot sigue {followed} s de los {duration} s del clip.', en: 'Done: the robot follows {followed} s of the clip’s {duration} s.' },
  failed: { es: 'Falló: {error}', en: 'Failed: {error}' },
  confirm: { es: '¿Cancelar este entrenamiento? Se detiene en el servidor y se pierde lo que lleva.', en: 'Cancel this training? It stops on the server and what it has learned so far is lost.' },
  cancelFailed: { es: 'No se pudo cancelar: {error}', en: 'Could not cancel: {error}' },
  serverOff: { es: 'El servidor de videos no está encendido.', en: 'The video server is not on.' },
});
