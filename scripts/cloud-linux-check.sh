#!/usr/bin/env bash
# Kiểm biên dịch và test của bản Rust trên Linux (phiên cloud, CI không có Windows), TASKS_RUST "Việc làm được trên cloud".
#
# Chạy được: cargo fmt, clippy, test cho chef-app, chef-ui, chef-contracts, chef-viewer, chef-rpc (bản thay thế),
# chef-testkit. Không chạy được: cửa sổ GPUI, lõi qua JSON-RPC (chef-rpc chỉ có bản thật trên Windows),
# test cần pdfium (chef-pdf tests/), mọi script `e2e-native-*.ps1`.
#
# Vì sao cần vá: `xattr` 0.2.3 (bắc cầu từ `http_client` của GPUI) dùng `libc::ENOATTR`, hằng số này không còn
# trên Linux ở các bản `libc` mới. Script chép `xattr` ra thư mục tạm, đổi sang `ENODATA` (cùng giá trị trên
# Linux) và vá bằng `.cargo/config.toml` tạm, không sửa Cargo.toml. Cargo.lock và `.cargo/` được trả về
# nguyên trạng khi script kết thúc. (`--config` không đủ: `cargo clippy` gọi lại cargo và mất cấu hình.)
#
# Dùng: scripts/cloud-linux-check.sh [fmt|clippy|test|all]   (mặc định: all)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/apps/native"
work="${CHEF_CLOUD_DIR:-${TMPDIR:-/tmp}/chef-cloud}"
mode="${1:-all}"

xattr_src="$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -maxdepth 2 -type d -name 'xattr-0.2.3' | head -n 1 || true)"
if [ -z "$xattr_src" ]; then
  # Chưa tải: để cargo tải thử rồi tìm lại (lỗi biên dịch xattr ở bước này là bình thường).
  (cd "$native" && cargo fetch --locked >/dev/null 2>&1 || true)
  xattr_src="$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -maxdepth 2 -type d -name 'xattr-0.2.3' | head -n 1)"
fi
rm -rf "$work/xattr"
mkdir -p "$work"
cp -r "$xattr_src" "$work/xattr"
sed -i 's/::libc::ENOATTR/::libc::ENODATA/' "$work/xattr/src/sys/mod.rs"

cp "$native/Cargo.lock" "$work/Cargo.lock.orig"
if [ -e "$native/.cargo/config.toml" ]; then
  echo "Đã có $native/.cargo/config.toml; dừng để không ghi đè." >&2
  exit 2
fi
restore() {
  cp "$work/Cargo.lock.orig" "$native/Cargo.lock"
  rm -rf "$native/.cargo"
}
trap restore EXIT
mkdir -p "$native/.cargo"
printf '[patch.crates-io]\nxattr = { path = "%s" }\n' "$work/xattr" >"$native/.cargo/config.toml"

cargo_with_patch() {
  (cd "$native" && cargo "$@")
}

case "$mode" in
  fmt | all) (cd "$native" && cargo fmt --all -- --check) ;;
esac
case "$mode" in
  clippy | all)
    # Cảnh báo dead_code của bản thay thế ngoài Windows (debug_stub, instance...) có từ trước; chỉ chặn lỗi.
    cargo_with_patch clippy --workspace --all-targets
    ;;
esac
case "$mode" in
  test | all)
    # Các test cần pdfium (chef-pdf/tests) thất bại ngoài Windows vì thiếu thư viện; bỏ qua chúng.
    cargo_with_patch test --workspace --exclude chef-pdf
    cargo_with_patch test -p chef-pdf --lib
    ;;
esac
