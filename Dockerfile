FROM node:20-alpine

WORKDIR /app

# 仅先复制依赖清单以利用构建缓存
COPY package*.json ./
RUN npm ci --omit=dev

# 复制应用源码
COPY src ./src

ENV NODE_ENV=production
ENV PGHOST=db
ENV PGPORT=5432

EXPOSE 3000

# 容器内执行：等待数据库 -> 建表（幂等）-> 初始化本地账号 -> 启动 Web
CMD ["node", "src/server.js"]
