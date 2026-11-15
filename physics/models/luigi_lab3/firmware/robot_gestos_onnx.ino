// ============================================================================
// TRIDI MCU COMPILER (export_mcu.py) — Luigi Lab 3 (3-Wheel Differential Drive + HC-SR04 Gesture Reactive)
// Origen ONNX: luigi-lab3.onnx (paridad numérica vs onnxruntime: max_diff = 1.91e-06)
// Guardrails de Hardware Verificados:
//   - Ultrasonic ISR Guardrail PASS: ECHO on A1 uses Pin Change Interrupt `ISR(PCINT1_vect)` (Port C bit 1), replacing blocking `pulseIn()`.
//   - Actuator Deadzone Compensation PASS: [0.5..20.94 rad/s] mapped linearly to [115..200 PWM] (overcomes L298N 1.4V drop + gearbox breakaway friction).
// ============================================================================

#include <Arduino.h>
#include <math.h>

// --- Pines del puente H L298N ---
const int ENA = 10;
const int IN1 = 9;
const int IN2 = 8;
const int ENB = 5;
const int IN3 = 7;
const int IN4 = 6;

// --- Pines del sensor ultrasónico HC-SR04 ---
const int PIN_TRIG = A0;
const int PIN_ECHO = A1;


// --- Calibración Física Sim-to-Real (MuJoCo -> L298N + Motores TT) ---
const float MAX_RADS = 20.94f;
const int DEADZONE_PWM = 115;
const int MAX_PWM = 200;
const float RIGHT_MOTOR_TRIM = 1.00f;
const unsigned long CONTROL_MS = 20;  // 50 Hz (0.020 s por paso)
const float STOP_DIST_CM = 22.0f;
const float CLEAR_DIST_CM = 27.0f;

// --- Pesos y constantes extraídos automáticamente del grafo ONNX ---
#define TRIDI_OBS_DIM 15
#define TRIDI_ACT_DIM 2
static const float w_low[2] = { -20.9400005f, -20.9400005f };
static const float w_high[2] = { 20.9400005f, 20.9400005f };
static const float w_l_th_weight[15] = { 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.1100000f, 0.1100000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f };
static const float w_l_th_bias[1] = { 0.0000000f };
static const float w_l_wz_weight[15] = { 0.0000000f, 0.0000000f, -6.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, -2.5000000f, 0.0000000f };
static const float w_l_vx_weight[15] = { 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0000000f, 0.0200000f, 0.0200000f, -8.0000000f, 0.0000000f, 0.0000000f };
static const float w_l_vx_bias[1] = { -1.1000000f };
static const float w_m_cos_weight[2] = { 4.0000000f, 4.0000000f };
static const float w_m_cos_bias[2] = { 12.5000000f, 12.5000000f };
static const float w_onnx__MatMul_33[2] = { -7.5000000f, 7.5000000f };
static const float w_onnx__MatMul_34[2] = { -1.0000000f, 1.0000000f };
static const float w_onnx__MatMul_35[2] = { -18.0000000f, -6.0000000f };

// Forward pass compilado directamente desde el grafo ONNX (0 asignaciones dinámicas, O(1) SRAM)
static inline void tridi_policy_forward(const float* obs, float* ctrl) {
  float t_1_l_th_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_th_bias[i];
    for (int j = 0; j < 15; ++j) {
      acc += obs[j] * w_l_th_weight[i * 15 + j];
    }
    t_1_l_th_Gemm_output_0[i] = acc;
  }
  float t_2_l_wz_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_th_bias[i];
    for (int j = 0; j < 15; ++j) {
      acc += obs[j] * w_l_wz_weight[i * 15 + j];
    }
    t_2_l_wz_Gemm_output_0[i] = acc;
  }
  float t_3_l_vx_Gemm_output_0[1];
  for (int i = 0; i < 1; ++i) {
    float acc = w_l_vx_bias[i];
    for (int j = 0; j < 15; ++j) {
      acc += obs[j] * w_l_vx_weight[i * 15 + j];
    }
    t_3_l_vx_Gemm_output_0[i] = acc;
  }
  float t_4_Tanh_output_0[1];
  for (int i = 0; i < 1; ++i) { t_4_Tanh_output_0[i] = tanhf(t_3_l_vx_Gemm_output_0[i]); }
  float t_5_Relu_output_0[1];
  for (int i = 0; i < 1; ++i) { t_5_Relu_output_0[i] = ((t_4_Tanh_output_0[i] > 0.0f) ? t_4_Tanh_output_0[i] : 0.0f); }
  float t_6_Cos_output_0[1];
  for (int i = 0; i < 1; ++i) { t_6_Cos_output_0[i] = cosf(t_1_l_th_Gemm_output_0[i]); }
  float t_7_m_cos_Gemm_output_0[2];
  for (int i = 0; i < 2; ++i) {
    float acc = w_m_cos_bias[i];
    for (int j = 0; j < 1; ++j) {
      acc += t_6_Cos_output_0[j] * w_m_cos_weight[i * 1 + j];
    }
    t_7_m_cos_Gemm_output_0[i] = acc;
  }
  float t_8_Sin_output_0[1];
  for (int i = 0; i < 1; ++i) { t_8_Sin_output_0[i] = sinf(t_1_l_th_Gemm_output_0[i]); }
  float t_9_m_sin_MatMul_output_0[2];
  for (int i = 0; i < 2; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_8_Sin_output_0[j] * w_onnx__MatMul_33[j * 2 + i];
    }
    t_9_m_sin_MatMul_output_0[i] = acc;
  }
  float t_10_Add_output_0[2];
  for (int i = 0; i < 2; ++i) { t_10_Add_output_0[i] = (t_7_m_cos_Gemm_output_0[i] + t_9_m_sin_MatMul_output_0[i]); }
  float t_11_m_stab_MatMul_output_0[2];
  for (int i = 0; i < 2; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_2_l_wz_Gemm_output_0[j] * w_onnx__MatMul_34[j * 2 + i];
    }
    t_11_m_stab_MatMul_output_0[i] = acc;
  }
  float t_12_Add_1_output_0[2];
  for (int i = 0; i < 2; ++i) { t_12_Add_1_output_0[i] = (t_10_Add_output_0[i] + t_11_m_stab_MatMul_output_0[i]); }
  float t_13_m_stall_MatMul_output_0[2];
  for (int i = 0; i < 2; ++i) {
    float acc = 0.0f;
    for (int j = 0; j < 1; ++j) {
      acc += t_5_Relu_output_0[j] * w_onnx__MatMul_35[j * 2 + i];
    }
    t_13_m_stall_MatMul_output_0[i] = acc;
  }
  float t_14_Add_2_output_0[2];
  for (int i = 0; i < 2; ++i) { t_14_Add_2_output_0[i] = (t_12_Add_1_output_0[i] + t_13_m_stall_MatMul_output_0[i]); }
  float t_15_Max_output_0[2];
  for (int i = 0; i < 2; ++i) { t_15_Max_output_0[i] = ((t_14_Add_2_output_0[i] > w_low[i]) ? t_14_Add_2_output_0[i] : w_low[i]); }
  for (int i = 0; i < 2; ++i) { ctrl[i] = ((t_15_Max_output_0[i] < w_high[i]) ? t_15_Max_output_0[i] : w_high[i]); }
}

