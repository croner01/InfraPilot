"""测试前置：隔离数据目录，避免污染开发数据。"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_data_dir = tempfile.mkdtemp(prefix="infrapilot-test-")
os.environ["INFRAPILOT_DATA_DIR"] = _data_dir

from infrapilot import db  # noqa: E402

db.init_db()
