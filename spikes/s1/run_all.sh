#!/usr/bin/env bash
# Spike S1 (T1.08): PKCS#11 signing with pyHanko on SoftHSM2.
# Usage: cd spikes && uv sync && bash s1/run_all.sh
# Needs: softhsm2 (apt-get install -y softhsm2 opensc | brew install softhsm opensc)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v softhsm2-util >/dev/null; then
  echo "softhsm2-util not found. Install: sudo apt-get install -y softhsm2 opensc" >&2
  exit 1
fi

export SOFTHSM2_CONF="$PWD/s1/out/softhsm/softhsm2.conf"
run() { echo; echo "### $*"; uv run python -m "$@"; }

run s1.pki            # test PKI imitating a Vietnamese CA chain
run s1.hsm_setup      # SoftHSM token + import key/cert chain
run s1.sign_tests     # scenarios a-h, timings -> s1/out/results.json
run s1.validate       # pyHanko validation -> s1/out/validation.json
run s1.pin_flags      # slot/token/cert listing, PIN flags -> s1/out/pin_flags.json

echo
echo "### token probe self-test against SoftHSM (no PIN, listing only)"
uv run python s1_token_probe.py --lib "$(uv run python -c 'from s1.common import softhsm_lib; print(softhsm_lib())')" \
  --out s1/out/token_probe_softhsm.json
