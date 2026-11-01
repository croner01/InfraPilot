"""`python -m infrapilot` 启动入口。"""

from __future__ import annotations

import uvicorn

from . import settings


def main() -> None:
    uvicorn.run("infrapilot.main:app", host="0.0.0.0", port=settings.port(), log_level="info")


if __name__ == "__main__":
    main()
