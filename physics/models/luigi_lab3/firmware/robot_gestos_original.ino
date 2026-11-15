/*
  LABORATORIO III - Robot explorador controlado por gestos
  Programa unico del robot - Arduino UNO
  Autores: Luigi D'Aquaro / Jorge Younes

  El sensor de gestos APDS-9960 va en el frente, encima del HC-SR04, mirando hacia adelante.
  El operador se pone DE FRENTE al robot y mueve la mano a 5-15 cm delante del sensor:
    subir la mano              -> el robot avanza hacia ti 1,5 s (arranca cuando retiras la mano)
    bajar la mano              -> retrocede 1 s
    mano hacia TU derecha      -> gira hacia tu derecha (su izquierda) 0,45 s
    mano hacia TU izquierda    -> gira hacia tu izquierda (su derecha) 0,45 s
    acercar la mano y retirarla -> detener

  La mano que hace el gesto queda delante del HC-SR04. Por eso "avanzar" espera hasta 2 s a que
  la distancia vuelva a ser mayor de 20 cm; si no se despeja, se trata como obstaculo y retrocede.

  Ciclo de control en tiempo real (loop):
    1) PERCIBIR : lee el gesto (APDS-9960) y mide la distancia al frente (HC-SR04)
    2) PROCESAR : si hay un obstaculo a menos de 20 cm, ignora "avanzar" y retrocede (lazo cerrado)
    3) ACTUAR   : mueve los motores con el puente H L298N

  Libreria: "SparkFun APDS9960 RGB and Gesture Sensor" (Gestor de Bibliotecas).
  Si apds.init() falla con un modulo clon: abrir SparkFun_APDS9960.h y cambiar
  "#define APDS9960_ID_2 0x9C" por "#define APDS9960_ID_2 0xA8".

  Conexiones
  ----------
  L298N    ENA -> D5 (PWM)   IN1 -> D7   IN2 -> D8     (motor IZQUIERDO en OUT1/OUT2)
           ENB -> D6 (PWM)   IN3 -> D9   IN4 -> D10    (motor DERECHO   en OUT3/OUT4)
           (quitar los jumpers de ENA y ENB)   +12V -> bateria +   GND -> GND comun
  HC-SR04  TRIG -> A0   ECHO -> A1   VCC -> riel 5V   GND -> riel GND
  APDS-9960 VCC -> riel 3,3V (NUNCA 5V)   GND -> riel GND   SDA -> A4   SCL -> A5
  Protoboard: riel 5V desde el pin 5V del Arduino, riel 3,3V desde el pin 3.3V, GND comun.
  Bateria 2S (7,4 V) -> VIN del Arduino y +12V del L298N.
*/

#include <Wire.h>
#include <SparkFun_APDS9960.h>

// ------------------------- Pines -------------------------
const uint8_t ENA = 5, IN1 = 7, IN2 = 8;    // motor izquierdo
const uint8_t ENB = 6, IN3 = 9, IN4 = 10;   // motor derecho
const uint8_t TRIG = A0, ECHO = A1;
const uint8_t LED_SEGURIDAD = 13;

SparkFun_APDS9960 apds;

// ------------------------- Ajustes -------------------------
const int DIST_PELIGRO = 20;              // cm: por debajo se ignora "avanzar" y retrocede
const uint8_t PWM_AVANCE = 190;           // ~5-6 V en los motores con bateria 2S
const uint8_t PWM_GIRO   = 160;
const uint8_t PWM_RETRO  = 150;
const unsigned long T_AVANCE = 1500;      // ms que dura cada comando
const unsigned long T_RETRO  = 1000;
const unsigned long T_GIRO   = 450;
const unsigned long T_ESCAPE = 400;       // ms de retroceso al encontrar un obstaculo
const unsigned long T_ESPERA_MANO = 2000; // ms maximos esperando que el operador retire la mano
const unsigned long PERIODO_US = 60;      // ms entre mediciones del HC-SR04
const bool INVERTIR_IZQ = false;          // cambiar si un motor gira al reves
const bool INVERTIR_DER = false;

// Direcciones vistas por el operador, de frente al robot. Como el robot te mira, tu derecha es
// su izquierda. Si al probar sale otro movimiento, reasigna aqui cada direccion:
const char GESTO_UP = 'F', GESTO_DOWN = 'B', GESTO_LEFT = 'R', GESTO_RIGHT = 'L';

// ------------------------- Estado -------------------------
char comando = 'S';                 // F, B, L, R o S
unsigned long tFinComando = 0;
bool esperandoMano = false;         // gesto "avanzar" recibido, falta que se retire la mano
unsigned long tLimiteMano = 0;
int distancia = 999;
int lecturas[3] = {999, 999, 999};
unsigned long tUltimaMedida = 0;
bool seguridad = false;