// Medición ultrasónica NO BLOQUEANTE por Pin Change Interrupt (Puerto C, A1 = PCINT9)
volatile unsigned long echoStartUs = 0;
volatile unsigned int lastEchoDurationUs = 0;
volatile bool echoNewSample = false;
volatile uint8_t prevPinC = 0;

ISR(PCINT1_vect) {
  uint8_t cur = PINC;
  uint8_t changed = cur ^ prevPinC;
  prevPinC = cur;
  if (changed & (1 << PC1)) {
    if (cur & (1 << PC1)) {
      echoStartUs = micros();
    } else {
      unsigned long dur = micros() - echoStartUs;
      if (dur > 100 && dur < 25000) {
        lastEchoDurationUs = (unsigned int)dur;
        echoNewSample = true;
      }
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
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, HIGH);
  } else {
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
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

  cli();
  PCICR |= (1 << PCIE1);
  PCMSK1 |= (1 << PCINT9);
  prevPinC = PINC;
  sei();
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

  // 3. Lazo de control neuronal a 50 Hz (20 ms)
  if (nowMs - lastControlMs >= CONTROL_MS) {
    lastControlMs = nowMs;

    // Construir vector de observación de 15 dimensiones idéntico a MuJoCo / Web
    float obs[TRIDI_OBS_DIM];
    for (int i = 0; i < TRIDI_OBS_DIM; ++i) obs[i] = 0.0f;

    // Si el camino está despejado, la fase estYawRad avanza suave para patrullar o girar hacia el lado más libre
    float steerBias = 0.0f;
    if (filteredDistCm < STOP_DIST_CM) {
      steerBias = 1.15f;
    }
    estYawRad += (estYawRateRadS + steerBias) * 0.0200f;
    if (estYawRad > 3.14159f) estYawRad -= 6.28318f;
    if (estYawRad < -3.14159f) estYawRad += 6.28318f;

    obs[2] = sinf(estYawRad * 0.5f);      // qpos quat_z (heading)
    obs[6] = prevCtrl[0] * 0.0200f;   // wheel_l angle delta
    obs[7] = prevCtrl[1] * 0.0200f;   // wheel_r angle delta
    obs[8] = estVxMS;                     // linear velocity vx (m/s)
    obs[10] = estYawRateRadS;             // yaw rate wz (rad/s)
    obs[11] = prevCtrl[0];                // wheel_l vel (rad/s)
    obs[12] = prevCtrl[1];                // wheel_r vel (rad/s)
    obs[13] = prevCtrl[0];                // prev_ctrl_l
    obs[14] = prevCtrl[1];                // prev_ctrl_r

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
    }

    setMotorsRadS(ctrl[0], ctrl[1]);

    // Actualizar odometría interna para el siguiente paso de 20 ms
    prevCtrl[0] = ctrl[0];
    prevCtrl[1] = ctrl[1];
    estVxMS = 0.033f * 0.5f * (ctrl[0] + ctrl[1]);
    estYawRateRadS = 0.033f * (ctrl[1] - ctrl[0]) / 0.135f;
  }
}
