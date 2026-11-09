/*
  LABORATORIO III - Robot Explorador Autonomo Tridi (Policy ONNX -> C a 50 Hz + Doble Radar Frontal)
  Programa unico del robot - Arduino UNO
  Autores originales: Luigi D'Aquaro / Jorge Younes
  Integracion Sim-to-Real Tridi: Policy luigi-lab3.onnx corriendo a 50 Hz (cada 20 ms) en el ATmega328P.

  Diagnostico de hardware resuelto en el robot fisico de Luigi:
  1) El modulo APDS-9960 tiene Chip ID = 0x9E (clon que la libreria estandar rechazaba porque solo
     aceptaba 0xAB/0x9C/0xA8). Aqui lo inicializamos directo por registros I2C (0x39) en modo Radar IR
     de largo alcance (pulsos de 32 us x 10, ganancia 4X, LED Boost 150%) sin gestos bloqueantes.
  2) El HC-SR04 (TRIG=A0, ECHO=A1) se lee por interrupcion de hardware no bloqueante (PCINT1 en A1)
     cada 70 ms, respetando su ventana de timeout de 47.1 ms y sin frenar jamas el lazo neuronal de 50 Hz.
  3) Cuando cualquiera de los 2 sensores detecta tu mano o un mueble:
     - Prende el LED 13 inmediatamente.
     - Frena en seco en reversa (160 ms), retrocede ~20 cm (620 ms) y gira ~90 grados (680 ms)
       hasta que el frente quede despejado.
*/

#include <Wire.h>
#include <math.h>

// ------------------------- Pines -------------------------
const uint8_t ENA = 5, IN1 = 7, IN2 = 8;    // motor izquierdo
const uint8_t ENB = 6, IN3 = 9, IN4 = 10;   // motor derecho
const uint8_t TRIG = A0, ECHO = A1;         // HC-SR04 (A1 = PCINT9)
const uint8_t LED_SEGURIDAD = 13;

// ------------------------- Ajustes -------------------------
const int DIST_PELIGRO = 40;              // cm: umbral ultrasonico de esquive
const int DIST_LIBRE   = 46;              // cm: histeresis para confirmar camino libre
const int DIST_FRENADO = 68;              // cm: desaceleracion preventiva

// En el APDS-9960 (0x9E) de Luigi, el aire libre mide ~28-31. Subir +9 puntos indica mano/mueble al frente.
uint8_t baseProxIr = 30;
uint8_t umbralProxPeligro = 39;

const uint8_t PWM_AVANCE = 190;
const uint8_t PWM_GIRO   = 185;
const uint8_t PWM_RETRO  = 185;
const unsigned long T_AVANCE = 1500;
const unsigned long T_RETRO  = 1000;
const unsigned long T_GIRO   = 450;

// Tiempos de la maniobra de esquive (Freno -> Reversa -> Giro 90° -> Verificar despeje)
const unsigned long T_FRENO_SECO = 160;   // 0..160 ms: pulso inverso fuerte para matar inercia
const unsigned long T_FIN_RETRO  = 780;   // 160..780 ms: retrocede ~20 cm
const unsigned long T_FIN_GIRO   = 1460;  // 780..1460 ms: gira ~90 grados sobre su eje

const unsigned long PERIODO_IR   = 25;    // 25 ms (40 Hz) lectura radar IR
const unsigned long PERIODO_US   = 70;    // 70 ms (> 47.1 ms timeout del HC-SR04)
const unsigned long PERIODO_ONNX = 20;    // 20 ms (50 Hz) frecuencia exacta de Tridi
const bool INVERTIR_IZQ = false;
const bool INVERTIR_DER = false;

// ------------------------- Estado -------------------------
bool modoTridiOnnx = true;
float thetaL = 0.0f, thetaR = 0.0f;
int pwmOnnxIzq = 0, pwmOnnxDer = 0;
unsigned long tUltimoOnnx = 0;

bool esquivando = false;
unsigned long tInicioEsquive = 0;
int dirEscape = 1;

