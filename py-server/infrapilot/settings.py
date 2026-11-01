"""运行时配置（环境变量 + data 目录解析）。"""

from __future__ import annotations

import os
from pathlib import Path


def _default_data_dir() -> Path:
    # 默认使用 py-server/data，避免与 Node 版 server/data 互相污染；
    # 需要共用数据时通过 INFRAPILOT_DATA_DIR 显式指定。
    return Path(__file__).resolve().parent.parent / "data"


DATA_DIR = Path(os.environ.get("INFRAPILOT_DATA_DIR") or _default_data_dir()).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "infrapilot.sqlite"
DIAGRAMS_DIR = DATA_DIR / "diagrams"
RUNTIME_CONFIG_PATH = DATA_DIR / "runtime-config.json"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def port() -> int:
    return int(os.environ.get("PORT") or 8787)


def mcp_server_mode() -> bool:
    return os.environ.get("MCP_SERVER_MODE") == "true"


class LlmEnv:
    """环境变量层面的 LLM 配置（runtime-config 未提供 provider 时的回退）。"""

    @staticmethod
    def api_key() -> str:
        return os.environ.get("GSK_API_KEY") or os.environ.get("OPENAI_API_KEY") or "sk-test"

    @staticmethod
    def base_url() -> str:
        return os.environ.get("OPENAI_BASE_URL") or "https://www.genspark.ai/api/llm_proxy/v1"

    @staticmethod
    def reasoning_model() -> str:
        return os.environ.get("REASONING_MODEL") or "deepseek-v4-pro"

    @staticmethod
    def fast_model() -> str:
        return os.environ.get("FAST_MODEL") or "deepseek-v4-flash"
