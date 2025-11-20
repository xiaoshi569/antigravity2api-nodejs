# --- 基础阶段 (Base Stage) ---
# 定义一个基础阶段，包含通用的Node.js环境。
# 使用Alpine版本来保持镜像小巧。node:20-alpine是一个很好的现代选择。
# 确保这个基础镜像支持您需要的所有架构（官方镜像都支持）。
FROM node:20-alpine AS base

# 设置工作目录
WORKDIR /usr/src/app


# --- 依赖阶段 (Dependencies Stage) ---
# 这个阶段专门用于安装生产环境的依赖。
FROM base AS dependencies

# 复制 package.json 和 package-lock.json (或 yarn.lock, pnpm-lock.yaml)
# 这样做可以充分利用Docker的层缓存。只要这些文件不改变，就不需要重新安装依赖。
COPY package.json package-lock.json* ./

# 安装生产环境依赖。
# 使用 'npm ci' 是最佳实践，它比 'npm install' 更快、更可靠，因为它严格按照 lock 文件安装。
# '--only=production' 确保不安装devDependencies。
RUN npm ci --only=production


# --- 构建阶段 (Build Stage) ---
# 如果您的项目需要构建步骤（例如TypeScript编译、前端资源打包），则使用此阶段。
# 如果您的项目是纯JavaScript，可以直接跳过此阶段。
FROM base AS build

# 复制依赖定义文件
COPY package.json package-lock.json* ./

# 安装所有依赖，包括devDependencies，因为构建过程可能需要它们。
RUN npm install

# 复制项目的其余所有文件
COPY . .

# 执行构建命令。构建产物通常会输出到 'dist' 目录。
# 请根据您的 package.json 中的脚本修改 'npm run build'。
RUN npm run build


# --- 生产/运行阶段 (Production/Runtime Stage) ---
# 这是最终的镜像，它将非常轻量。
FROM base AS production

# 设置环境变量，表明这是生产环境
ENV NODE_ENV=production

# 从“依赖阶段”复制生产环境的 node_modules
COPY --from=dependencies /usr/src/app/node_modules ./node_modules

# 从“构建阶段”复制构建好的应用代码。
# 如果您的项目有构建步骤，请使用这行，并将 'dist' 替换为您的构建输出目录。
COPY --from=build /usr/src/app/dist ./dist

# 如果您的项目没有构建步骤（纯JS），请从 'build' 阶段复制源代码。
# 注意：上面的 'build' 阶段需要相应调整为只复制源码，或者直接从本地复制。
# 为了通用性，我们假设有构建步骤。如果没构建步骤，可以这样写：
# COPY --from=build /usr/src/app/src ./src
# COPY --from=build /usr/src/app/package.json .

# 创建一个非root用户来运行应用，以增强安全性。
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 将工作目录的所有权交给新用户
# 如果您复制了 'dist' 和 'node_modules'
RUN chown -R appuser:appgroup /usr/src/app/dist /usr/src/app/node_modules
# 如果您没有构建步骤，而是复制了'src'
# RUN chown -R appuser:appgroup /usr/src/app/src /usr/src/app/node_modules

# 切换到这个非root用户
USER appuser

# 暴露您的应用程序正在监听的端口。请务必修改为您的实际端口。
EXPOSE 8045

# 定义容器启动时执行的命令。
# 请将 'dist/main.js' 替换为您的应用入口文件。
CMD [ "node", "dist/main.js" ]
