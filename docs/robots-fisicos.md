# Robots físicos: los de Luigi

Escrito el 2026-11-04 por Juan (con Claude), antes de una reunión **tentativa** con Luigi, posiblemente el viernes. Nada de esto está construido todavía: es el contexto y el plan, para que el repo esté listo cuando haya tiempo. Lo que no sabemos está marcado como pregunta.

## De dónde sale

Del chat del equipo ("Tripealo 🤝 Salvalo = TRI…", 2026-11-04):

- **Ale:** Luigi es ingeniero electrónico y amigo suyo. Tiene robots hechos a escala, reales y simulados en Proteus. Idea: usar los datos que Tridi entrena en 3D en un robot real de pocas articulaciones, para mostrar algo físico ya, en vez de esperar un humanoide de miles de dólares. Por lo que dice, Luigi tiene dos robots listos y uno en proyecto.
- **Pastor:** le parece muy interesante tener electrónica real corriendo con nuestra red neuronal; quiere reunirse con Luigi.
- **Juan:** de acuerdo. No va a ser un humanoide, pero sí podemos entrenar modelos chiquitos para sus robots y que se muevan con una red neuronal. Saca a Tridi de la teoría y sirve para mostrarles a inversionistas que es verdad, desde Barquisimeto.
- **César:** está bien, pero no sabe cómo funcionaría con esos prototipos: que él sepa son muy sencillos, con instrucciones escritas a mano. **Es la pregunta correcta**, y este documento intenta responderla.

## Lo que se ve en la imagen que compartió

Por la imagen (un render de CAD y una foto de su mesa de trabajo); **confirmar todo con Luigi**:

- Un carrito de **dos ruedas con motor** (tracción diferencial: gira moviendo una rueda más rápido que la otra) y una tercera rueda o apoyo atrás.
- Un **sensor ultrasónico** al frente (los dos "ojos" azules: mide la distancia a lo que tiene delante), aparentemente sobre un **servo** que lo puede girar.
- Una caja arriba (¿batería, placa?).
- En la mesa: fuente de laboratorio, estación de soldadura, otro carrito con protoboard y una laptop con el CAD abierto.

## Qué es verdad hoy, y qué no

- **Hoy** Tridi entrena humanoides en simulación (Unitree G1, y el H1 como segundo robot) con movimiento sacado de video. Nunca corrió en hardware real. Esa es justamente la parte que falta mostrar.
- **Un carrito no camina.** La parte "video de una persona → su cuerpo → el robot lo copia" no se aplica tal cual a un robot con ruedas: no tiene piernas ni brazos que copiar.
- **Sí se aplica el resto de Tridi:** sacar movimiento de un video, corregirlo con física para que el robot pueda hacerlo, entrenar una política pequeña en simulación con variaciones del mundo, y entregarla como un archivo chico. Eso es lo que un robot real de Luigi puede probar.

## Qué podríamos mostrar, de lo más barato a lo más valioso

1. **La persona hace un gesto y el robot lo sigue en vivo (si tiene servos).** El ángulo del brazo o de la cabeza de la persona en la cámara (lo que ya calcula `data/live`) mueve un servo del robot en vivo. Es lo más vistoso y lo que más rápido sale. Es lo que menos "aprende": es copia directa.
2. **De un video al recorrido del carrito.** Una persona camina un recorrido (un ocho, un zigzag) frente a la cámara, de perfil. `data/` ya saca la trayectoria de la cadera de un video (funciona bien de perfil; de frente el avance sale ≈ 0, ver [`../data/README.md`](../data/README.md)). Se escala al espacio del carrito y se corrige con su física (velocidad y giro máximos, cuánto patinan las ruedas) en MuJoCo. Después el carrito real hace el mismo recorrido. Muestra la tubería de Tridi de punta a punta con un robot real: **video → datos de movimiento → física → robot**.
3. **Un controlador aprendido en simulación que funciona en el robot real (sim-to-real).** Modelar el carrito en MuJoCo con sus medidas y entrenar con `training/` una red pequeña que siga el recorrido del punto 2 o esquive obstáculos con el ultrasónico. Se entrena con variaciones (fricción, masa, retraso de los motores, ruido del sensor) para que aguante el mundo real. Esto responde a César: **las instrucciones escritas a mano se reemplazan por una red entrenada**, y al robot solo le hace falta recibir velocidades para sus motores y mandar lo que leen sus sensores. Una red de este tamaño (unos miles de parámetros) cabe en un microcontrolador como una tabla de números en C, o corre en la laptop y le manda los comandos por cable o Bluetooth.

**Orden propuesto:** el 2 primero (usa lo que ya existe y es la historia de Tridi), el 3 como prueba fuerte, y el 1 si tiene servos y hace falta algo vistoso para un video.

## Qué preguntarle a Luigi

- ¿Qué placa usa cada robot (Arduino Uno, ESP32, Raspberry Pi)? ¿Cómo se le mandan órdenes desde una computadora (USB, Bluetooth, WiFi)?
- ¿Qué motores tiene? ¿Tienen encoders (saben cuánto giró cada rueda)? ¿Cuáles servos y cuántos?
- ¿Qué sensores tiene, además del ultrasónico? ¿Alguno da orientación (IMU)?
- Medidas y peso de cada robot, diámetro de las ruedas, distancia entre ruedas, velocidad máxima. Si tiene el CAD (la imagen sugiere que sí), con eso se arma el modelo de MuJoCo.
- ¿Qué tiene simulado en Proteus? (Proteus simula la electrónica; la física del movimiento la haríamos en MuJoCo.)
- ¿Podemos tener un robot unos días para probar, o trabajamos en su casa?
- ¿Qué le interesa a él de esto, y cómo quiere participar o aparecer?

## Qué cambiaría en el repo (cuando haya tiempo y sepamos el hardware)

No se construye nada antes de conocer el hardware: cada respuesta de arriba cambia el diseño.

- **Paquete de robot con ruedas:** `robots/<id>.json` hoy asume un humanoide (pelvis, pies, manos; [`../robots/README.md`](../robots/README.md)). Un carrito necesita otro tipo (ruedas, sensores) y su modelo MuJoCo hecho con las medidas de Luigi.
- **Retargeting de recorrido:** de la trayectoria de la cadera de un `PoseClip` al recorrido del carrito, escalado y corregido por su física.
- **Entorno y entrenamiento:** un entorno para el carrito con las mismas ideas que el del G1 (variaciones del mundo, empujones, la regla de que el entrenamiento se corta solo cuando deja de mejorar).
- **Puente al hardware:** exportar la red a C (o correrla en la laptop) y un pequeño programa que hable con la placa.

## Lo que cambia en el plan de entrenamiento

- La corrida larga de la caminata (`walk-vel-seed0`, la que ve su velocidad) **queda en pausa**, y solo sigue de noche si la Mac está libre. Antes de más rondas largas de humanoide, la prioridad pasa a preparar esto cuando haya respuestas de Luigi.
- Lo aprendido con la caminata se reutiliza: entrenar contra la métrica que importa, pronosticar con la curva si seguir paga, sondas cortas antes de horas de Mac (bitácora [`2026-11-03-1200-juan-experimental-v2.md`](bitacora/2026-11-03-1200-juan-experimental-v2.md)).

## Para la aplicación de YC

Nada de esto se dice como hecho hasta que funcione. Si se hace, entra primero en [`../yc/verdad-hoy.md`](../yc/verdad-hoy.md).
