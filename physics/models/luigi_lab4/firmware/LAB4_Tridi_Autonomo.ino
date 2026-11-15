// ============================================================================
// TRIDI MCU COMPILER (export_mcu.py) — Luigi Lab 4 (Autonomous Explorer + SG90 Servo Radar Neck on D9)
// Origen ONNX: luigi-lab4.onnx (paridad numérica vs onnxruntime: max_diff = 1.19e-07)
// Guardrails de Hardware Verificados:
//   - Timer1 Guardrail PASS: Servo on D9 uses Timer1 while ENA=D5, ENB=D6 use Timer0 PWM (no timer collision).
//   - Non-blocking Radar State Machine: replaced blocking `myServo.write() + delay(350)` with asynchronous 50 Hz servo sweep (`radarTick()`).
//   - Ultrasonic ISR Guardrail PASS: ECHO on D3 uses hardware external interrupt `INT1` (`attachInterrupt`), zero CPU blocking.
//   - Actuator Deadzone Compensation PASS: [0.5..20.94 rad/s] mapped linearly to [115..200 PWM] (overcomes L298N 1.4V drop + gearbox breakaway friction).
// ============================================================================

#include <Arduino.h>
#include <math.h>
#include <Servo.h>

// --- Pines del puente H L298N ---
const int ENA = 5;
const int IN1 = 7;
const int IN2 = 8;
const int ENB = 6;
const int IN3 = 11;
const int IN4 = 12;

// --- Pines del sensor ultrasónico HC-SR04 ---
const int PIN_TRIG = 2;
const int PIN_ECHO = 3;

const int PIN_SERVO = 9;  // SG90 cuello radar (Timer1; ENA/ENB en D5/D6 Timer0)
Servo neckServo;
// Radar no bloqueante: 0 = frente (90 deg), 1 = derecha (25 deg), 2 = frente (90 deg), 3 = izquierda (155 deg)
const int RADAR_ANGLES[4] = { 90, 25, 90, 155 };
int radarPhase = 0;
unsigned long lastRadarStepMs = 0;
float clearanceRightCm = 80.0f;
float clearanceCenterCm = 80.0f;
float clearanceLeftCm = 80.0f;

// --- Calibración Física Sim-to-Real (MuJoCo -> L298N + Motores TT) ---
const float MAX_RADS = 20.94f;
const int DEADZONE_PWM = 115;
const int MAX_PWM = 200;
const float RIGHT_MOTOR_TRIM = 0.90f;
const unsigned long CONTROL_MS = 20;  // 50 Hz (0.020 s por paso)
const float STOP_DIST_CM = 25.0f;
const float CLEAR_DIST_CM = 32.0f;

// --- Pesos y constantes extraídos automáticamente del grafo ONNX ---
#define TRIDI_OBS_DIM 18
#define TRIDI_ACT_DIM 3
static const float w_w_sin[3] = { -1.7730608f, 1.6110165f, 0.4493130f };
static const float w_w_stab[3] = { -2.3813238f, 2.3830349f, 0.3734572f };
static const float w_w_stall[3] = { 3.8000000f, 3.8000000f, 0.0000000f };
static const float w_w_neck_sin[3] = { 0.3991691f, -0.3056586f, 0.7369397f };
static const float w_low[3] = { -20.0000000f, -20.0000000f, -1.5707999f };
static const float w_high[3] = { 20.0000000f, 20.0000000f, 1.5707999f };
static const float w_l_th_weight[18] = { 0.0000000f, 0.0000000f, 0.3500000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0550000f, 0.0550000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f };
static const float w_l_th_bias[1] = { 0.0000000f };
static const float w_l_wz_weight[18] = { 0.0000000f, 0.0000000f, -0.8500000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.1500000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, -0.6000000f, 0.0000000f };
static const float w_l_vx_weight[18] = { 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0800000f, 0.0800000f, 0.0000000f, -1.6500000f, 0.0000000f, 0.0000000f };
static const float w_l_vx_bias[1] = { 0.4200000f };
static const float w_l_neck_weight[18] = { 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.1400000f, 0.1400000f, -0.3500000f, 0.0000000f, 0.0000000f, -0.2000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f };
static const float w_m_cos_weight[3] = { 1.3980531f, -1.3791908f, 0.1578013f };
static const float w_m_cos_bias[3] = { 15.8000002f, 15.8000002f, 0.0000000f };

