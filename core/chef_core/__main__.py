"""Entry point: ``python -m chef_core --data-dir <dir>``.

stdout carries JSON-RPC only. Before anything else the real stdout file descriptor is
duplicated for the RPC stream and fd 1 is pointed at stderr, so stray prints (from Python
or native libraries) can never corrupt the protocol.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import BinaryIO


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="chef-core", description="Chef PDF core sidecar")
    parser.add_argument("--data-dir", required=True, type=Path, help="app data directory")
    parser.add_argument(
        "--log-level",
        default=os.environ.get("CHEF_CORE_LOG_LEVEL", "INFO"),
        help="logging level (default INFO, env CHEF_CORE_LOG_LEVEL)",
    )
    return parser.parse_args(argv)


def _claim_stdout() -> BinaryIO:
    """Return a private binary stream on the original stdout; redirect fd 1 to stderr."""
    sys.stdout.flush()
    rpc_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return os.fdopen(rpc_fd, "wb", buffering=0)


def _claim_stdin() -> BinaryIO:
    """Return a private binary stream on the RPC input; point fd 0 at the null device.

    Worker processes started by the core (the rasterize pool in ops/scan.py) inherit the standard
    input. While the RPC reader holds that pipe, a worker never finished starting and the job hung
    (reproduced with a 40-page merge: the same file with 7 pages, which starts no workers, passed).
    The workers get the null device instead, and the Win32 standard input handle follows fd 0.
    """
    rpc_fd = os.dup(sys.stdin.fileno())
    null_fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_fd, 0)
    os.close(null_fd)
    if sys.platform == "win32":
        import ctypes
        import msvcrt

        std_input_handle = -10
        ctypes.windll.kernel32.SetStdHandle(std_input_handle, msvcrt.get_osfhandle(0))
    return os.fdopen(rpc_fd, "rb")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        stream=sys.stderr,
        level=str(args.log_level).upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    out = _claim_stdout()
    inp = _claim_stdin()
    data_dir: Path = args.data_dir.expanduser().absolute()
    data_dir.mkdir(parents=True, exist_ok=True)

    from chef_core.app import CoreApp  # imported late: keep startup errors on stderr

    app = CoreApp(data_dir, inp, out)
    return app.run()


if __name__ == "__main__":
    code = main()
    logging.shutdown()
    sys.stderr.flush()
    # Do not wait for worker threads stuck in native code; jobs were already given time.
    os._exit(code)
