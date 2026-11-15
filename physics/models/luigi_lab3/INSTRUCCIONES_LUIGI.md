# Robot Explorador Autónomo — Integración Sim-to-Real con Tridi (Lab 3)

**Autores del robot:** Luigi D'Aquaro / Jorge Younes  
**Integración Sim-to-Real y Policy 50 Hz:** Tridi (`luigi-lab3.onnx`)

---

## 📦 Qué incluye esta carpeta

1. **`robot_gestos/robot_gestos.ino` (EL ARCHIVO PRINCIPAL):**
   - Es el código final que ya tiene cargado tu Arduino UNO ahorita mismo.
   - Incluye la **policy neuronal de Tridi corriendo a 50 Hz (cada 20 ms)** en C nativo (`pasoPolicyTridi()`), control diferencial suave por PWM en las dos ruedas (`L298N`), y evasión de obstáculos en lazo cerrado en 4 etapas (freno activo en seco → reversa → giro de 90° → verificación de camino libre).
   - **No requiere instalar ninguna librería externa** (usa solo `<Wire.h>` y `<math.h>` que ya vienen con Arduino IDE).
2. **`robot_gestos_original/robot_gestos_original.ino`:**
   - Respaldo exacto de tu código original antes de los cambios.
3. **`tridi_policy/luigi-lab3.onnx` y `luigi-lab3.json`:**
   - El archivo binario `.onnx` de la red neuronal exportada por Tridi (`obs_dim = 15`, `nu = 2` motores a `20.94 rad/s = 200 RPM`) y sus metadatos.
4. **`simulacion_mujoco/` (`luigi.xml`, `scene.xml`, `assets/*.stl`):**
   - El gemelo digital físico en MuJoCo armado con las 6 piezas STL de tu CAD.

---

## 🔍 Diagnóstico electrónico importante de tu robot físico (para tu informe de Lab 3)

Al medir en vivo los pines de tu Arduino UNO por USB encontramos **2 detalles de hardware clave** que explican por qué fallaban las librerías estándar:

1. **Tu sensor `APDS-9960` (módulo morado) tiene `Chip ID = 0x9E`:**
   - La librería oficial `SparkFun_APDS9960` solo acepta `0xAB` o `0x9C` (e incluso poniendo el parche común `0xA8` seguía rechazándolo porque tu chip responde `0x9E` en el registro `0x92`). Por eso `apds.init()` devolvía `false` y apagaba el sensor.
   - **Solución implementada:** En `robot_gestos.ino` inicializamos el `APDS-9960` escribiendo directamente sus registros I2C en la dirección `0x39` (`writeApdsReg` / `readApdsReg`) en modo **Radar Infrarrojo continuo (`40 Hz`, sin gestos bloqueantes)** y con `Wire.setWireTimeout(3000, true)` para que el bus I2C jamás pueda congelar el Arduino.
   - Al encender el robot, durante los primeros `150 ms` mide automáticamente el reflejo infrarrojo del aire libre (`baseProxIr`, aprox. `18–20`) y fija el umbral de disparo en `baseProxIr + 8`. Apenas acercas la mano o se acerca a un mueble/sofá, el valor sube por encima del umbral y dispara la maniobra de esquive.
2. **Lectura no bloqueante del `HC-SR04` (`TRIG = A0, ECHO = A1`):**
   - En vez de usar `pulseIn()` (que detiene el procesador hasta `47.1 ms` cuando no hay eco cercano y congela el control de los motores), configuramos la **interrupción por cambio de pin del ATmega328P (`ISR(PCINT1_vect)` sobre `A1`)**. Así mide los ecos ultrasónicos en segundo plano en `0.01 ms` sin frenar jamás el ciclo de `50 Hz` de la red.

---

## 🛠️ PARTE 1: Cómo cargarlo o modificarlo TÚ SOLO (Sin IA)

### Cómo subir el código desde tu computadora (Windows o Mac)
1. Abre **Arduino IDE**.
2. Ve a **File → Open...** y abre el archivo **`robot_gestos/robot_gestos.ino`**.
3. **Apaga el switch negro de la protoboard (`O`)** y conecta el robot por cable USB a tu computadora.
4. En Arduino IDE selecciona:
   - **Tools → Board → Arduino AVR Boards → Arduino Uno**
   - **Tools → Port →** el puerto USB de tu Arduino (`COM3`/`COM4` en Windows o `/dev/cu.usbserial-...` en Mac).
5. Haz clic en el botón **Upload (`→`, flecha arriba a la izquierda)** y espera a que diga **Done uploading**.
6. **Prueba en la mesa antes de soltarlo:** Con el cable USB aún conectado y el switch en `O`, acerca tu mano a `5–10 cm` frente al sensor morado: verás que **se enciende el LED naranja (`L`, pin 13)** en la placa del Arduino UNO.
7. Desconecta el cable USB, pon el robot en el piso y pasa el switch negro a **`I` (encendido)**:
   - El LED parpadea **2 segundos** mientras está quieto (para darte tiempo de soltarlo).
   - Luego arranca solo con la policy de Tridi y esquiva cualquier obstáculo.