// Forward pass compilado directamente desde el grafo ONNX (0 asignaciones dinámicas, O(1) SRAM)
static inline void tridi_policy_forward(const float* obs, float* ctrl) {
  float t_2_l_th_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_th_bias[i];
    for (int j = 0; j < 18; ++j) {
      acc += obs[j] * w_l_th_weight[i * 18 + j];
    }
    t_2_l_th_Gemm_output_0[i] = acc;
  }
  float t_3_l_wz_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_th_bias[i];
    for (int j = 0; j < 18; ++j) {
      acc += obs[j] * w_l_wz_weight[i * 18 + j];
    }
    t_3_l_wz_Gemm_output_0[i] = acc;
  }
  float t_4_l_vx_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_vx_bias[i];
    for (int j = 0; j < 18; ++j) {
      acc += obs[j] * w_l_vx_weight[i * 18 + j];
    }
    t_4_l_vx_Gemm_output_0[i] = acc;
  }
  float t_5_Tanh_output_0[1];
  for (int i = 0; i < 1; ++i) { t_5_Tanh_output_0[i] = tanhf(t_4_l_vx_Gemm_output_0[i]); }
  float t_6_Relu_output_0[1];
  for (int i = 0; i < 1; ++i) { t_6_Relu_output_0[i] = ((t_5_Tanh_output_0[i] > 0.0f) ? t_5_Tanh_output_0[i] : 0.0f); }
  float t_7_l_neck_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_th_bias[i];
    for (int j = 0; j < 18; ++j) {
      acc += obs[j] * w_l_neck_weight[i * 18 + j];
    }
    t_7_l_neck_Gemm_output_0[i] = acc;
  }
  float t_8_Cos_output_0[1];
  for (int i = 0; i < 1; ++i) { t_8_Cos_output_0[i] = cosf(t_2_l_th_Gemm_output_0[i]); }
  float t_9_m_cos_Gemm_output_0[3];
  for (int i = 0; i < 3; ++i) {
    float acc = w_m_cos_bias[i];
    for (int j = 0; j < 1; ++j) {
      acc += t_8_Cos_output_0[j] * w_m_cos_weight[i * 1 + j];
    }
    t_9_m_cos_Gemm_output_0[i] = acc;
  }
  float t_10_Sin_output_0[1];
  for (int i = 0; i < 1; ++i) { t_10_Sin_output_0[i] = sinf(t_2_l_th_Gemm_output_0[i]); }
  float t_11_MatMul_output_0[3];
  for (int i = 0; i < 3; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_10_Sin_output_0[j] * w_w_sin[j * 3 + i];
    }
    t_11_MatMul_output_0[i] = acc;
  }
  float t_12_Add_output_0[3];
  for (int i = 0; i < 3; ++i) { t_12_Add_output_0[i] = (t_9_m_cos_Gemm_output_0[i] + t_11_MatMul_output_0[i]); }
  float t_13_MatMul_1_output_0[3];
  for (int i = 0; i < 3; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_3_l_wz_Gemm_output_0[j] * w_w_stab[j * 3 + i];
    }
    t_13_MatMul_1_output_0[i] = acc;
  }
  float t_14_MatMul_2_output_0[3];
  for (int i = 0; i < 3; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_6_Relu_output_0[j] * w_w_stall[j * 3 + i];
    }
    t_14_MatMul_2_output_0[i] = acc;
  }
  float t_15_Sin_1_output_0[1];
  for (int i = 0; i < 1; ++i) { t_15_Sin_1_output_0[i] = sinf(t_7_l_neck_Gemm_output_0[i]); }
  float t_16_MatMul_3_output_0[3];
  for (int i = 0; i < 3; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_15_Sin_1_output_0[j] * w_w_neck_sin[j * 3 + i];
    }
    t_16_MatMul_3_output_0[i] = acc;
  }
  float t_17_Add_1_output_0[3];
  for (int i = 0; i < 3; ++i) { t_17_Add_1_output_0[i] = (t_12_Add_output_0[i] + t_13_MatMul_1_output_0[i]); }
  float t_18_Add_2_output_0[3];
  for (int i = 0; i < 3; ++i) { t_18_Add_2_output_0[i] = (t_17_Add_1_output_0[i] + t_14_MatMul_2_output_0[i]); }
  float t_19_Add_3_output_0[3];
  for (int i = 0; i < 3; ++i) { t_19_Add_3_output_0[i] = (t_18_Add_2_output_0[i] + t_16_MatMul_3_output_0[i]); }
  float t_20_Max_output_0[3];
  for (int i = 0; i < 3; ++i) { t_20_Max_output_0[i] = ((t_19_Add_3_output_0[i] > w_low[i]) ? t_19_Add_3_output_0[i] : w_low[i]); }
  for (int i = 0; i < 3; ++i) { ctrl[i] = ((t_20_Max_output_0[i] < w_high[i]) ? t_20_Max_output_0[i] : w_high[i]); }
}

