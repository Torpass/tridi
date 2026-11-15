/*
  ============================================================
   LABORATORIO IV - ROBOT EXPLORADOR AUTÓNOMO CON ESCANEO ACTIVO
   Integrantes: Jorge Younes - Luigi D'Aquaro
  ============================================================

  COMPONENTES
   - Arduino UNO
   - Sensor ultrasónico HC-SR04 montado sobre un servo SG90 ("cuello")
   - Puente H L298N + 2 motores DC con ruedas + 1 rueda loca
   - Portapilas (2 x 18650 = 7.4 V) para el L298N

  CONEXIONES
   Servo SG90   : señal -> pin 9 (PWM) | + -> 5V del L298N (o fuente 5 V) | - -> GND
   HC-SR04      : VCC -> 5V | TRIG -> pin 2 | ECHO -> pin 3 | GND -> GND
   L298N        : ENA -> pin 5 (PWM) | IN1 -> pin 7 | IN2 -> pin 8   (motor IZQUIERDO, salida OUT1/OUT2)
                  ENB -> pin 6 (PWM) | IN3 -> pin 11 | IN4 -> pin 12 (motor DERECHO, salida OUT3/OUT4)
                  12V -> + baterías | GND -> - baterías y GND del Arduino (tierra común)
   Importante: quitar los jumpers de ENA y ENB del L298N para poder regular la velocidad.
   Nota: la librería Servo usa el Timer1, que desactiva el PWM de los pines 9 y 10;
   por eso los motores usan los pines 5 y 6.

  LÓGICA (Parte II del laboratorio)
   1. Percepción : el servo mira al frente (90°) y mide la distancia.
   2. Decisión   : si el frente está libre (>= 20 cm) avanza.
                   Si está bloqueado (< 20 cm): se detiene, mira a la derecha (0°)
                   y a la izquierda (180°), compara y gira hacia el lado con más espacio.
                   Si ambos lados están bloqueados, retrocede y da media vuelta.
   3. Acción     : mueve los motores según la decisión y vuelve a empezar.

  Abrir el Monitor Serie a 9600 baudios para ver las mediciones y decisiones.
*/

#include <Servo.h>

// ---------------- Pines ----------------
const int PIN_SERVO = 9;
const int PIN_TRIG  = 2;
const int PIN_ECHO  = 3;
const int ENA = 5, IN1 = 7, IN2 = 8;     // motor izquierdo
const int ENB = 6, IN3 = 11, IN4 = 12;   // motor derecho

// ---------------- Parámetros de navegación (ajustables) ----------------
const int DIST_BLOQUEO   = 20;    // cm: frente bloqueado por debajo de esta distancia
const int DIST_PRECAUCION = 35;   // cm: entre 20 y 35 cm avanza más despacio
const int VEL_AVANCE     = 170;   // PWM 0-255
const int VEL_LENTA      = 120;
const int VEL_GIRO       = 170;
const int TIEMPO_GIRO_90 = 450;   // ms que tarda en girar unos 90° (calibrar en el piso)
const int TIEMPO_RETRO   = 350;   // ms de retroceso antes de girar

// ---------------- Ángulos del cuello ----------------
// Si al pedir 0° el sensor mira a la IZQUIERDA en vez de a la derecha, intercambiar estos dos valores.
const int ANG_DERECHA  = 0;
const int ANG_FRENTE   = 90;
const int ANG_IZQUIERDA = 180;
const int ESPERA_SERVO = 350;     // ms para que el servo llegue y se estabilice antes de medir

// ---------------- Sentido de giro de cada motor ----------------
// Si una rueda gira al revés, cambiar su valor a true (evita tener que recablear).
const bool INVERTIR_IZQ = false;
const bool INVERTIR_DER = false;

Servo cuello;

// ============================================================
//  PERCEPCIÓN: medición con el HC-SR04
// ============================================================
// Una lectura: envía un pulso de 10 µs y mide el eco. Devuelve cm (400 si no hay eco).
long medirUnaVez() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long t = pulseIn(PIN_ECHO, HIGH, 25000UL);   // máximo 25 ms (≈ 4 m)
  if (t == 0) return 400;                       // sin eco: no hay nada cerca
  return (long)(t * 0.0343 / 2.0);              // d = t · v_sonido / 2
}