### Parámetros que puedes ajustar fácil arriba en `robot_gestos.ino` (líneas 29–49)
Si quieres que detecte obstáculos desde más lejos, gire más grados o vaya más rápido/lento, solo cambia estos números al inicio del archivo y vuelve a darle **Upload**:

- **Sensibilidad del sensor frontal (línea 149):**
  ```cpp
  umbralProxPeligro = baseProxIr + 8;
  ```
  - Si quieres que detecte la mano/muebles **desde más lejos** (más sensible), cámbialo a `baseProxIr + 5`.
  - Si en un salón muy iluminado esquiva solo sin que haya nada enfrente, cámbialo a `baseProxIr + 12`.
- **Duración del retroceso y del giro al esquivar (líneas 45–47):**
  ```cpp
  const unsigned long T_FRENO_SECO = 160;   // ms de freno inverso en seco
  const unsigned long T_FIN_RETRO  = 780;   // ms totales hasta terminar de retroceder
  const unsigned long T_FIN_GIRO   = 1460;  // ms totales hasta terminar de girar (~90°)
  ```
  - Si en el piso de la universidad quieres que **gire más ángulo** al esquivar, sube `T_FIN_GIRO` de `1460` a `1650`.
  - Si quieres que **retroceda más distancia**, sube `T_FIN_RETRO` de `780` a `1000` (y `T_FIN_GIRO` a `1680`).

---

## 🤖 PARTE 2: Prompt listo para usar CON IA (Claude / ChatGPT / Cursor)

Si quieres pedirle a una IA (Claude, ChatGPT, etc.) que le agregue funciones nuevas o cambie el comportamiento del robot **sin que te dañe lo que ya funciona**, cópiale y pégale exactamente este prompt junto con el archivo `robot_gestos.ino`:

```text
Actúa como un ingeniero experto en sistemas embebidos (Arduino UNO / ATmega328P) y robótica móvil Sim-to-Real.

Aquí tienes el archivo `robot_gestos.ino` que actualmente corre y funciona perfecto en mi robot físico de dos ruedas diferenciales.

CONTEXTO CRÍTICO DE HARDWARE QUE NO DEBES ROMPER:
1. Pines del puente H L298N:
   - Motor izquierdo: ENA = D5 (PWM), IN1 = D7, IN2 = D8
   - Motor derecho:   ENB = D6 (PWM), IN3 = D9, IN4 = D10
   - Motores amarillos TT con reductora (200 RPM = 20.94 rad/s max). Su zona muerta por fricción estática en el piso es PWM < 115, por lo que `radsToPwm()` mapea [1.2 .. 20.94] rad/s al rango efectivo PWM [115 .. 200].
2. Sensor frontal I2C APDS-9960 (SDA = A4, SCL = A5, dirección I2C = 0x39):
   - ¡MUY IMPORTANTE!: Mi módulo físico APDS-9960 tiene Chip ID = 0x9E (registro 0x92). NO uses la librería `SparkFun_APDS9960` porque su `.init()` rechaza el ID 0x9E y además `readGesture()` tiene un `while(1)` bloqueante.
   - Mantén siempre la inicialización y lectura directa por registros I2C (`writeApdsReg` / `readApdsReg` sobre 0x39) con `Wire.setWireTimeout(3000, true)` y lectura del registro `PDATA` (0x9C) cada 25 ms con auto-calibración de `baseProxIr` al arrancar.
3. Sensor ultrasónico HC-SR04 (TRIG = A0, ECHO = A1):
   - Se lee de forma NO bloqueante mediante la interrupción `ISR(PCINT1_vect)` en `A1` (`PCINT9`) disparando `TRIG` cada 70 ms solo cuando `ECHO == LOW` (porque cuando no hay eco su timeout interno dura 47.1 ms; jamás uses `pulseIn()` bloqueante).
4. Cerebro autónomo (`pasoPolicyTridi()` a 50 Hz = cada 20 ms):
   - Ejecuta la policy exportada de Tridi (`luigi-lab3.onnx`): integra la odometría `thetaL` y `thetaR`, evalúa el oscilador diferencial suave `phase = 0.11 * (thetaL + thetaR)` y, cuando `hayObstaculo()` se activa (por IR o por ultrasonido), ejecuta la maniobra de esquive en 4 etapas en lazo cerrado (freno activo en seco -230 PWM -> reversa -> giro sobre su eje -> verificación de despeje `caminoLibreTrasGiro()`).

Conservando intactas estas reglas de hardware, ayúdame a hacer el siguiente cambio en `robot_gestos.ino`:
[ESCRIBE AQUÍ LO QUE QUIERAS CAMBIAR O AGREGAR]
```
