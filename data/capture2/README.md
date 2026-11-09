# Captura 2.0

Del video al cuerpo humano en 3D anclado al mundo, con dedos (bloque 4 de [`../../docs/plan-v2.md`](../../docs/plan-v2.md)). Reemplaza a MediaPipe + `lift.py` donde hoy falla: el temblor, el avance de frente (≈ 0 m/s) y la falta de dedos.

| Pieza | Para qué | Estado |
| --- | --- | --- |
| [GVHMR](https://github.com/zju3dv/GVHMR) | Cuerpo SMPL-X en el mundo, con gravedad y cámara que se mueve | Corre en la Mac (`gvhmr_mac.py`) |
| [WiLoR](https://github.com/rolpotamias/WiLoR) | Manos con dedos (MANO), 15 articulaciones por mano | Corre en la Mac (`wilor_mac.py`): dedos bien en `dedos-01`, `saludar-02`, `dedos-02`, `lavar-04` |
| Fusión → `PoseClip` v2 | Cuerpo + manos en SMPL-X, con contactos (`docs/contrato.md`) | Hecho (`to_poseclip.py`): une GVHMR + WiLoR, filtra manos por muñeca, guarda SMPL-X y los 21 puntos por mano |

## Licencias

SMPL-X, SMPL, MANO y GVHMR son **no comerciales**. Juan decidió usarlos así (2026-11-04): Tridi v2 es un campo de pruebas. Antes de vender: licencia comercial (Meshcapade) o un modelo de cuerpo abierto ([`../../docs/plan-v2.md`](../../docs/plan-v2.md), sección 10). GVHMR además pide que **las modificaciones de su código se publiquen**: por eso `gvhmr_mac.py` no toca su código, lo importa y lo adapta desde afuera.

## Instalación (una vez)

GVHMR vive en `data/thirdparty/GVHMR` (gitignored), con su propio entorno (fija torch 2.3 y necesita pytorch3d):

```bash
git clone https://github.com/zju3dv/GVHMR data/thirdparty/GVHMR
cd data/thirdparty/GVHMR && uv venv -p 3.10 .venv && . .venv/bin/activate
uv pip install torch==2.3.1 torchvision==0.18.1 timm==0.9.12 lightning==2.3.0 pytorch-lightning==2.3.0 hydra-core==1.3.2 hydra-zen hydra_colorlog rich numpy==1.23.5 matplotlib "setuptools>=68" tensorboardX opencv-python ffmpeg-python scikit-image termcolor einops imageio==2.34.1 av==13.0.0 joblib trimesh smplx pycolmap ultralytics==8.2.42 lapx yacs wis3d "setuptools<70" scipy==1.13.1
CFLAGS=-Wno-invalid-specialization CXXFLAGS=-Wno-invalid-specialization uv pip install --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git@V0.7.8"
```

Lo que no dice su `requirements.txt` y hizo falta en esta Mac (macOS 27, M2):
- `CFLAGS` de pytorch3d: el compilador de Xcode nuevo rechaza un encabezado de torch 2.3 (`is_arithmetic cannot be specialized`).
- `scipy==1.13.1`: la 1.15 no carga en este macOS (`__thread_bss has a zero-fill section type`).
- `setuptools<70` (lightning usa `pkg_resources`), `yacs` y `wis3d` (los importa sin declararlos).

Comprobado (2026-11-04): corre de punta a punta en la Mac. El modelo final de GVHMR va en la CPU: en MPS (torch 2.3) aborta en un recorte de tensor.

**A mano (Juan, en el navegador):** Google Drive no deja bajar los pesos grandes por script, y los modelos de cuerpo piden cuenta. No se usan espejos de terceros: un `.ckpt` o `.pth` puede ejecutar código al cargarse.

1. Del [Drive oficial de GVHMR](https://drive.google.com/drive/folders/1eebJ13FUEXrKBawHpJroW0sNSxLjh9xD), a `data/thirdparty/GVHMR/inputs/checkpoints/`:
   - `gvhmr/gvhmr_siga24_release.ckpt`
   - `hmr2/epoch=10-step=25000.ckpt`
   - `vitpose/vitpose-h-multi-coco.pth`
   - `yolo/yolov8x.pt`
2. Con cuenta en [smpl-x.is.tue.mpg.de](https://smpl-x.is.tue.mpg.de/): `SMPLX_NEUTRAL.npz` (y `MALE`, `FEMALE`) a `inputs/checkpoints/body_models/smplx/`.
3. Con cuenta en [smpl.is.tue.mpg.de](https://smpl.is.tue.mpg.de/): `SMPL_NEUTRAL.pkl` (y `MALE`, `FEMALE`) a `inputs/checkpoints/body_models/smpl/`.
4. Para las manos: cuenta en [mano.is.tue.mpg.de](https://mano.is.tue.mpg.de/), bajar "Models & Code" (`mano_v1_2.zip`) y copiar `mano_v1_2/models/MANO_RIGHT.pkl` a `data/thirdparty/WiLoR/mano_data/`.

## Manos: WiLoR (2026-11-05)

Por qué WiLoR y no HaMeR: trae su propio detector de manos (HaMeR necesita ViTPose y un detector aparte) y sus pesos se bajan por script desde el [espacio oficial en Hugging Face](https://huggingface.co/spaces/rolpotamias/WiLoR) (los de HaMeR van por un script a otro servidor). Licencia de los pesos: CC BY-NC-ND (no comercial, sin derivados), más la de MANO: entra en la decisión de Juan del 2026-11-04.

```bash
git clone --recursive https://github.com/rolpotamias/WiLoR data/thirdparty/WiLoR
cd data/thirdparty/WiLoR && uv venv -p 3.10 .venv && . .venv/bin/activate
uv pip install torch==2.3.1 torchvision==0.18.1 "numpy<2" opencv-python scikit-image pytorch-lightning==2.3.0 smplx==0.1.28 yacs timm einops hydra-core pyrootutils rich ultralytics==8.1.34 "setuptools<70" scipy==1.13.1 dill pyrender pip wheel picklescan
uv pip install --no-build-isolation "chumpy @ git+https://github.com/mattloper/chumpy"
mkdir -p pretrained_models && cd pretrained_models
curl -LO https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models/detector.pt
curl -LO https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models/wilor_final.ckpt
```

Revisados con `picklescan`: `wilor_final.ckpt` limpio. `detector.pt` marca `getattr`: revisado a mano, solo hace `getattr(Detect, "forward")` (clase de Ultralytics) y `dill` reconstruye el tipo `set`; el resto son módulos de torch y Ultralytics. Seguro.

```bash
data/thirdparty/WiLoR/.venv/bin/python data/capture2/wilor_mac.py <video>.mp4
```

`MANO_RIGHT.pkl` (de `mano_v1_2.zip`, la cuenta de Juan) revisado a mano como el de SMPL: solo numpy, scipy, chumpy y `set`. WiLoR importa pyrender (solo para dibujar) pidiendo EGL de Linux y su modelo arma renderers de entrenamiento: `wilor_mac.py` deja pasar el import con `PYOPENGL_PLATFORM=darwin` y apaga esos renderers, sin tocar su código. El detector va en la GPU y el modelo de WiLoR en la CPU (en MPS aborta, como el de GVHMR): ~0,6 s por cuadro. `--max-frames 30` para una prueba rápida.

Sale `<video>.wilor.npz`: por mano (izquierda, derecha) y cuadro, los parámetros MANO, los 21 puntos 3D en la cámara y la confianza (0 si no vio esa mano). `to_poseclip.py` lo encuentra solo (al lado del `.gvhmr.npz` o en `hands/`) y lo fusiona con el cuerpo de GVHMR en `PoseClip` v2: descarta una mano si su muñeca en cámara queda a más de 0,30 del lado largo de la imagen respecto a la muñeca de GVHMR, pone la orientación de la muñeca (`R_elbow⁻¹ · R_wrist_wilor`) y los 15 ángulos de dedos (`flat_hand_mean=True`) en SMPL-X, y saca los 21 puntos 3D por mano y los contactos de los pies en el espacio del contrato.

## Primer resultado (2026-11-04)

`bailar-01` (10,5 s, de frente, cuerpo entero), con `data.quality` sobre los mismos 33 puntos (`to_joints.py` pasa SMPL-X a los índices de MediaPipe):

| Captura | temblor (m/s²) | pie apoyado que patina (m/s) | pie bajo el piso (cm) | huesos que se estiran | altura (m) |
| --- | --- | --- | --- | --- | --- |
| MediaPipe (hoy) | 11,4 | 0,29 | 0,2 | 9,6 % | 1,56 |
| GVHMR | 11,6 | **0,04** | 0,9 | **0,0 %** | **1,64** |

`jacks-01` (11 s, saltos de tijera, de frente):

| Captura | temblor | patina | bajo el piso | huesos | altura |
| --- | --- | --- | --- | --- | --- |
| MediaPipe (hoy) | 13,4 | 0,28 | 0,3 | 5,7 % | 1,54 |
| GVHMR | 17,4 | 0,31 | 1,1 | **0,0 %** | 1,74 |

Esas dos tablas comparan GVHMR **crudo** contra MediaPipe **suavizado** (`data/smooth.py`). Con el mismo suavizado (`to_poseclip.py`, 2026-11-05), GVHMR gana también en temblor:

| Clip | Captura | temblor | patina | bajo el piso | huesos | altura |
| --- | --- | --- | --- | --- | --- | --- |
| bailar-01 | MediaPipe | 11,4 | 0,29 | 0,2 | 9,6 % | 1,56 |
| bailar-01 | GVHMR | **7,1** | **0,05** | 1,1 | **0,3 %** | 1,63 |
| jacks-01 | MediaPipe | 13,4 | 0,28 | 0,3 | 5,7 % | 1,54 |
| jacks-01 | GVHMR | **11,7** | 0,25 | 1,2 | **0,3 %** | 1,70 |

Todo el set (2026-11-05, mismo suavizado; temblor en m/s², patina en m/s):

| Clip | temblor MP → GVHMR | patina MP → GVHMR | huesos MP → GVHMR | nota |
| --- | --- | --- | --- | --- |
| caminar de perfil (el de la web) | 43,2 → **23,5** | 0,87 → **0,40** | 6,4 % → **0,3 %** | avanza a 1,06 m/s (MediaPipe 0,76) |
| correr de perfil | 93,9 → **31,5** | 3,18 → **0,32** | 12,8 % → **0,6 %** | |
| caminar alejándose (`caminar-01`) | 11,5 → **4,3** | 0,35 → **0,06** | 4,6 % → **0 %** | se aleja 5,5 m (MediaPipe 2,3 m) |
| bailar-02 (cámara en mano) | 26,2 → **6,2** | 0,66 → **0,05** | 13,1 % → **0,6 %** | |
| baile en grupo | 39,9 → **11,4** | 0,89 → **0,21** | 14,5 % → **0,2 %** | |
| sentarse-02 | 15,1 → **8,0** | 0,23 → **0,03** | 16,1 % → **0,1 %** | |
| saltos y sentadillas (`caminar-02`) | 44,5 → **33,2** | 0,86 → **0,23** | 11,1 % → **0,8 %** | |
| saltos en grupo | 10,9 → **6,4** | 0,34 → 0,44 | 6,4 % → **0,1 %** | |
| correr-01, escalera-02 | MediaPipe vio el cuerpo en 8 % y 22 % de los cuadros | | | GVHMR da los dos enteros |

**De frente** (2026-11-05, videos de Pexels bajados para esto, `frente-*` en el manifiesto): MediaPipe casi no avanza y GVHMR sí. `frente-04` (camina 18 s hacia la cámara): MediaPipe 0,3 m, GVHMR 8,1 m. `frente-correr-01` (corre 10 s): MediaPipe 3,0 m, GVHMR 11,9 m. Ojo: caminando GVHMR da 0,27-0,45 m/s, bajo para una caminata normal (~1,2 m/s): probablemente parte del avance se lo atribuye a la cámara, que en estos videos suele retroceder con la persona. Falta medirlo con un video de cámara fija y distancia conocida.

En los videos de medio cuerpo (`dedos-01`, `saludar-02`, `lavar-*`) GVHMR inventa piernas quietas: su temblor casi cero no es mérito. La altura de GVHMR sale 1,6-1,97 m (MediaPipe 1,4-1,5); algunas parecen altas, falta revisarlo. 4 videos (`caminar-01`, `correr-01`, `escalera-02`, `bailar-grupo-02`) necesitaron `--static`: la odometría SimpleVO no encuentra rasgos en el fondo (mar, cortes de edición) y se cae; `run_set.sh` ya reintenta así.

Lo único que empeora es el pie bajo el piso (~1 cm): lo arregla el refinamiento físico del plan (pies que no patinan ni atraviesan el piso).

**Tiempo:** `jacks-01` de cero, 5,5 min para 11 s de video (~30× el tiempo real): seguir a la persona 42 s, ViTPose 2,6 min, el resto el extractor de rasgos y la odometría. Cabe de sobra en el presupuesto de la Mac (24 h por video).

En el baile, el pie apoyado patina 7 veces menos y los huesos ya no se estiran (es un esqueleto de verdad, SMPL-X). La altura sube a 1,64 m: MediaPipe da 10-20 % de menos. El temblor queda igual y el pie se hunde un poco más (menos de 1 cm). Falta medirlo en todo el set de prueba y de frente caminando hacia la cámara.

## Uso

```bash
data/thirdparty/GVHMR/.venv/bin/python data/capture2/gvhmr_mac.py data/samples/<video>.mp4 --f-mm 24
data/thirdparty/GVHMR/.venv/bin/python data/capture2/to_poseclip.py data/samples/<video>.gvhmr.npz
```

`--static` si la cámara no se mueve (más rápido: no corre la odometría visual). `gvhmr_mac.py` deja `<video>.gvhmr.npz`: parámetros SMPL-X por cuadro en el mundo y en la cámara. `to_poseclip.py` lo pasa a un `PoseClip` v1 (`clips/clip_<video>-gvhmr.json` y `.npz`): los 33 puntos de MediaPipe, girado para que z mire a la cámara (el mundo de GVHMR tiene la gravedad bien pero un giro cualquiera; en nuestros clips la persona miraba a −z) y suavizado como `data/lift.py`. Así lo usan la web, el retargeting y `data.quality` sin cambiar el contrato. Todo el set de prueba, de una (se puede cortar y retomar):

```bash
nohup sh data/capture2/run_set.sh > data/capture2/out/run_set.out 2>&1 &
```

## Probarlo en la web

En la rama `juan/experimental`, `npm --prefix web run dev` y abrir `#/simulaciones`: la galería tiene cada video dos veces, "MediaPipe (hoy)" y "captura 2.0 (GVHMR)", con el robot imitando cada uno (`web/clips/`, `web/src/preloaded.json`). La demo publicada no cambia.