// Tres lecturas y se queda con la del medio (mediana): elimina lecturas erróneas sueltas.
long medirDistancia() {
  long a = medirUnaVez(); delay(10);
  long b = medirUnaVez(); delay(10);
  long c = medirUnaVez();
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

// Gira el cuello a un ángulo, espera y mide
long mirar(int angulo) {
  cuello.write(angulo);
  delay(ESPERA_SERVO);
  return medirDistancia();
}

// ============================================================
//  ACCIÓN: control de los motores con el L298N
// ============================================================
void motor(int pinEN, int pinA, int pinB, int velocidad, bool invertir) {
  // velocidad: -255 (atrás) ... 0 (detenido) ... 255 (adelante)
  if (invertir) velocidad = -velocidad;
  if (velocidad > 0) {
    digitalWrite(pinA, HIGH); digitalWrite(pinB, LOW);
  } else if (velocidad < 0) {
    digitalWrite(pinA, LOW);  digitalWrite(pinB, HIGH);
  } else {
    digitalWrite(pinA, LOW);  digitalWrite(pinB, LOW);
  }
  analogWrite(pinEN, constrain(abs(velocidad), 0, 255));
}

void mover(int velIzq, int velDer) {
  motor(ENA, IN1, IN2, velIzq, INVERTIR_IZQ);
  motor(ENB, IN3, IN4, velDer, INVERTIR_DER);
}

void avanzar(int v)       { mover(v, v); }
void retroceder(int v)    { mover(-v, -v); }
void detener()            { mover(0, 0); }
void girarIzquierda(int v){ mover(-v, v); }   // giro sobre su eje
void girarDerecha(int v)  { mover(v, -v); }

// ============================================================
//  PROCESAMIENTO: qué hacer cuando el frente está bloqueado
// ============================================================
void buscarRuta() {
  detener();
  Serial.println(F(">> Frente bloqueado. Deteniendo y escaneando..."));

  long dDer = mirar(ANG_DERECHA);
  long dIzq = mirar(ANG_IZQUIERDA);
  cuello.write(ANG_FRENTE);                    // vuelve a mirar al frente

  Serial.print(F("   Derecha = "));   Serial.print(dDer);
  Serial.print(F(" cm | Izquierda = ")); Serial.print(dIzq);
  Serial.println(F(" cm"));

  if (dDer < DIST_BLOQUEO && dIzq < DIST_BLOQUEO) {
    // Callejón sin salida: retrocede y da media vuelta
    Serial.println(F("   Decisión: ambos lados bloqueados -> retroceder y dar media vuelta"));
    retroceder(VEL_AVANCE);
    delay(TIEMPO_RETRO);
    girarDerecha(VEL_GIRO);
    delay(2 * TIEMPO_GIRO_90);
  } else if (dIzq > dDer) {
    Serial.println(F("   Decisión: girar a la IZQUIERDA (más espacio libre)"));
    girarIzquierda(VEL_GIRO);
    delay(TIEMPO_GIRO_90);
  } else {
    Serial.println(F("   Decisión: girar a la DERECHA (más espacio libre)"));
    girarDerecha(VEL_GIRO);
    delay(TIEMPO_GIRO_90);
  }
  detener();
  delay(ESPERA_SERVO);                         // el cuello termina de volver al frente
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(9600);

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  detener();

  cuello.write(ANG_FRENTE);    // 90° antes de attach(): arranca mirando al frente sin saltos
  cuello.attach(PIN_SERVO);

  Serial.println(F("=== LAB IV: Robot explorador autónomo ==="));
  Serial.println(F("Arrancando en 3 s... coloca el robot en el piso."));
  delay(3000);
}

// ============================================================
//  LOOP: percibir -> procesar -> actuar
// ============================================================
void loop() {
  // 1) PERCIBIR: mirar al frente y medir
  cuello.write(ANG_FRENTE);
  long dFrente = medirDistancia();

  Serial.print(F("Frente = "));
  Serial.print(dFrente);
  Serial.print(F(" cm -> "));

  // 2) PROCESAR y 3) ACTUAR
  if (dFrente < DIST_BLOQUEO) {
    Serial.println(F("BLOQUEADO"));
    buscarRuta();
  } else if (dFrente < DIST_PRECAUCION) {
    Serial.println(F("precaución, avanzando despacio"));
    avanzar(VEL_LENTA);
  } else {
    Serial.println(F("libre, avanzando"));
    avanzar(VEL_AVANCE);
  }

  delay(60);   // el HC-SR04 necesita ~60 ms entre mediciones para evitar ecos viejos
}