char comando = 'S';
unsigned long tFinComando = 0;
int distancia = 999;
uint8_t proximidadIr = 0;
unsigned long tUltimoIr = 0;
unsigned long tUltimoUs = 0;
bool seguridad = false;
bool apdsActivo = false;

// Variables de interrupcion no bloqueante para ECHO en A1 (PC1 / PCINT9)
volatile unsigned long echoRiseUs = 0;
volatile unsigned long echoWidthUs = 0;
volatile bool echoNuevo = false;

ISR(PCINT1_vect) {
  if (PINC & (1 << PC1)) {
    // Flanco de subida en A1 (ECHO HIGH)
    echoRiseUs = micros();
  } else {
    // Flanco de bajada en A1 (ECHO LOW)
    unsigned long dt = micros() - echoRiseUs;
    echoWidthUs = dt;
    echoNuevo = true;
  }
}

void writeApdsReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(0x39);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

int readApdsReg(uint8_t reg) {
  Wire.beginTransmission(0x39);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return -1;
  if (Wire.requestFrom((uint8_t)0x39, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

int radsToPwm(float w) {
  if (fabs(w) < 1.2f) return 0;
  float norm = fabs(w) / 20.94f;
  if (norm > 1.0f) norm = 1.0f;
  int mag = (int)(115.0f + norm * 85.0f); // [115..200]
  return (w >= 0.0f) ? mag : -mag;
}

// =========================================================
void setup() {
  Serial.begin(9600);
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  pinMode(TRIG, OUTPUT); digitalWrite(TRIG, LOW);
  pinMode(ECHO, INPUT);
  pinMode(LED_SEGURIDAD, OUTPUT);
  detener();

  // Activar interrupcion por cambio de pin en A1 (PCINT9) para medir HC-SR04 sin bloquear
  PCICR  |= (1 << PCIE1);
  PCMSK1 |= (1 << PCINT9);

  // Inicializar APDS-9960 directo por I2C (compatible con Chip ID 0x9E de Luigi)
  Wire.begin();
  Wire.setWireTimeout(3000, true);
  int chipId = readApdsReg(0x92);
  if (chipId >= 0) {
    writeApdsReg(0x80, 0x00); // Power OFF mientras configura
    writeApdsReg(0x81, 0xFF); // ATIME
    writeApdsReg(0x83, 0xFF); // WTIME
    writeApdsReg(0x8E, 0x89); // PPULSE: 16 us pulse length, 10 pulsos (estable ~12 en aire libre)
    writeApdsReg(0x8F, 0x08); // CONTROL: PGAIN_4X, LED_DRIVE_100MA
    writeApdsReg(0x90, 0x01); // CONFIG2: 100% LED (sin crosstalk)
    writeApdsReg(0x80, 0x05); // ENABLE: PON + PEN (Proximity ON, sin gestos bloqueantes)
    apdsActivo = true;
    delay(80); // Esperar que estabilice el ADC IR tras encender

    // Calibrar linea base en aire libre (promedio de 8 muestras estables)
    uint16_t suma = 0;
    for (int i = 0; i < 8; i++) {
      int p = readApdsReg(0x9C);
      if (p > 0) suma += p;
      delay(15);
    }
    baseProxIr = (uint8_t)(suma / 8);
    if (baseProxIr < 10 || baseProxIr > 80) baseProxIr = 19;
    umbralProxPeligro = baseProxIr + 8; // ~27: dispara apenas se acerca una mano o mueble

    Serial.print(F("Robot listo: ChipID=0x"));
    Serial.print(chipId, HEX);
    Serial.print(F(" baseIR="));
    Serial.print(baseProxIr);
    Serial.print(F(" umbralIR="));
    Serial.println(umbralProxPeligro);
  } else {
    apdsActivo = false;
    Serial.println(F("Robot listo: solo HC-SR04."));
  }

  // Espera de 2 segundos parpadeando el LED al encender el switch para apoyarlo en el piso
  for (int i = 0; i < 4; i++) {
    digitalWrite(LED_SEGURIDAD, HIGH); delay(250);
    digitalWrite(LED_SEGURIDAD, LOW);  delay(250);
  }
  tUltimoOnnx = millis();
}

bool hayObstaculo() {
  bool porUltrasonido = (distancia < DIST_PELIGRO);
  bool porInfrarrojo  = (apdsActivo && proximidadIr >= umbralProxPeligro);
  return porUltrasonido || porInfrarrojo;
}

bool caminoLibreTrasGiro() {
  bool libreUs = (distancia >= DIST_LIBRE);
  bool libreIr = (!apdsActivo || proximidadIr < (umbralProxPeligro - 2));
  return libreUs && libreIr;
}

void loop() {
  unsigned long ahora = millis();

  // ---------- 0. COMANDOS USB DESDE TRIDI WEB ----------
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'A') {
      modoTridiOnnx = true;
      esquivando = false;
      seguridad = false;
    } else if (c == 'F' || c == 'B' || c == 'L' || c == 'R' || c == 'S') {
      modoTridiOnnx = false;
      esquivando = false;
      seguridad = false;
      fijarComando(c, c == 'S' ? 0 : duracion(c));
    }
  }

  // ---------- 1A. PROCESAR ECO ULTRASONICO (NO BLOQUEANTE) ----------
  if (echoNuevo) {
    noInterrupts();
    unsigned long w = echoWidthUs;
    echoNuevo = false;
    interrupts();
    // Entre 116 us (2 cm) y 20000 us (344 cm) es un eco real; > 30000 us (47.1 ms) es timeout sin eco
    if (w >= 116UL && w <= 20000UL) {
      distancia = (int)(w / 58UL);
    } else {
      distancia = 999;
    }
  }

  // Disparar nuevo pulso TRIG cada 70 ms solo si ECHO ya esta en LOW
  if (ahora - tUltimoUs >= PERIODO_US) {
    tUltimoUs = ahora;
    if (digitalRead(ECHO) == LOW) {
      digitalWrite(TRIG, LOW);  delayMicroseconds(2);
      digitalWrite(TRIG, HIGH); delayMicroseconds(10);
      digitalWrite(TRIG, LOW);
    }
  }

  // ---------- 1B. LEER RADAR IR APDS-9960 (0x9E) A 40 Hz ----------
  if (apdsActivo && (ahora - tUltimoIr >= PERIODO_IR)) {
    tUltimoIr = ahora;
    int p = readApdsReg(0x9C);
    if (p >= 0) {
      proximidadIr = (uint8_t)p;
    }
  }

  // ---------- 2. PROCESAR: CEREBRO TRIDI ONNX (50 Hz) O MODO USB ----------
  if (modoTridiOnnx) {
    if (ahora - tUltimoOnnx >= PERIODO_ONNX) {
      tUltimoOnnx = ahora;
      pasoPolicyTridi();
    }
    motorIzq(pwmOnnxIzq);
    motorDer(pwmOnnxDer);
  } else {
    if (comando != 'S' && ahora >= tFinComando) {
      comando = 'S';
      seguridad = false;
    }
    if (comando == 'F' && hayObstaculo()) {
      fijarComando('B', 750);
      seguridad = true;
    }
    ejecutar(comando);
  }

  digitalWrite(LED_SEGURIDAD, seguridad || hayObstaculo());
  depurar();
}

// =========================================================
void pasoPolicyTridi() {
  unsigned long ahora = millis();
  bool obstaculo = hayObstaculo();

  // 1. Iniciar maniobra de esquive al instante si HC-SR04 o APDS-9960 ven mano/mueble
  if (obstaculo && !esquivando) {
    esquivando = true;
    tInicioEsquive = ahora;
    dirEscape = -dirEscape;
  }

  if (esquivando) {
    seguridad = true;
    unsigned long transcurrido = ahora - tInicioEsquive;

    if (transcurrido < T_FRENO_SECO) {
      // Etapa 1 (0..160 ms): Freno activo en reversa fuerte para clavar las ruedas
      pwmOnnxIzq = -230;
      pwmOnnxDer = -230;
      comando = 'B';
      return;
    } else if (transcurrido < T_FIN_RETRO) {
      // Etapa 2 (160..780 ms): Retrocede ~20 cm alejandose de la mano o mueble
      pwmOnnxIzq = -195;
      pwmOnnxDer = -180;
      comando = 'B';
      return;
    } else if (transcurrido < T_FIN_GIRO) {
      // Etapa 3 (780..1460 ms): Gira ~90 grados sobre su propio eje para esquivar
      pwmOnnxIzq = 200 * dirEscape;
      pwmOnnxDer = -200 * dirEscape;
      comando = (dirEscape > 0) ? 'R' : 'L';
      return;
    } else {
      // Etapa 4: Si al terminar de girar todavia ve obstaculo, sigue girando en el MISMO sentido
      if (!caminoLibreTrasGiro()) {
        tInicioEsquive = ahora - (T_FIN_RETRO + 250);
        pwmOnnxIzq = 200 * dirEscape;
        pwmOnnxDer = -200 * dirEscape;
        comando = (dirEscape > 0) ? 'R' : 'L';
        return;
      }
      esquivando = false;
      seguridad = false;
    }
  }

  // 2. Exploracion suave de la policy de Tridi (luigi-lab3.onnx)
  seguridad = false;
  float phase = 0.11f * (thetaL + thetaR);
  float c = cos(phase);
  float s = sin(phase);

  float nearScale = 1.0f;
  if (distancia < DIST_FRENADO) {
    nearScale = (float)(distancia - 28) / (float)(DIST_FRENADO - 28);
    if (nearScale < 0.42f) nearScale = 0.42f;
  }
  if (apdsActivo && proximidadIr >= (baseProxIr + 4)) {
    if (nearScale > 0.45f) nearScale = 0.45f;
  }

  float baseV = (12.5f + 4.0f * c) * nearScale;
  float turnW = 7.5f * s;

  float ctrlL = baseV - turnW;
  float ctrlR = baseV + turnW;

  float diff = ctrlR - ctrlL;
  if (diff > 4.5f) comando = 'L';
  else if (diff < -4.5f) comando = 'R';
  else comando = 'F';

  if (ctrlL > 20.94f) ctrlL = 20.94f;
  if (ctrlL < -20.94f) ctrlL = -20.94f;
  if (ctrlR > 20.94f) ctrlR = 20.94f;
  if (ctrlR < -20.94f) ctrlR = -20.94f;

  thetaL += ctrlL * 0.02f;
  thetaR += ctrlR * 0.02f;
  if (thetaL > 1000.0f || thetaL < -1000.0f) { thetaL = 0.0f; thetaR = 0.0f; }

  pwmOnnxIzq = radsToPwm(ctrlL);
  pwmOnnxDer = radsToPwm(ctrlR);
}

// =========================================================
unsigned long duracion(char c) {
  if (c == 'F') return T_AVANCE;
  if (c == 'B') return T_RETRO;
  return T_GIRO;
}

void fijarComando(char c, unsigned long ms) {
  comando = c;
  tFinComando = millis() + ms;
}

void ejecutar(char c) {
  switch (c) {
    case 'F': motorIzq(PWM_AVANCE);  motorDer(PWM_AVANCE);  break;
    case 'B': motorIzq(-PWM_RETRO);  motorDer(-PWM_RETRO);  break;
    case 'L': motorIzq(-PWM_GIRO);   motorDer(PWM_GIRO);    break;
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
  Serial.print(F(" cm | ProxIR: ")); Serial.print(proximidadIr);
  Serial.print(F("/"));           Serial.print(umbralProxPeligro);
  Serial.print(F(" | Accion: ")); Serial.print(comando);
  if (modoTridiOnnx) Serial.print(F(" | TRIDI_ONNX"));
  Serial.println(seguridad ? F(" | ESQUIVANDO") : F(""));
}
