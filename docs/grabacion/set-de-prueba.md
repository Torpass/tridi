# Set de prueba: videos de cualquier lado

**Cambio del 2026-11-03 (Juan):** Tridi tiene que funcionar con el video que la gente ya tiene: una persona bailando en TikTok, un grupo haciendo una coreografía, alguien lavando platos en YouTube, la cámara de la Mac o el teléfono en la mano. Nada de trípode, 60 fps ni foco bloqueado. Por eso el set de prueba ya no es una sesión de grabación de Juan: es una **lista de videos reales por habilidad**, y la tecnología se mide sobre ellos.

Juan puede sumar grabaciones propias cuando quiera (sección 4), pero no hace falta grabar nada para empezar.

---

## 1. Cómo funciona

| Qué | Dónde |
| --- | --- |
| La lista de videos (id, habilidad, fuente, link, licencia, estado) | [`data/set-de-prueba/manifest.csv`](../../data/set-de-prueba/manifest.csv), versionada |
| Los videos y sus `PoseClip` | `data/set-de-prueba/` en la Mac (gitignored). **Nunca** en git ni en la nube |
| Las notas de calidad de cada versión de la captura | [`data/set-de-prueba/quality.csv`](../../data/set-de-prueba/quality.csv), versionada |

```bash
uv run --project data python -m data.testset list                      # qué hay y qué está bajado (✓)
uv run --project data python -m data.testset add "<link>" --id bailar-03 --categoria bailar
uv run --project data python -m data.testset download                  # baja lo que falta
uv run --project data python -m data.testset extract                   # PoseClip de cada video
uv run --project data python -m data.testset quality --save <versión>  # nota de calidad, a quality.csv
```

`add` acepta un link de TikTok, YouTube, Instagram, Pexels o Mixkit, o un archivo de la Mac (un video grabado con el teléfono o la cámara de la Mac).

## 2. La nota de calidad (sin verdad de terreno)

Como no hay captura de movimiento profesional para comparar, se mide lo que un cuerpo humano real no puede hacer ([`data/quality.py`](../../data/quality.py)):

| Medida | Qué es | Bien |
| --- | --- | --- |
| `valid` | Cuadros donde la persona se detectó de verdad | → 100 % |
| `jitter` | Aceleración p95 de rodillas y tobillos (m/s²): temblor cuadro a cuadro | Bajo |
| `slide` | Velocidad del pie apoyado (m/s): un pie apoyado no se mueve | → 0 |
| `sink` | Cuánto se hunde el pie bajo el piso (cm) | → 0 |
| `bones` | Cuánto cambia el largo de muslo, pierna, brazo y antebrazo (%): los huesos no se estiran | → 0 % |
| `height` | Altura estimada (m) | La de la persona |

**Línea de partida** (captura del hackathon, MediaPipe, 2026-11-03):

| Clip | valid | jitter | slide | sink | bones | altura |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Caminar de perfil | 100 % | 43,2 | 0,87 m/s | 0,3 cm | 6,4 % | 1,52 m |
| Correr de perfil | 97 % | 93,9 | 3,18 m/s | 1,2 cm | 12,8 % | 1,56 m |
| Jumping jacks | 100 % | 18,1 | 0,57 m/s | 0,3 cm | 6,8 % | 1,55 m |

**Sobre el set de internet** (MediaPipe de hoy, 2026-11-03; 19 videos de Pexels bajados, 14 dieron clip):

| Clip | Qué es | valid | jitter | slide | sink | bones | altura |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| bailar-01 | 1 persona, cuerpo entero, vertical | 100 % | 11,4 | 0,29 | 0,2 | 9,6 % | 1,56 |
| bailar-02 | 2 personas, cámara en mano, cortes | 95 % | 26,2 | 0,66 | 1,7 | 13,1 % | 1,55 |
| bailar-grupo-02 | 3 personas, cámara alta | 99 % | 39,9 | 0,89 | 1,3 | 14,5 % | 1,38 |
| caminar-01 | de espaldas, lejos | 100 % | 11,5 | 0,35 | 0,2 | 4,6 % | 1,47 |
| caminar-02 (saltar) | saltos, cuerpo entero | 100 % | 44,5 | 0,86 | 3,1 | 11,1 % | 1,57 |
| correr-01 | piernas fuera de cuadro | 8 % | 37,8 | 0,24 | 3,6 | 11,3 % | 1,35 |
| dedos-01 | cintura para arriba | 100 % | 47,8 | 0,40 | 0,2 | 3,1 % | 1,45 |
| escalera-02 | solo piernas, cortes | 22 % | 27,0 | 0,02 | 0,8 | 21,0 % | 1,38 |
| jacks-01 | 1 persona, vertical | 100 % | 13,4 | 0,28 | 0,3 | 5,7 % | 1,54 |
| jacks-grupo-01 | 2 personas | 100 % | 10,9 | 0,34 | 0,4 | 6,4 % | 1,53 |
| lavar-04 | de perfil, cintura para arriba, espejo | 30 % | 4,3 | 0,01 | 0,0 | 1,5 % | 1,45 |
| saludar-02 | cintura para arriba | 90 % | 9,3 | 0,23 | 0,0 | 3,2 % | 1,38 |
| sentarse-01 | cortes de edición | 100 % | 7,8 | 0,14 | 0,3 | 7,5 % | 1,38 |
| sentarse-02 | se sienta, la cámara se acerca | 96 % | 15,1 | 0,23 | 0,6 | 16,1 % | 1,42 |

