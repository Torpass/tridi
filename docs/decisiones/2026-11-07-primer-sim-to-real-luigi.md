# Primer caso Sim-to-Real físico de Tridi: Robot Explorador de Luigi (`luigi_lab3`)

**Fecha:** 7 de noviembre de 2026  
**Lugar:** Casa de Alejandro (reunión presencial con Luigi D'Aquaro)  
**Participantes:** Juan Villa, Alejandro Hernández, Luigi D'Aquaro  
**Archivos clave en el repo:**
- Gemelo digital MuJoCo y mallas CAD: [`physics/models/luigi_lab3/luigi.xml`](../../physics/models/luigi_lab3/luigi.xml), [`scene.xml`](../../physics/models/luigi_lab3/scene.xml), [`assets/*.stl`](../../physics/models/luigi_lab3/assets)
- Policy ONNX exportada: [`training/policies/luigi-lab3.onnx`](../../training/policies/luigi-lab3.onnx), [`luigi-lab3.json`](../../training/policies/luigi-lab3.json)
- Panel WebSerial USB y gemelo en vivo: [`web/src/screens/simulations.js`](../../web/src/screens/simulations.js), [`web/src/stage.js`](../../web/src/stage.js)
- Firmware final de Arduino UNO (inferencia a 50 Hz + drivers de sensores en C): [`physics/models/luigi_lab3/firmware/robot_gestos.ino`](../../physics/models/luigi_lab3/firmware/robot_gestos.ino)

---

## 1. Por qué este hito importa (Producto, Ventas y YC)

En **Platanus Hack 26 Caracas** (23–25 de octubre de 2026, oficinas de Yummy), construimos la primera versión de **Tridi** bajo una premisa clara: *ChatGPT tuvo todo internet para entrenarse, pero los robots no tienen un dataset masivo de movimiento físico*. Durante la hackathon demostramos el flujo en software (video → esqueleto 3D → simulación física en MuJoCo → policy ONNX), pero quedaba abierta la pregunta más dura de cualquier inversionista o comprador de robótica:

> **«¿Esto solo se ve bonito en el navegador o de verdad puede mover un robot físico en el mundo real?»**

Aunque el foco comercial principal de Tridi son los robots humanoides (`Unitree G1`, `Unitree H1`), el primer hardware físico real al que tuvimos acceso directo fue el **robot explorador diferencial de Laboratorio 3 de Luigi D'Aquaro** (un chasis impreso en 3D con dos motores amarillos TT con reductora, llantas de TPU, puente H `L298N`, batería 2S `18650` de `7.4 V`, sensor ultrasónico `HC-SR04`, sensor óptico I2C `APDS-9960` y un microcontrolador `Arduino UNO / ATmega328P`).

El objetivo de la sesión del 7 de noviembre fue **ejecutar el pipeline completo de Tridi de punta a punta sobre el robot de Luigi en una sola noche**:
1. Tomar el diseño CAD real del robot y construir su **gemelo digital físico exacto en MuJoCo**.
2. Exportar una **policy neuronal en formato ONNX (`luigi-lab3.onnx`)** que controle sus actuadores a `50 Hz` (`cada 20 ms`).
3. Conectar el navegador (`Simulaciones` en Tridi Web) por **WebSerial USB** al robot físico para que la simulación y el robot real se muevan sincronizados.
4. **Compilar y embeber la policy de Tridi directamente dentro del microcontrolador del robot** para desconectarlo del cable USB, ponerlo en el piso, encender el switch y demostrar que navega y esquiva obstáculos reales por sí solo.

**Resultado:** El robot físico rodó de forma 100 % autónoma por más de 2 minutos continuos en el piso de la sala (`IMG_2316.MOV`), ejecutando las curvas suaves de la policy de Tridi a `50 Hz` y esquivando zapatos, muebles, sofás y cables en lazo cerrado sin un solo choque.

---

## 2. Cómo construimos cada etapa (Paso a Paso Técnico)

### Etapa 1: Del CAD (`build123d` / STL) al Gemelo Digital en MuJoCo
- Luigi tenía el modelo paramétrico de su robot en Python (`cad/modelo.py`) y las **6 piezas STL reales** que imprimió en 3D:
  1. `1_chasis_robot.stl` (chasis principal en PLA negro mate)
  2. `2_soporte_motor_x2.stl` (soportes de motores TT)
  3. `3_patin_delantero.stl` (patín de apoyo delantero de baja fricción)
  4. `4_bandeja_protoboard.stl` (bandeja superior blanca)
  5. `5_rin_x2.stl` (rines amarillos de 5 rayos)
  6. `6_llanta_x2_TPU.stl` (llantas negras con dibujo en TPU flexible)
- Importamos las 6 mallas STL en [`physics/models/luigi_lab3/luigi.xml`](../../physics/models/luigi_lab3/luigi.xml) a escala `0.002` (`2x` para visualización clara en escena), posicionando con precisión los componentes electrónicos reales (pack de baterías `18650` verdes abajo, `Arduino UNO` azul, `L298N` rojo con disipador negro, protoboard blanca con switch y capacitor de `100 µF`, `HC-SR04` frontal y módulo morado `APDS-9960` arriba).
- Modelamos los dos actuadores como motores de velocidad diferencial (`vel_left_wheel`, `vel_right_wheel`) con el límite físico real de los motores TT (`200 RPM` = `20.94 rad/s`, `ctrlrange="-20.94 20.94"`).

### Etapa 2: Policy ONNX (`luigi-lab3.onnx`) y Motor de Inferencia en el Navegador
- Exportamos la policy [`training/policies/luigi-lab3.onnx`](../../training/policies/luigi-lab3.onnx) (`obs_dim = 15`, `nu = 2`, `sense_velocity = true`), cuya observación lee la orientación del chasis, velocidad lineal/angular y la posición/velocidad de las dos ruedas (`theta_L`, `theta_R`).
- Extendimos nuestro runtime ligero [`physics/src/onnx-lite.js`](../../physics/src/onnx-lite.js) para soportar los operadores matemáticos `Tanh`, `Relu`, `Sin`, `Cos`, `Identity` y `MatMul`, además de corregir la alineación de `byteOffset` en `Float32Array` al leer tensores embebidos en Node y en el navegador.

### Etapa 3: Gemelo Digital Bidireccional por WebSerial USB (`9600 baud`)
- En [`web/src/screens/simulations.js`](../../web/src/screens/simulations.js) y [`web/src/stage.js`](../../web/src/stage.js), agregamos el panel **Arduino UNO — USB en vivo (`#arduino-box`)** cuando se selecciona el **Robot de Luigi (Lab 3)**.
- Usando la API **WebSerial** de Chrome a `9600 baud` (`/dev/cu.usbserial-11230`), logramos comunicación en ambos sentidos:
  - Los botones de la interfaz web (`⬆️ Avanzar (F)`, `⬇️ Atrás (B)`, `⬅️ Giro Izq (L)`, `➡️ Giro Der (R)`, `⏹ Quieto (S)`, `🤖 Patrulla ONNX`) mueven al mismo tiempo las ruedas del robot físico y el modelo 3D en MuJoCo.
  - La telemetría que el Arduino envía por USB (`Dist: ... | ProxIR: ... | Accion: ...`) actualiza el estado en vivo en la pantalla de Tridi.

---

## 3. Los 5 Problemas Reales del Sim-to-Real y Cómo los Solucionamos

Pasar de la simulación al robot físico en el piso destapó **5 problemas reales de hardware** que nunca aparecen en un simulador puro:

### Problema 1: Compilador AVR (`avr-g++`) en Mac Apple Silicon (M2) + puerto ocupado
- **Síntoma:** Al intentar compilar en Arduino IDE salía `fork/exec .../avr-g++: bad CPU type in executable`, y al intentar subir el código salía `Resource busy` en `/dev/cu.usbserial-11230`.
- **Causa y solución:** Las herramientas `avr-gcc` de Arduino están compiladas para `x86_64` y requerían **Rosetta 2** en macOS (`softwareupdate --install-rosetta --agree-to-license`). El error de `Resource busy` ocurría porque la pestaña de Chrome mantenía abierto el puerto WebSerial; recargar la pestaña libera el descriptor para que `arduino-cli` / Arduino IDE suba el binario.

### Problema 2: Caber en 2 KB de RAM (Transpilación de ONNX a C nativo a 50 Hz)
- **Síntoma:** Un Arduino UNO (`ATmega328P`) solo tiene **2 KB de RAM** y **32 KB de Flash**; es imposible cargar un intérprete de `.onnx` en tiempo de ejecución.
- **Solución:** Transpilamos el grafo matemático de `luigi-lab3.onnx` directamente a una función en C ([`pasoPolicyTridi()`](../../physics/models/luigi_lab3/firmware/robot_gestos.ino)) que corre cada `20 ms` (`50 Hz`), integrando la odometría de las ruedas (`thetaL += ctrlL * 0.02f`) y calculando las velocidades diferenciales continuas consumiendo solo **22 % de RAM (`461 bytes`)** y **29 % de Flash (`9.5 KB`)**.

### Problema 3: Zona muerta de fricción estática de los motores TT en el piso
- **Síntoma:** En MuJoCo, enviar `3 rad/s` mueve la rueda suavemente. En el robot físico con puente H `L298N` y batería `2S`, cualquier `PWM < 110` solo hace zumbar el motor sin vencer la fricción estática de las llantas de TPU contra la cerámica.
- **Solución:** Implementamos `radsToPwm(float w)` mapeando el rango útil de la policy (`[1.2 .. 20.94] rad/s`) al rango efectivo de torque del `L298N` (`PWM [115 .. 200]`), logrando curvas diferenciales continuas sin que ninguna rueda se quede pegada.

### Problema 4: `pulseIn()` del ultrasónico `HC-SR04` bloqueaba el ciclo de 50 Hz durante `47.1 ms`
- **Síntoma:** Al medir con diagnóstico electrónico el pin `ECHO` (`A1`) del `HC-SR04`, descubrimos que cuando no recibe eco (o cuando su línea de `5V` cae), el sensor mantiene el pin `ECHO` en `HIGH` durante exactamente **`47,136 µs` (`47.1 ms`)**. Usar `pulseIn()` congelaba el procesador más del doble de un ciclo neuronal (`20 ms`) y además los disparos cada `30–50 ms` chocaban con el pulso anterior aún en `HIGH`.
- **Solución:** Eliminamos `pulseIn()` por completo y programamos la **interrupción de hardware por cambio de pin del ATmega328P (`ISR(PCINT1_vect)` en `A1 / PCINT9`)**. El procesador mide el ancho del pulso en segundo plano en `0.01 ms` sin bloquear jamás el lazo de `50 Hz`, y solo dispara `TRIG` (`A0`) cada `70 ms` si `ECHO == LOW`.

### Problema 5 (El hallazgo clave): El sensor morado `APDS-9960` era un clon con `Chip ID = 0x9E`
- **Síntoma:** En las primeras pruebas de piso, al poner la mano o acercarse a un sofá, el robot seguía derecho y chocaba. Además, en modo gestos, la función `apds.readGesture()` de la librería `SparkFun_APDS9960` contiene un `while(1)` interno que bloqueaba el Arduino esperando que una mano terminara un gesto.
- **Diagnóstico en vivo por USB:** Escribimos un escáner I2C que leyó el registro de identificación `0x92` del sensor en la dirección `0x39`. El chip devolvió **`0x9E`**. La librería oficial de SparkFun solo acepta `0xAB` o `0x9C` (y el parche conocido en foros solo agregaba `0xA8`), por lo que **`apds.init()` siempre devolvía `false` y dejaba el sensor apagado en silencio**.
- **Solución definitiva:**
  1. Eliminamos la dependencia de la librería `SparkFun_APDS9960` y programamos el chip `0x9E` **directamente por registros I2C (`0x39`) con `<Wire.h>`** y timeout de hardware (`Wire.setWireTimeout(3000, true)`).
  2. Lo configuramos como **Radar Infrarrojo continuo no bloqueante a `40 Hz`** (registro `PDATA = 0x9C`, pulsos de `16 µs × 10`, ganancia `4X`, corriente `100 mA`), que lee la proximidad óptica en `0.2 ms` sin ningún `while(1)`.
  3. Agregamos **auto-calibración al encender**: en `setup()`, el robot mide durante `120 ms` el reflejo infrarrojo del aire libre (`baseProxIr ≈ 18–20`) y fija el umbral de disparo en `baseProxIr + 8` (`~27`).
  4. Programamos una **maniobra de esquive en lazo cerrado de 4 etapas**:
     - **Etapa 1 (`0–160 ms`):** Freno activo en reversa fuerte (`PWM -230`) para clavar las ruedas y matar la inercia antes de tocar la mano o el mueble.
     - **Etapa 2 (`160–780 ms`):** Reversa (`PWM -195`) retrocediendo `~20 cm`.
     - **Etapa 3 (`780–1460 ms`):** Giro de `~90°` sobre su propio eje (`PWM ±200`).
     - **Etapa 4 (Verificación en lazo cerrado):** Si al terminar el giro el sensor todavía ve obstáculo al frente (`!caminoLibreTrasGiro()`), extiende el giro en el **mismo sentido** hasta que el camino quede libre, y ahí retoma el movimiento suave de la policy de Tridi.

---

## 4. Videos Grabados y Material para la Web (`~/Downloads/vids`)

| Archivo | Duración / Resolución | Contenido | Uso recomendado |
| --- | --- | --- | --- |
| `IMG_2316.MOV` | `2:19` (`1920×1440`, `180 MB`) | **Video principal del éxito Sim-to-Real:** el robot en el piso corriendo la policy de Tridi a 50 Hz, frenando en seco y esquivando zapatos, muebles, el sofá y cables durante más de 2 minutos sin chocarse. | **Video principal del Caso de Estudio #1 (Sim-to-Real)** en la sección de Avances / Hitos de la web (comprimido a MP4 H.264 de ~8 MB + clip corto de 20 s con los mejores esquives). |
| `IMG_2312.MOV` | `1:29` (`4K`, `934 MB`) | Toma de cerca del robot sobre la mesa mostrando el chasis impreso en 3D, el Arduino UNO, el puente H L298N, los sensores y la conexión a la laptop. | Toma B-roll de hardware ("El robot por dentro") para acompañar el caso de estudio. |
| `IMG_2317.MOV` | `0:20` (`4K`, `171 MB`) | Prueba corta intermedia en el piso antes de calibrar el radar IR `0x9E`. | Archivo interno de proceso (no hace falta publicarlo). |
| `demo.mp4` | `2:53` (`1080p`, `25 MB`) | **Pitch y demo oficial de Tridi en Platanus Hack 26 Caracas** (con subtítulos en inglés quemados, cortado exacto en los aplausos del jurado al minuto `2:53` antes de las preguntas). | **Video del Origen de Tridi (Platanus Hack 26)** en la sección de Avances / Historia de la web. |
