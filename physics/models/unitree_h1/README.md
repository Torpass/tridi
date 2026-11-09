# Unitree H1

Modelo MJCF del Unitree H1 (19 articulaciones, sin manos) de [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie/tree/main/unitree_h1), commit `98a70c5` (3 de noviembre de 2026), sin cambios. Licencia BSD-3-Clause de Unitree Robotics, en [`LICENSE`](LICENSE); el README original está en [`MENAGERIE.md`](MENAGERIE.md).

Es el segundo humanoide de Tridi (plan v2, pilar D): otro tamaño que el G1, para que nada dependa de un robot. Trae motores de torque; `training/robot.py` los convierte en servos PD con las ganancias de [`robots/h1.json`](../../../robots/h1.json).
