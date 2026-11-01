# InfraPilot Python Backend — 生产容器镜像（FastAPI / uvicorn）
#
# 构建上下文是 py-server/ 目录本身（后端已完全自包含）：
#   docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest py-server
#   （或在 py-server/ 内直接执行： docker build -t localhost:5000/infrapilot/server:latest .）
#
# 运行时：
#   - PYTHONPATH 无需设置，WORKDIR=/app 下 `python3 -m infrapilot` 即可；
#   - 数据（SQLite / runtime-config / artifacts）落在 INFRAPILOT_DATA_DIR=/app/data，生产请挂持久卷；
#   - SKILL.md 技能包随仓库携带在 py-server/skills，镜像内固定为 /app/skills；
#   - draw.io 导出脚本在 /app/scripts/drawio-to-png.mjs（PNG 导出需要基础镜像内有 node，
#     python:3.11-slim 默认没有 —— 保持与原双后端时期一致的可用性限制）。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 依赖层单独缓存
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 后端源码 + SKILL.md 技能包 + 工具脚本（drawio PNG 导出等）
COPY infrapilot ./infrapilot
COPY skills ./skills
COPY scripts ./scripts

ENV INFRAPILOT_DATA_DIR=/app/data \
    INFRAPILOT_SKILLS_DIR=/app/skills \
    INFRAPILOT_EVAL_CASES_DIR=/app/infrapilot/eval_cases \
    DRAWIO_EXPORT_SCRIPT=/app/scripts/drawio-to-png.mjs \
    PORT=8787

# SQLite / runtime-config 默认写在 /app/data
RUN mkdir -p /app/data

EXPOSE 8787

CMD ["python3", "-m", "infrapilot"]
