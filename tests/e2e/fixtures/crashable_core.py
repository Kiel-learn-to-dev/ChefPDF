"""Run the real core and simulate an abrupt sidecar failure when the test creates a marker."""

import os
import threading
import time
from pathlib import Path

from chef_core.__main__ import main


def crash_on_marker() -> None:
    marker = Path(os.environ["CHEF_TEST_CRASH_MARKER"])
    while True:
        if marker.exists():
            marker.unlink()
            os._exit(42)
        time.sleep(0.05)


threading.Thread(target=crash_on_marker, daemon=True).start()
raise SystemExit(main())
