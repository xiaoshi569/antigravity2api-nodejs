# --- 基础阶段 (Base Stage) ---
FROM node:20-alpine AS base

# 设置工作目录
WORKDIR /usr/src/app


# --- 依赖阶段 (Dependencies Stage) ---
FROM base AS dependencies

# 复制 package.json 和 package-lock.json
COPY package.json package-lock.json* ./

# 安装生产环境依赖
RUN npm ci --omit=dev


# --- 生产/运行阶段 (Production/Runtime Stage) ---
FROM base AS production

# 设置环境变量
ENV NODE_ENV=production

# 从"依赖阶段"复制生产环境的 node_modules
COPY --from=dependencies /usr/src/app/node_modules ./node_modules

# 复制 package.json（ES Module 需要 "type": "module"）
COPY package.json ./

# 复制源代码和配置文件
COPY src ./src
COPY config.json ./

# 创建 data 目录用于存放 accounts.json
RUN mkdir -p data

# 暴露端口
EXPOSE 1562

# 启动应用
CMD [ "node", "src/server/index.js" ]