**Lo que dice:**

- **Sin cuerpo entero, la captura de hoy no da nada.** lavar-02, lavar-05 (manos y antebrazos de cerca), correr-02 (sin piernas) y dedos-02 (una mano sola) fallaron: "que se vea el cuerpo entero". Y lavar-04, de la cintura para arriba, solo 30 % válido. Justo los videos de la habilidad estrella (lavar platos) y de los dedos. Por eso la captura 2.0 necesita un modo de medio cuerpo y un modelo de manos aparte (HaMeR), no solo más puntos.
- Con varias personas elige una sola y sigue bien (jacks-grupo-01, bailar-grupo-02); elegir a todas falta.
- Cámara alta, cortes y acercamientos estiran los huesos (14-21 %): un cuerpo con medidas fijas (SMPL-X) lo corrige por construcción.
- La altura sale 1,35-1,57 m en todos: MediaPipe achica a la gente.

El pie apoyado que "patina" casi 1 m/s caminando y los huesos que se estiran 6-13 % son exactamente lo que después hace que la referencia del robot no esté en equilibrio (los controles C1 y C2 de [`training/checks.py`](../../training/checks.py)).

## 3. Qué videos buscar

### De dónde

| Fuente | Licencia | Para qué |
| --- | --- | --- |
| **Pexels** (pexels.com/videos), Mixkit, Pixabay | Uso libre, también comercial, sin atribución; no vender el video tal cual | Pruebas **y** datos del producto. **Empezar por acá** |
| TikTok, YouTube, Instagram | El video es de quien lo publicó | Pruebas en esta Mac. No como datos que se venden: para eso hace falta permiso o licencia ([`yc/verdad-hoy.md`](../../yc/verdad-hoy.md), "Datos con licencia") |
| Grabaciones propias | Nuestras | Todo, y la verdad de terreno (sección 4) |

### Qué habilidades, y cuántos

Unos 5 por habilidad, a propósito variados: no los videos "perfectos", sino los que la gente de verdad sube.

| Habilidad | Buscar (en inglés rinde más) | Lo que se quiere cubrir |
| --- | --- | --- |
| Lavar platos ⭐ | "washing dishes", "doing dishes kitchen sink" | De costado y de frente, una persona, manos visibles |
| Bailar | "dancing", "hip hop dance", "tiktok dance" | Una persona, cuerpo entero, giros |
| Bailar en grupo | "group dancing", "dance choreography" | **Varias personas**: elegir a una, o a todas |
| Caminar | "man walking full body", "walking side view" | De perfil, de frente, cámara que sigue a la persona |
| Correr | "jogging side view", "running" | Pies en el aire |
| Jumping jacks | "jumping jacks" | Una persona y un grupo |
| Sentarse | "sitting down on chair" | Contacto con un mueble |
| Escaleras | "walking up stairs" | Pies a otra altura |
| Manos | "waving hand", "counting fingers", "sign language" | Dedos: para las manos de 5 dedos |
| Objetos | "lifting box", "carrying boxes" | Cuerpo entero + objeto |

Hay 25 candidatos de Pexels en el manifiesto, revisados el 2026-11-03: 10 `ok`, 8 `difícil` (casos que hoy fallan y la captura 2.0 tiene que resolver), 1 `descartado` y 6 `sin-bajar`. Esos 6 Pexels los bloqueó con 403 (protección anti-bot) al bajarlos en ráfaga; se bajan a mano con su botón "Free download" y se suman con `add <archivo> --id <el mismo id>`. Faltan buenos de **caminar de perfil** y **correr con piernas** (cuerpo entero).

### Lo difícil también entra

El set tiene que tener los casos que hoy fallan, porque son los que la captura 2.0 tiene que resolver: cámara en la mano que se mueve, gente de frente caminando hacia la cámara, video vertical, poca luz, ropa holgada, una persona tapando a otra, cortes de edición (TikTok). Se marcan en `notas`.

## 4. Si Juan quiere grabar algo (opcional)

Sin reglas de estudio: el teléfono en la mano o apoyado, la cámara de la Mac, como salga. Solo dos grabaciones valen el esfuerzo, porque dan algo que los videos de internet no tienen, **la verdad de terreno**:

1. **Distancia conocida:** dos marcas de cinta en el piso a 3,00 m medidos; caminar de una a la otra, ida y vuelta, de perfil y después de frente. La captura debería decir 3 m.
2. **Tu cuerpo medido:** anota tu altura y tu envergadura (brazos en cruz, punta a punta). Después grábate de cualquier forma haciendo cualquier cosa: la altura estimada se compara con la real.

Se suman con `add ~/ruta/al/video.mov --id propio-distancia-01 --categoria caminar`.
