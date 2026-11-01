#!/usr/bin/env python3
"""Phase 6 契约对拍 —— 对比 Node(`server/`) 与 Python(`py-server/`) 的 HTTP 契约。

两层对比：
1. **静态路由表**：从 Node 源码提取 `router.<method>("<path>")` + 挂载前缀，与 FastAPI 的
   路由表逐条比对（method + 归一化路径），输出「Node 有 / Python 缺」的破坏性差异。
2. **动态响应形状**：同时启动两个后端，对同一批端点发请求，比较 HTTP 状态与 JSON 结构
   （递归 key/type 签名），并单独校验错误体是否都为 `{"error": ...}`。

用法：
    python3 scripts/contract_diff.py                 # 静态 + 动态（自动起停两个后端）
    python3 scripts/contract_diff.py --static-only    # 仅静态路由表（不需要 Node 依赖）
    python3 scripts/contract_diff.py --node-port 8788 --py-port 8789 --json /tmp/diff.json
退出码：存在破坏性差异（Node 有而 Python 缺 / 状态码不一致 / 错误体不一致 / 核心端点结构不一致）为 1。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
PY_SERVER = REPO_ROOT / "py-server"
NODE_SERVER = REPO_ROOT / "server"

# Node 路由变量 -> 挂载前缀（来自 server/src/index.ts 与 routes/api.ts）
NODE_MOUNTS = {
    "apiRouter": "/api",
    "configRouter": "/api/config",
    "dataSourcesRouter": "/api/data-sources",
    "skillsRouter": "/api/skills",
}

# 动态探针：核心端点（结构不一致即判失败）
CORE_GET = [
    "/health",
    "/api/sessions",
    "/api/alerts",
    "/api/config/log-systems",
    "/api/config/metric-systems",
    "/api/config/database-systems",
    "/api/config/hosts",
    "/api/config/llm-providers",
    "/api/config/mcp",
    "/api/config/memory",
    "/api/config/model-prices",
    "/api/data-sources/prom",
    "/api/data-sources/db",
    "/api/skills",
    "/api/skills/curated",
    "/api/skills/factory/sessions",
    "/api/skills/factory/pending",
]
# 追加端点（Node 无此路由，返回 404 属预期）
OPTIONAL_GET = ["/api/topology?limit=2", "/api/usage/summary?days=1"]
# 依赖真实集群/索引的端点：结构与取值随时序变化，仅作信息性提示
LIVE_GET = ["/api/k8s/pods?abnormalOnly=true"]
ERROR_PROBE = "/api/sessions/__contract-diff-missing__"

_METHOD_RE = re.compile(r"(\w+)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[\"`']([^\"`']*)[\"`']")
_MOUNT_RE = re.compile(r"(\w+)\s*\.\s*use\s*\(\s*[\"`']([^\"`']*)[\"`']\s*,\s*(\w+)")
_APP_GET_RE = re.compile(r"app\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[\"`']([^\"`']*)[\"`']")


def normalize_path(path: str) -> str:
    # 参数名不参与契约（Node 用 :id，FastAPI 常用 :session_id），统一归一为 :p
    path = re.sub(r"\{[^}]+\}", ":p", path)
    path = re.sub(r":[^/]+", ":p", path)
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return path or "/"


def extract_node_routes(repo: Path) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()
    route_files = [p for p in (repo / "src" / "routes").glob("*.ts") if not p.name.endswith(".test.ts")]
    for file in [repo / "src" / "index.ts", *route_files]:
        text = file.read_text(encoding="utf-8")
        if file.name == "index.ts":
            for method, path in _APP_GET_RE.findall(text):
                routes.add((method.upper(), normalize_path(path)))
        for var, method, path in _METHOD_RE.findall(text):
            prefix = NODE_MOUNTS.get(var)
            if prefix is None:
                continue
            routes.add((method.upper(), normalize_path(prefix + path if path.startswith("/") else prefix + "/" + path)))
    return routes


def extract_python_routes() -> set[tuple[str, str]]:
    sys.path.insert(0, str(PY_SERVER))
    from infrapilot.main import app  # noqa: PLC0415

    routes: set[tuple[str, str]] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        if path in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"):
            continue
        for method in methods:
            routes.add((method.upper(), normalize_path(path)))
    return routes


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(("127.0.0.1", port)) != 0


def start_node(port: int, log) -> Optional[subprocess.Popen]:
    tsx = NODE_SERVER / "node_modules" / ".bin" / "tsx"
    if not tsx.exists():
        log("  ! Node 依赖未安装（server/node_modules/.bin/tsx 缺失），跳过动态探针")
        return None
    # 必须用隔离数据目录：否则会读到开发用的 runtime-config.json，导致两端对比的不是同一份默认配置
    env = {
        **os.environ,
        "PORT": str(port),
        "INFRAPILOT_DATA_DIR": "/tmp/infrapilot-contract-node",
        "MCP_SERVER_MODE": "",
    }
    return subprocess.Popen([str(tsx), "src/index.ts"], cwd=str(NODE_SERVER), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def start_python(port: int, log) -> subprocess.Popen:
    env = {**os.environ, "PORT": str(port), "INFRAPILOT_DATA_DIR": "/tmp/infrapilot-contract-py", "INFRAPILOT_SCHEDULER": "0"}
    return subprocess.Popen([sys.executable, "-m", "infrapilot"], cwd=str(PY_SERVER), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def wait_health(port: int, timeout: float = 90) -> bool:
    import httpx

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            res = httpx.get(f"http://127.0.0.1:{port}/health", timeout=3)
            if res.status_code == 200:
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    return False


def shape(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "..."
    if isinstance(value, dict):
        return {k: shape(v, depth + 1) for k, v in sorted(value.items())}
    if isinstance(value, list):
        merged: dict[str, Any] = {}
        for item in value[:3]:
            if isinstance(item, dict):
                for k, v in shape(item, depth + 1).items():
                    merged.setdefault(k, v)
        return [merged] if merged else ([shape(value[0], depth + 1)] if value else [])
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if value is None:
        return "null"
    return "string"


def is_breaking_diff(diff: str) -> bool:
    """纯新增字段对 JS 前端是兼容的；缺失字段或类型变化才是破坏性的。"""
    if "新增(node 无)" in diff:
        return False
    return "缺失" in diff or "node=" in diff


def shape_diff(expected: Any, actual: Any, path: str = "$") -> list[str]:
    diffs: list[str] = []
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in expected:
            if key not in actual:
                diffs.append(f"{path}.{key}: 缺失")
            else:
                diffs.extend(shape_diff(expected[key], actual[key], f"{path}.{key}"))
        for key in actual:
            if key not in expected:
                diffs.append(f"{path}.{key}: 新增(node 无)")
    elif isinstance(expected, list) and isinstance(actual, list):
        if expected and actual:
            diffs.extend(shape_diff(expected[0], actual[0], f"{path}[0]"))
    elif expected != actual:
        diffs.append(f"{path}: node={expected} py={actual}")
    return diffs


def probe(base: str, method: str, path: str, body: Any = None) -> tuple[int, Any]:
    import httpx

    kwargs = {"timeout": 30}
    if body is not None:
        kwargs["json"] = body
    res = httpx.request(method, f"{base}{path}", **kwargs)
    try:
        return res.status_code, res.json()
    except Exception:  # noqa: BLE001
        return res.status_code, res.text[:200]


def run_probes(node_port: int, py_port: int, node_route_paths: set[str], log) -> dict[str, Any]:
    node_base, py_base = f"http://127.0.0.1:{node_port}", f"http://127.0.0.1:{py_port}"
    results: dict[str, Any] = {"ok": [], "shape": [], "status": [], "notes": [], "additive": [], "live": [], "additiveShape": []}

    sid_node = probe(node_base, "POST", "/api/sessions", {"title": "contract-diff"})[1]
    sid_py = probe(py_base, "POST", "/api/sessions", {"title": "contract-diff"})[1]

    for path in CORE_GET + OPTIONAL_GET + LIVE_GET:
        core = path in CORE_GET
        live = path in LIVE_GET
        bare = path.split("?")[0]
        additive = (not live) and (bare not in node_route_paths)
        try:
            n_status, n_body = probe(node_base, "GET", path)
            p_status, p_body = probe(py_base, "GET", path)
        except Exception as err:  # noqa: BLE001
            results["notes"].append(f"{path}: 探针异常 {err}")
            continue
        entry = {"path": path, "core": core, "live": live, "additive": additive, "nodeStatus": n_status, "pyStatus": p_status}
        if additive and n_status == 404 and p_status == 200:
            results["additive"].append(entry)
            continue
        if n_status // 100 != p_status // 100:
            entry["diffs"] = [f"状态码: node={n_status} py={p_status}"]
            results["status"].append(entry)
            continue
        if n_status >= 400:
            results["ok"].append({**entry, "note": "两端同为错误响应"})
            continue
        diffs = shape_diff(shape(n_body), shape(p_body))
        if diffs:
            entry["diffs"] = diffs
            entry["breaking"] = any(is_breaking_diff(d) for d in diffs)
            if live:
                results["live"].append({**entry, "note": "真实集群数据，按键集合合并比较，取值差异属正常"})
            elif entry["breaking"] and core:
                results["shape"].append(entry)
            elif not entry["breaking"]:
                results["additiveShape"].append(entry)
            else:
                results["notes"].append(f"{path}: {diffs[:3]}")
        else:
            results["ok"].append(entry)

    # 错误体契约
    n_status, n_body = probe(node_base, "GET", ERROR_PROBE)
    p_status, p_body = probe(py_base, "GET", ERROR_PROBE)
    envelope = {
        "node": {"status": n_status, "keys": sorted(n_body.keys()) if isinstance(n_body, dict) else type(n_body).__name__},
        "py": {"status": p_status, "keys": sorted(p_body.keys()) if isinstance(p_body, dict) else type(p_body).__name__},
    }
    if isinstance(n_body, dict) and isinstance(p_body, dict):
        envelope["match"] = set(n_body) == set(p_body)
    else:
        envelope["match"] = False
    results["errorEnvelope"] = envelope

    for probe_name, base, sid in (("node", node_base, sid_node), ("py", py_base, sid_py)):
        if isinstance(sid, dict) and sid.get("id"):
            probe(base, "DELETE", f"/api/sessions/{sid['id']}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-port", type=int, default=8788)
    parser.add_argument("--py-port", type=int, default=8789)
    parser.add_argument("--static-only", action="store_true")
    parser.add_argument("--json", type=str, default="")
    args = parser.parse_args()

    def log(msg: str) -> None:
        print(msg, flush=True)

    log("== 1) 静态路由表对拍 ==")
    node_routes = extract_node_routes(NODE_SERVER)
    py_routes = extract_python_routes()
    missing = sorted(node_routes - py_routes)
    additive = sorted(py_routes - node_routes)
    log(f"node={len(node_routes)} py={len(py_routes)} 共有={len(node_routes & py_routes)}")
    log(f"Node 有 / Python 缺（破坏性）: {len(missing)}")
    for method, path in missing:
        log(f"  - {method:6} {path}")
    log(f"Python 新增（追加，兼容）: {len(additive)}")
    for method, path in additive:
        log(f"  + {method:6} {path}")

    report: dict[str, Any] = {
        "static": {
            "nodeCount": len(node_routes),
            "pyCount": len(py_routes),
            "missingInPython": [f"{m} {p}" for m, p in missing],
            "additiveInPython": [f"{m} {p}" for m, p in additive],
        }
    }
    breaking = len(missing) > 0

    if not args.static_only:
        log("\n== 2) 动态响应形状对拍 ==")
        node_proc: Optional[subprocess.Popen] = None
        py_proc: Optional[subprocess.Popen] = None
        try:
            node_proc = start_node(args.node_port, log)
            py_proc = start_python(args.py_port, log)
            if not wait_health(args.py_port):
                log("  ! Python 后端未起来，跳过动态探针")
            elif node_proc is None or not wait_health(args.node_port):
                log("  ! Node 后端未起来，仅探测 Python 侧结构（跳过对比）")
            else:
                node_get_paths = {path for method, path in node_routes if method == "GET"}
                probes = run_probes(args.node_port, args.py_port, node_get_paths, log)
                report["probes"] = probes
                log(f"  结构一致: {len(probes['ok'])}；追加端点(node 404 属预期): {len(probes['additive'])}")
                for entry in probes["additiveShape"]:
                    log(f"  [兼容新增字段] {entry['path']}: {entry['diffs'][:4]}")
                for entry in probes["shape"]:
                    log(f"  [STRUCT] {entry['path']}: {entry['diffs'][:4]}")
                for entry in probes["status"]:
                    log(f"  [STATUS] {entry['path']}: node={entry['nodeStatus']} py={entry['pyStatus']}")
                for entry in probes["live"]:
                    log(f"  [live] {entry['path']}: {entry['diffs'][:3]}")
                for note in probes["notes"]:
                    log(f"  [note] {note}")
                envelope = probes["errorEnvelope"]
                log(f"  错误体: node={envelope['node']} py={envelope['py']} match={envelope['match']}")
                if probes["shape"] or probes["status"] or not envelope["match"]:
                    breaking = True
        finally:
            for proc in (node_proc, py_proc):
                if proc is not None:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    except Exception:  # noqa: BLE001
                        proc.terminate()

    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"\n报告已写入 {args.json}")
    log("\n结果: " + ("存在破坏性差异" if breaking else "契约一致（仅存在 Python 侧追加路由）"))
    return 1 if breaking else 0


if __name__ == "__main__":
    raise SystemExit(main())
