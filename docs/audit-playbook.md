# Tridi Web & Physics Audit Playbook (`docs/audit-playbook.md`)

Modeled on Juan's quality system from `~/Code/portfolio/website/docs/audit-playbook.md`.
Use this playbook whenever touching `web/` or `physics/` so UI, UX, 3D camera, and simulation regressions are caught automatically before shipping.

---

## Commands & Skills

| Command / Skill | Scope | Fixes issues? |
|---|---|---|
| `/tridi-craft-audit` | Pixel-level layout, alignment, CLS, typography, token contrast, 3D canvas framing, and zoom-out balance (`100%`, `80%`, `67%`, `50%`). | Yes |
| `/tridi-ux-audit` | User journeys, robot-specific UI filtering (`unitree_g1` vs `luigi_lab3`), camera target resets, orbit cursors, media orientation/duration, and ES/EN parity. | Yes |
| `/tridi-release-audit` | Final ship gate: `npm --prefix physics run check`, `npm --prefix web run check`, `npm --prefix web run build`, and zero console/runtime errors across all routes. | Report + fix |

---

## Standing Quality Rules (Non-Negotiable)

1. **Zero Content Layout Shift (CLS) on Live Telemetry & Controls:**
   - Any element displaying live 50 Hz telemetry (`#sim-hcsr04`, `#sim-apds`, `#sim-wheels`, `#sim-dodge-state`, `.hud .state`, `.sim-readout`) or cycling state (`#speed`: `1×`, `0.5×`, `0.25×`) **must** have fixed dimensions (`min-width` / `height`), `font-variant-numeric: tabular-nums`, and `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` so text changes never shift neighboring buttons or cards.
2. **Dark-Surface Contrast & Token Discipline:**
   - Tridi's UI is dark-first (`#08090b` / `#101214`). Never use dark-on-dark badges (e.g. `#166534` forest green or `#9a3412` brown on `#08090b`).
   - Primary signal accents use `--signal` (`#c8ff2e`) with translucent tint backgrounds (`rgb(200 255 46 / 0.12)`); warnings/trainable badges use high-contrast amber (`#fbbf24`); active dodge/alerts use `#ff6a3d`.
3. **Balanced Multi-Column Geometry Across Zoom Levels (`100%` to `50%`):**
   - In `#/simulations`, `.controls` (`Playback` and `Conditions`) must stretch to equal height (`align-items: stretch`).
   - `.sims-list` (the right sidebar) must lock its height to `.sims-main` (`height: 0; min-height: 100%; max-height: 100%`) so zooming out never leaves one column short, one medium, and one hanging far below.
4. **Robot-Aware Contextual UI (`unitree_g1` vs `luigi_lab3`):**
   - Controls that only apply to humanoids (`#grasp-box` objects/liquids, `#place-field`, `#policy-field`, human pose gallery `#gallery`, and `#show` split-pane selector) must hide when `luigi_lab3` is active.
   - Controls for `luigi_lab3` (`#luigi-sim-panel`, `#arduino-box` drive pad) live cleanly inside the right sidebar panel, never injected into the middle of humanoid condition fields.
   - Leaving `#/simulations` must always restore `unitree_g1` with `FINAL_LEVEL` (`g1-stand`) so the Landing page (`#/`) never inherits a wheeled robot.
5. **3D Camera Reset & Cursor Affordance:**
   - Every interactive 3D canvas (`.pane canvas`, `.film canvas`) must show `cursor: grab` and `:active { cursor: grabbing }`.
   - Switching robots or clicking reset must update `viewer.controls.target` to the robot's current pelvis `(px, targetHeight, -py)` **before** setting `viewer.camera.position` to `target + defaultOffset`. Setting `camera.position` without resetting `controls.target` corrupts the orbit vector in `viewer.follow()`.
6. **Physical Uprightness in MuJoCo (`physics/`):**
   - Humanoid walking policies (`g1-walk`, `g1-frente`) must maintain upright torso posture (`torsoTilt < 12°`). Avoid feeding out-of-distribution `waist_pitch_joint` residuals into `data.ctrl[14]` and keep sufficient pelvis rotational stiffness (`kpRot >= 400`).
7. **Media Integrity (`#/milestones`):**
   - Phone-recorded vertical videos (`rotation: -180` or `±90` in QuickTime metadata) must be inspected with `ffprobe` + extracted PNG frames before encoding, transposed upright, kept at their full meaningful duration (never truncated to arbitrary 13s snippets), and displayed inside compact (`<= 360px` tall) containers with `object-fit: contain`.
   - Long case-study screens (`#/milestones`) must use segmented tabs (`role="tablist"`) so users switch cleanly between milestones without getting lost in an endless vertical scroll.
8. **Bilingual Parity (`ES` + `EN`) & CSS Scoping:**
   - Every visible string must have both `<span class="t" lang="es">` and `<span class="t" lang="en">`.
   - Never use unscoped generic class names (like `.milestones`) in global CSS if both `landing.css` and `style.css` are loaded in the bundle.