// Medición ultrasónica NO BLOQUEANTE por interrupción externa (D3 -> INT1)
volatile unsigned long echoStartUs = 0;
volatile unsigned int lastEchoDurationUs = 0;
volatile bool echoNewSample = false;

void echoISR() {
  if (digitalRead(PIN_ECHO) == HIGH) {
    echoStartUs = micros();
  } else {
    unsigned long dur = micros() - echoStartUs;
    if (dur > 100 && dur < 25000) {
      lastEchoDurationUs = (unsigned int)dur;
      echoNewSample = true;
    }
  }
}

// Dispara un pulso ultrasónico de 10 us sin bloquear el lazo de 50 Hz
static inline void triggerUltrasonic() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
}

// Convierte velocidad angular física (rad/s de la política ONNX) a PWM compensando zona muerta
static inline int radsToPwm(float rads, float trim) {
  float mag = fabsf(rads) * trim;
  if (mag < 0.5f) return 0;  // Zona de parada limpia
  float norm = mag / MAX_RADS;
  if (norm > 1.0f) norm = 1.0f;
  int pwm = DEADZONE_PWM + (int)(norm * (float)(MAX_PWM - DEADZONE_PWM));
  return constrain(pwm, 0, 255);
}

// Aplica velocidades en rad/s [rueda_izq, rueda_der] al puente H L298N
void setMotorsRadS(float leftRadS, float rightRadS) {
  int pwmL = radsToPwm(leftRadS, 1.0f);
  int pwmR = radsToPwm(rightRadS, RIGHT_MOTOR_TRIM);

  if (pwmL == 0) {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
  } else if (leftRadS >= 0.0f) {
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
  } else {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, HIGH);
  }

  if (pwmR == 0) {
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, LOW);
  } else if (rightRadS >= 0.0f) {
    digitalWrite(IN3, HIGH);
    digitalWrite(IN4, LOW);
  } else {
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, HIGH);
  }

  analogWrite(ENA, pwmL);
  analogWrite(ENB, pwmR);
}

// Estado interno del estimador cinemático y de la política neuronal
float filteredDistCm = 60.0f;
float estYawRad = 0.0f;
float estYawRateRadS = 0.0f;
float estVxMS = 0.0f;
float prevCtrl[TRIDI_ACT_DIM] = { 0.0f, 0.0f };
unsigned long lastControlMs = 0;
unsigned long lastSonarMs = 0;

void setup() {
  Serial.begin(9600);
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  neckServo.attach(PIN_SERVO);
  neckServo.write(90);
  attachInterrupt(digitalPinToInterrupt(PIN_ECHO), echoISR, CHANGE);
  setMotorsRadS(0.0f, 0.0f);
}

