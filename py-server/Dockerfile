# InfraPilot Python Backend — 生产容器镜像（FastAPI / uvicorn）
#
# 构建上下文是**仓库根目录**（需要同时拷贝 py-server/ 与 server/skills/）：
#   docker build -f py-server/Dockerfile -t localhost:5000/infrapilot/server:latest .
#
# 运行时：
#   - PYTHONPATH 无需设置，WORKDIR=/app 下 `python3 -m infrapilot` 即可；
#   - 数据（SQLite / runtime-config / artifacts）落在 INFRAPILOT_DATA_DIR=/app/data，生产请挂持久卷；
#   - SKILL.md 技能包复用 Node 仓库的 server/skills，镜像内固定为 /app/skills。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 依赖层单独缓存
COPY py-server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 后端源码
COPY py-server/infrapilot ./infrapilot

# SKILL.md 技能包（sre-systematic-debugging 等），与 Node 版共用同一份
COPY server/skills ./skills

ENV INFRAPILOT_DATA_DIR=/app/data \
    INFRAPILOT_SKILLS_DIR=/app/skills \
    INFRAPILOT_EVAL_CASES_DIR=/app/infrapilot/eval_cases \
    PORT=8787

# SQLite / runtime-config 默认写在 /app/data
RUN mkdir -p /app/data

EXPOSE 8787

CMD ["python3", "-m", "infrapilot"]
