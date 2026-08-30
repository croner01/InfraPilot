# InfraPilot Web — 生产静态站点镜像
# Stage 1：Vite 构建 React 应用
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2：Nginx 托管静态资源，并代理 /api 与 /ws 到后端 Service
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
