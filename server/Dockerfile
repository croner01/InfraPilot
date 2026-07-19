# InfraPilot Server — 生产容器镜像
# 多阶段构建：stage 1 编译 TypeScript 并安装含原生模块的依赖；stage 2 精简运行时
FROM node:22 AS builder

WORKDIR /app

# 安装构建原生模块所需工具
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

# better-sqlite3 等原生模块依赖标准 C++ 库
RUN apt-get update && apt-get install -y libstdc++6 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/proto ./proto

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "dist/index.js"]
