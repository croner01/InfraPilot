"""日志采集管道 —— 真实 K8s Pod 日志 -> 真实 OpenSearch / Elasticsearch 索引。

移植自 Node 版 `server/src/skills/elk/logShipper.ts`（该后端已删除）。

数据源: containerd CRI 落盘到 /var/log/pods/<namespace>_<pod>_<uid>/<container>/*.log
的真实容器标准输出日志(格式: "<RFC3339时间戳> <stream> <F|P> <内容>")。
demos 演示工作负载(如 order-api)由 k8s-manifests 部署为真实 Deployment,
其日志由本模块 tail 后解析并批量写入 OpenSearch 索引,
供 ELK Skill 的检索/聚合/聚类工具查询 —— 全链路无编造数据。

- 轻量 polling tail(而非 inotify): 数据量小,按文件 offset 增量读取,重启安全。
- 写入通道双模: `type=elk`(OpenSearch SDK)与 `type=es8|elasticsearch`(httpx REST,
  `compatible-with: 8` 兼容头),与 ELK Skill 的读取通道一致。
- 采集目标与 elk 后端 node 全部来自 runtime-config 的 logSystems
  (config_store.sync_elk_env 会同步进 LOG_SHIP_TARGETS / OPENSEARCH_NODE),
  热更新对下一轮循环生效,无需重启。
- `/api/config/log-systems/:id/ship-status` 返回本模块记录的真实采集状态,
  不再是 Node 版移植前的「尚未采集」占位。
- Pods 根目录默认 /var/log/pods,环境变量 PODS_LOG_ROOT 覆盖(便于测试/容器化部署)。
- 整个循环可用 INFRAPILOT_LOG_SHIPPER=0 关闭(测试与纯 API 部署场景)。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import datasource_client as ds
from .config_store import get_legacy_elk_config

DEFAULT_INTERVAL_MS = 2000

_CRI_LINE_RE = re.compile(r"^(\S+)\s+(stdout|stderr)\s+[FP]\s+(.*)$")


def pods_log_root() -> str:
    return os.environ.get("PODS_LOG_ROOT") or "/var/log/pods"


def enabled() -> bool:
    return os.environ.get("INFRAPILOT_LOG_SHIPPER", "1") not in ("0", "false", "False", "")


def ship_targets() -> list[dict[str, Any]]:
    """采集目标(logSystems 的 elk 后端 targets),由 config_store 与 env 保持同步。"""
    return get_legacy_elk_config().get("targets") or []


def _target_key(t: dict[str, Any]) -> str:
    return f"{t.get('namespace')}|{t.get('podNamePrefix') or ''}|{t.get('indexPrefix')}"


# 每个采集目标最近一次采集的状态,供 /api/config/log-systems/:id/ship-status 查询
# (asyncio 单任务写 + FastAPI 同步路由读:字典整体读写在 CPython 下够用,与 Node 版 Map 一致)
SHIP_STATUS: dict[str, dict[str, Any]] = {}

# 已提示过「0 个日志文件」的目标,避免每轮刷警告
_warned_zero_files: set[str] = set()

# 每个文件已采集到的 offset {"path": {"filePath":..., "offset":...}}
_shipper_states: dict[str, dict[str, Any]] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_ship_status(key: str, target: dict[str, Any]) -> dict[str, Any]:
    s = SHIP_STATUS.get(key)
    if not s:
        s = {"target": dict(target), "fileCount": 0, "lastShippedCount": 0, "totalShipped": 0}
        SHIP_STATUS[key] = s
    return s


def get_ship_status() -> list[dict[str, Any]]:
    """所有已配置采集目标的采集状态(尚未扫描过的目标给出占位状态)。"""
    targets = ship_targets()
    out: list[dict[str, Any]] = []
    for t in targets:
        s = SHIP_STATUS.get(_target_key(t))
        if s:
            out.append(s)
        else:
            out.append(
                {
                    "target": dict(t),
                    "fileCount": 0,
                    "lastShippedCount": 0,
                    "totalShipped": 0,
                    "warning": "尚未扫描,等待下一次采集",
                }
            )
    return out


def extract_pod_name(dir_name: str, namespace: str) -> str:
    """从 /var/log/pods/<namespace>_<pod>_<uid> 目录名中提取真实 pod 名。"""
    prefix = f"{namespace}_"
    if not dir_name.startswith(prefix):
        return dir_name
    rest = dir_name[len(prefix):]
    last_underscore = rest.rfind("_")
    return rest[:last_underscore] if last_underscore > 0 else rest


def find_pod_log_files(namespace: str, pod_name_prefix: str) -> list[dict[str, str]]:
    """列出指定 namespace/pod 前缀下所有容器日志文件(重启后 uid 会变,每次重新扫描)。

    podNamePrefix 留空表示匹配该 namespace 下全部 Pod。
    """
    root = pods_log_root()
    if not os.path.isdir(root):
        return []
    dir_prefix = f"{namespace}_{pod_name_prefix}" if pod_name_prefix else f"{namespace}_"
    try:
        dirs = sorted(d for d in os.listdir(root) if d.startswith(dir_prefix))
    except OSError:
        return []
    files: list[dict[str, str]] = []
    for d in dirs:
        full = os.path.join(root, d)
        pod_name = extract_pod_name(d, namespace)
        try:
            container_dirs = sorted(os.listdir(full))
        except OSError:
            continue
        for c in container_dirs:
            c_dir = os.path.join(full, c)
            try:
                log_files = sorted(f for f in os.listdir(c_dir) if f.endswith(".log"))
            except OSError:
                continue
            for f in log_files:
                files.append({"filePath": os.path.join(c_dir, f), "podName": pod_name, "container": c})
    return files


def parse_cri_log_line(line: str) -> Optional[dict[str, str]]:
    """CRI 日志格式: 2026-07-17T05:33:11.53346851Z stdout F {"level":...}"""
    m = _CRI_LINE_RE.match(line)
    if not m:
        return None
    return {"time": m.group(1), "stream": m.group(2), "content": m.group(3)}


def parse_docker_json_log_line(line: str) -> Optional[dict[str, str]]:
    """Docker JSON 日志: {"log":"...?","stream":"stdout","time":"2026-07-18T..."}"""
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("log"), str) or not isinstance(obj.get("time"), str):
        return None
    stream = str(obj.get("stream") or "stdout")
    return {"time": str(obj["time"]), "stream": stream, "content": str(obj["log"]).rstrip("\n")}


def parse_log_line(line: str) -> Optional[dict[str, str]]:
    return parse_cri_log_line(line) or parse_docker_json_log_line(line)


def _today_index(prefix: str) -> str:
    return f"{prefix}-{datetime.now(timezone.utc).isoformat()[:10]}"


def _active_elk_backend() -> Optional[dict[str, Any]]:
    from .config_store import get_default_elk_backend, get_log_systems

    return get_default_elk_backend() or next(
        (b for b in get_log_systems() if b.get("type") in ("elk", "es8", "elasticsearch")), None
    )


def _rest_flavor(system: dict[str, Any]) -> bool:
    return ds.is_rest_flavor(system) or str(system.get("type") or "elk") in ("es8", "elasticsearch")


def _auth_and_headers(system: dict[str, Any]) -> tuple[Any, dict[str, str]]:
    import httpx

    pair = ds.auth_tuple(system)
    auth = httpx.BasicAuth(pair[0], pair[1]) if pair else None
    return auth, ds.build_headers(system)


def _prepare_index_template(prefix: str) -> None:  # noqa: C901
    """创建 index template(幂等,已存在时忽略)。elk 用 SDK;es8 用 REST。"""
    system = _active_elk_backend() or {}
    template_name = f"{prefix}-template"
    mappings = {
        "properties": {
            "@timestamp": {"type": "date"},
            "service": {"type": "keyword"},
            "level": {"type": "keyword"},
            "message": {"type": "text"},
            "pid": {"type": "integer"},
            "uptime_ms": {"type": "long"},
            "rss_mb": {"type": "integer"},
            "requests_processed": {"type": "long"},
            "p99_latency_ms": {"type": "integer"},
            "pod_name": {"type": "keyword"},
            "namespace": {"type": "keyword"},
            "container": {"type": "keyword"},
            "stream": {"type": "keyword"},
        }
    }
    body = {
        "index_patterns": [f"{prefix}-*"],
        "template": {
            "settings": {"number_of_shards": 1, "number_of_replicas": 0},
            "mappings": mappings,
        },
    }
    if _rest_flavor(system):
        import httpx

        auth, headers = _auth_and_headers(system)
        node = str(system.get("node") or "").rstrip("/")
        with httpx.Client(timeout=10, verify=not system.get("skipTlsVerify", True), auth=auth) as client:
            res = client.put(f"{node}/_index_template/{template_name}", json=body, headers=headers)
            res.raise_for_status()
        return
    from opensearchpy import OpenSearch

    client = OpenSearch(
        hosts=[system.get("node") or get_legacy_elk_config()["node"]],
        verify_certs=False,
        ssl_show_warn=False,
        timeout=10,
        max_retries=1,
        retry_on_timeout=False,
    )
    client.indices.put_index_template(name=template_name, body=body)


def _bulk_write(index_docs: list[tuple[str, dict[str, Any]]]) -> None:
    """批量写入。elk 用 OpenSearch SDK;es8/rest 后端用 _bulk NDJSON + 兼容头。"""
    system = _active_elk_backend() or {}
    stype = str(system.get("type") or "elk")
    lines: list[str] = []
    for index, doc in index_docs:
        lines.append(json.dumps({"index": {"_index": index}}, ensure_ascii=False))
        lines.append(json.dumps(doc, ensure_ascii=False, default=str))
    body = ("\n".join(lines) + "\n").encode("utf-8")

    if _rest_flavor(system):
        import httpx

        auth, headers = _auth_and_headers(system)
        # ES8 兼容模式要求 content-type 带 compatible-with；x-ndjson 变体仅 ES/兼容后端使用
        if ds.is_rest_flavor(system):
            headers["Content-Type"] = "application/vnd.elasticsearch+x-ndjson; compatible-with=8"
        else:
            headers["Content-Type"] = "application/x-ndjson"
        node = str(system.get("node") or "").rstrip("/")
        with httpx.Client(timeout=15, verify=not system.get("skipTlsVerify", True), auth=auth) as client:
            res = client.post(f"{node}/_bulk", content=body, headers=headers)
            res.raise_for_status()
        return

    from opensearchpy import OpenSearch

    client = OpenSearch(
        hosts=[system.get("node") or get_legacy_elk_config()["node"]],
        verify_certs=False,
        ssl_show_warn=False,
        timeout=15,
        max_retries=1,
        retry_on_timeout=False,
    )
    client.bulk(body=body)


async def ship_once(target: dict[str, Any]) -> dict[str, Any]:
    """扫描并采集指定目标的增量内容,解析后批量写入 OpenSearch(幂等,按 offset)。"""
    start = time.time()
    key = _target_key(target)
    status = _ensure_ship_status(key, target)
    status["target"] = dict(target)
    status["lastScannedAt"] = _now_iso()

    try:
        files = find_pod_log_files(str(target.get("namespace") or ""), str(target.get("podNamePrefix") or ""))
        status["fileCount"] = len(files)

        if not files:
            status["warning"] = "匹配到 0 个日志文件,请检查 namespace/podNamePrefix 是否与该节点上的 Pod 一致"
            if key not in _warned_zero_files:
                print(
                    f"[logShipper] 采集目标 {target.get('namespace')}/{target.get('podNamePrefix') or '(全部 Pod)'}"
                    " 匹配到 0 个日志文件,请检查 namespace/pod 前缀配置"
                )
                _warned_zero_files.add(key)
            return {"target": target, "shipped": 0}
        if status.get("warning"):
            status.pop("warning", None)
        _warned_zero_files.discard(key)

        index_docs: list[tuple[str, dict[str, Any]]] = []
        for f in files:
            file_path = f["filePath"]
            try:
                size = os.stat(file_path).st_size
            except OSError:
                continue
            state = _shipper_states.setdefault(file_path, {"filePath": file_path, "offset": 0})
            if size < state["offset"]:
                state["offset"] = 0  # 文件被截断/轮转,从头重读
            if size == state["offset"]:
                continue

            with open(file_path, "rb") as fh:
                fh.seek(state["offset"])
                chunk = fh.read(size - state["offset"])
            state["offset"] = size

            for line in chunk.decode("utf-8", "replace").split("\n"):
                if not line:
                    continue
                parsed = parse_log_line(line)
                if not parsed:
                    continue
                try:
                    doc = json.loads(parsed["content"])
                    if not isinstance(doc, dict):
                        raise ValueError("not an object")
                except ValueError:
                    # 非 JSON 行(启动 banner 等),仍以纯文本形式索引,保证不丢日志
                    doc = {"message": parsed["content"], "level": "INFO"}
                doc["@timestamp"] = doc.get("@timestamp") or parsed["time"]
                doc["pod_name"] = f["podName"]
                doc["namespace"] = target.get("namespace")
                doc["container"] = f["container"]
                doc["stream"] = parsed["stream"]
                index_docs.append((_today_index(str(target.get("indexPrefix"))), doc))

        shipped = len(index_docs)
        if index_docs:
            await asyncio.to_thread(_bulk_write, index_docs)
            status["lastShippedAt"] = _now_iso()
            status["lastShippedCount"] = shipped
            status["totalShipped"] = int(status.get("totalShipped") or 0) + shipped
        status["lastError"] = None
        status["lastErrorAt"] = None
        return {"target": target, "shipped": shipped, "tookMs": int((time.time() - start) * 1000)}
    except Exception as err:  # noqa: BLE001
        status["lastError"] = str(err)
        status["lastErrorAt"] = _now_iso()
        raise


async def ship_all_targets() -> list[dict[str, Any]]:
    """顺序采集所有目标(避免并发导致的 offset 读写竞争)。"""
    results: list[dict[str, Any]] = []
    for target in ship_targets():
        try:
            results.append(await ship_once(target))
        except Exception as err:  # noqa: BLE001
            print(f"[logShipper] 采集 {target.get('namespace')}/{target.get('podNamePrefix')} 失败: {err}")
            results.append({"target": target, "shipped": 0})
    return results


_task: Optional[asyncio.Task] = None


def _prepare_all_templates() -> None:
    for t in ship_targets():
        try:
            _prepare_index_template(str(t.get("indexPrefix")))
        except Exception as err:  # noqa: BLE001 - 已存在/不可达都不致命
            print(f"[logShipper] index template {t.get('indexPrefix')} init 失败(可能已存在,忽略): {err}")


async def start(interval_ms: int = DEFAULT_INTERVAL_MS) -> None:
    """启动采集循环(asyncio task;幂等)。"""
    global _task
    if _task is not None and not _task.done():
        return
    targets = ship_targets()
    print(f"[logShipper] 已配置 {len(targets)} 个采集目标:")
    for t in targets:
        print(f"  - namespace={t.get('namespace')}, podPrefix={t.get('podNamePrefix')}, indexPrefix={t.get('indexPrefix')}")
    await asyncio.to_thread(_prepare_all_templates)
    _task = asyncio.create_task(_loop(interval_ms / 1000))


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None


async def _loop(interval_s: float) -> None:
    while True:
        try:
            await ship_all_targets()
        except Exception as err:  # noqa: BLE001
            print(f"[logShipper] 采集失败: {err}")
        await asyncio.sleep(interval_s)