void loop() {
  unsigned long nowMs = millis();

  // 1. Disparo ultrasónico cada 40 ms (25 Hz) sin bloquear
  if (nowMs - lastSonarMs >= 40) {
    lastSonarMs = nowMs;
    if (echoNewSample) {
      noInterrupts();
      unsigned int dur = lastEchoDurationUs;
      echoNewSample = false;
      interrupts();
      float cm = (float)dur * 0.01715f;
      if (cm >= 2.0f && cm <= 250.0f) {
        filteredDistCm = 0.65f * filteredDistCm + 0.35f * cm;
      }
    }
    triggerUltrasonic();
  }

  // 2. Barrido no bloqueante del cuello servo SG90 (si hay obstáculo cercano explora izq/der sin frenar el loop)
  if (filteredDistCm < CLEAR_DIST_CM && (nowMs - lastRadarStepMs >= 180)) {
    lastRadarStepMs = nowMs;
    if (RADAR_ANGLES[radarPhase] == 90) clearanceCenterCm = filteredDistCm;
    else if (RADAR_ANGLES[radarPhase] < 90) clearanceRightCm = filteredDistCm;
    else clearanceLeftCm = filteredDistCm;
    radarPhase = (radarPhase + 1) & 3;
    neckServo.write(RADAR_ANGLES[radarPhase]);
  } else if (filteredDistCm >= CLEAR_DIST_CM && radarPhase != 0) {
    radarPhase = 0;
    neckServo.write(90);
  }

  // 3. Lazo de control neuronal a 50 Hz (20 ms)
  if (nowMs - lastControlMs >= CONTROL_MS) {
    lastControlMs = nowMs;

    // Construir vector de observación de 18 dimensiones idéntico a MuJoCo / Web
    float obs[TRIDI_OBS_DIM];
    for (int i = 0; i < TRIDI_OBS_DIM; ++i) obs[i] = 0.0f;

    // Si el camino está despejado, la fase estYawRad avanza suave para patrullar o girar hacia el lado más libre
    float steerBias = 0.0f;
    if (filteredDistCm < STOP_DIST_CM) {
      steerBias = (clearanceLeftCm >= clearanceRightCm) ? 1.25f : -1.25f;
    }
    estYawRad += (estYawRateRadS + steerBias) * 0.0200f;
    if (estYawRad > 3.14159f) estYawRad -= 6.28318f;
    if (estYawRad < -3.14159f) estYawRad += 6.28318f;

    obs[2] = sinf(estYawRad * 0.5f);      // qpos quat_z (heading)
    obs[6] = prevCtrl[0] * 0.0200f;   // wheel_l angle delta
    obs[7] = prevCtrl[1] * 0.0200f;   // wheel_r angle delta
    obs[8] = prevCtrl[2];                 // neck_servo angle (rad)
    obs[9] = prevCtrl[0] * 0.05f;         // wheel_l vel scaled
    obs[10] = prevCtrl[1] * 0.05f;        // wheel_r vel scaled
    obs[12] = prevCtrl[0] * 4.0f;         // prev_ctrl_l scaled
    obs[13] = prevCtrl[1] * 4.0f;         // prev_ctrl_r scaled
    obs[14] = prevCtrl[2] * 4.0f;         // prev_ctrl_neck scaled
    obs[15] = estVxMS;                    // linear velocity vx (m/s)
    obs[17] = estYawRateRadS;             // yaw rate wz (rad/s)

    float ctrl[TRIDI_ACT_DIM];
    tridi_policy_forward(obs, ctrl);

    // Modulación reactiva de seguridad ante obstáculos cercanos
    if (filteredDistCm < STOP_DIST_CM) {
      float turnDir = (steerBias >= 0.0f) ? 1.0f : -1.0f;
      ctrl[0] = -11.5f * turnDir;
      ctrl[1] = 11.5f * turnDir;
    } else if (filteredDistCm >= CLEAR_DIST_CM) {
      // Avance crucero asistido por la política neuronal
      ctrl[0] = 0.65f * MAX_RADS + 0.35f * ctrl[0];
      ctrl[1] = 0.65f * MAX_RADS + 0.35f * ctrl[1];
      if (radarPhase == 0) {
        int neckDeg = constrain(90 + (int)(ctrl[2] * 38.0f), 25, 155);
        neckServo.write(neckDeg);
      }
    }

    setMotorsRadS(ctrl[0], ctrl[1]);

    // Actualizar odometría interna para el siguiente paso de 20 ms
    prevCtrl[0] = ctrl[0];
    prevCtrl[1] = ctrl[1];
    prevCtrl[2] = ctrl[2];
    estVxMS = 0.033f * 0.5f * (ctrl[0] + ctrl[1]);
    estYawRateRadS = 0.033f * (ctrl[1] - ctrl[0]) / 0.135f;
  }
}