// =========================================================
void setup() {
  Serial.begin(9600);
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT);
  pinMode(LED_SEGURIDAD, OUTPUT);
  detener();

  if (apds.init() && apds.enableGestureSensor(false)) {
    Serial.println(F("Robot listo. Pasa la mano sobre el APDS-9960."));
  } else {
    Serial.println(F("Aviso: APDS-9960 desconectado, modo USB Serial activo"));
    // while (true) { digitalWrite(LED_SEGURIDAD, !digitalRead(LED_SEGURIDAD)); delay(150); }
  }
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'F' || c == 'B' || c == 'L' || c == 'R' || c == 'S') {
      esperandoMano = false;
      seguridad = false;
      fijarComando(c, c == 'S' ? 0 : duracion(c));
    }
  }
  // ---------- 1. PERCIBIR ----------
  if (apds.isGestureAvailable()) {
    detener();                       // la lectura del gesto dura mientras la mano pasa: el robot espera quieto
    leerGesto();
  }
  if (millis() - tUltimaMedida >= PERIODO_US) {
    tUltimaMedida = millis();
    distancia = medirDistanciaFiltrada();
  }

  // ---------- 2. PROCESAR ----------
  if (comando != 'S' && millis() >= tFinComando) {
    comando = 'S';                   // termino el tiempo del movimiento
    seguridad = false;
  }
  if (esperandoMano) {
    if (distancia >= DIST_PELIGRO) {             // la mano ya se retiro: arranca
      esperandoMano = false;
      fijarComando('F', T_AVANCE);
    } else if (millis() > tLimiteMano) {         // sigue algo delante: es un obstaculo
      esperandoMano = false;
      fijarComando('B', T_ESCAPE);
      seguridad = true;
      Serial.println(F("Obstaculo al avanzar: se ignora el gesto y retrocede"));
    }
  }
  if (comando == 'F' && distancia < DIST_PELIGRO) {
    fijarComando('B', T_ESCAPE);     // lazo cerrado: ignora el gesto y retrocede
    seguridad = true;
    Serial.println(F("Obstaculo: se ignora el gesto y retrocede"));
  }

  // ---------- 3. ACTUAR ----------
  ejecutar(comando);
  digitalWrite(LED_SEGURIDAD, seguridad);
  depurar();
}

// =========================================================
void leerGesto() {
  switch (apds.readGesture()) {
    case DIR_UP:    aplicarGesto(GESTO_UP);    break;
    case DIR_DOWN:  aplicarGesto(GESTO_DOWN);  break;
    case DIR_LEFT:  aplicarGesto(GESTO_LEFT);  break;
    case DIR_RIGHT: aplicarGesto(GESTO_RIGHT); break;
    case DIR_NEAR:
    case DIR_FAR:   aplicarGesto('S'); break;
    default: return;
  }
  seguridad = false;
}

void aplicarGesto(char c) {
  Serial.print(F("Gesto -> ")); Serial.println(c);
  esperandoMano = false;
  if (c == 'F') {
    // No arranca todavia: la mano esta delante del HC-SR04. Se descartan las lecturas
    // viejas para exigir medidas nuevas antes de decidir.
    comando = 'S';
    esperandoMano = true;
    tLimiteMano = millis() + T_ESPERA_MANO;
    lecturas[0] = lecturas[1] = lecturas[2] = 0;
    distancia = 0;
  } else if (c == 'S') {
    fijarComando('S', 0);
  } else {
    fijarComando(c, duracion(c));
  }
}

unsigned long duracion(char c) {
  if (c == 'F') return T_AVANCE;
  if (c == 'B') return T_RETRO;
  return T_GIRO;
}

void fijarComando(char c, unsigned long ms) {
  comando = c;
  tFinComando = millis() + ms;
}

int medirDistanciaCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long t = pulseIn(ECHO, HIGH, 25000UL);   // 25 ms ~ 4 m
  if (t == 0) return 999;                            // sin eco = camino libre
  return t / 58;                                     // us -> cm
}

// Mediana de las ultimas 3 lecturas: elimina picos falsos por ruido de los motores
int medirDistanciaFiltrada() {
  lecturas[0] = lecturas[1];
  lecturas[1] = lecturas[2];
  lecturas[2] = medirDistanciaCm();
  int a = lecturas[0], b = lecturas[1], c = lecturas[2];
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

void ejecutar(char c) {
  switch (c) {
    case 'F': motorIzq(PWM_AVANCE);  motorDer(PWM_AVANCE);  break;
    case 'B': motorIzq(-PWM_RETRO);  motorDer(-PWM_RETRO);  break;
    case 'L': motorIzq(-PWM_GIRO);   motorDer(PWM_GIRO);    break;   // giro sobre su eje
    case 'R': motorIzq(PWM_GIRO);    motorDer(-PWM_GIRO);   break;
    default:  detener();                                     break;
  }
}

void motor(uint8_t en, uint8_t a, uint8_t b, int v, bool invertir) {
  if (invertir) v = -v;
  digitalWrite(a, v > 0);
  digitalWrite(b, v < 0);
  analogWrite(en, abs(v));
}
void motorIzq(int v) { motor(ENA, IN1, IN2, v, INVERTIR_IZQ); }
void motorDer(int v) { motor(ENB, IN3, IN4, v, INVERTIR_DER); }
void detener() { motorIzq(0); motorDer(0); }

void depurar() {
  static unsigned long t = 0;
  if (millis() - t < 250) return;
  t = millis();
  Serial.print(F("Dist: "));      Serial.print(distancia);
  Serial.print(F(" cm | Accion: ")); Serial.print(comando);
  if (esperandoMano) Serial.print(F(" | esperando que retires la mano"));
  Serial.println(seguridad ? F(" | SEGURIDAD") : F(""));
}
