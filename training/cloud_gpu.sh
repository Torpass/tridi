#!/usr/bin/env bash
# ============================================================================
# Tridi Cloud GPU Training Launcher (docs/ROADMAP.md, Task J-2)
# Usage on a Cloud GPU VM (RunPod / Lambda / Modal / Ubuntu + CUDA):
#   ./training/cloud_gpu.sh [run_name] [clips_spec] [total_steps]
# Example:
#   ./training/cloud_gpu.sh walk-multiclip-v1 all-walks 50000000
# ============================================================================
set -euo pipefail

RUN_NAME="${1:-walk-multiclip-v1}"
CLIPS_SPEC="${2:-all-walks}"
STEPS="${3:-50000000}"

cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "[cloud_gpu] Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "[cloud_gpu] Syncing Python environment in training/..."
uv sync --project training

echo "[cloud_gpu] Running pre-flight Multi-Clip + Edge-Case verification..."
uv run --project training python -m training.multiclip --clips "$CLIPS_SPEC" --verify

echo "[cloud_gpu] Starting Cloud GPU PPO run: $RUN_NAME ($CLIPS_SPEC, $STEPS steps)..."
uv run --project training python -m training.multiclip \
  --run "$RUN_NAME" \
  --clips "$CLIPS_SPEC" \
  --steps "$STEPS" \
  --cloud \
  --resume
