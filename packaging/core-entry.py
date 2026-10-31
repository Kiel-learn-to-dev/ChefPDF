"""PyInstaller entry point for the Chef PDF core sidecar.

Equivalent to ``python -m chef_core`` (core/chef_core/__main__.py). Kept outside ``core/`` so the
packaging setup does not touch the core package.
"""

import multiprocessing
import runpy

if __name__ == "__main__":
    # Required for multiprocessing (job process pool) in a frozen app on Windows/macOS.
    multiprocessing.freeze_support()
    runpy.run_module("chef_core", run_name="__main__", alter_sys=True)
