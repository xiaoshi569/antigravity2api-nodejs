import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import config from '../config/config.js';
import { generateProjectId, generateSessionId } from '../utils/idGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.maxRetries = 3; // 最大重试次数
    this.activeRequests = new Map(); // 跟踪每个 token 的活跃请求数

    // 添加统计功能
    this.stats = new Map(); // 记录每个 token 的使用统计

    // 文件写入锁（防止并发写入冲突）
    this.fileLock = Promise.resolve();

    // 每日重置定时器
    this.dailyResetTimer = null;

    this.loadTokens();

    // 启动每日统计重置定时任务
    this.scheduleDailyReset();
  }

  /**
   * 初始化或获取 token 统计信息
   */
  initStats(token) {
    // 安全检查：token 和 refresh_token 必须存在
    if (!token || !token.refresh_token) {
      log.warn('无法初始化统计信息: token 或 refresh_token 为空');
      return null;
    }

    if (!this.stats.has(token.refresh_token)) {
      this.stats.set(token.refresh_token, {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        lastUsedTime: null,
        lastError: null,
        refreshCount: 0,
        status: 'idle', // idle, active, rate_limited, disabled
        cooldownUntil: null, // 冷却结束时间（毫秒时间戳）
        consecutive429Count: 0 // 连续 429 失败次数（用于指数退避）
      });
    }
    return this.stats.get(token.refresh_token);
  }

  /**
   * 记录成功请求
   */
  recordSuccess(token) {
    if (!token) return;
    const stats = this.initStats(token);
    if (!stats) return;

    stats.totalRequests++;
    stats.successCount++;
    stats.lastUsedTime = Date.now();
    stats.lastError = null; // 成功后清除错误记录
    stats.status = 'active';
    stats.cooldownUntil = null; // 成功后清除冷却时间
    stats.consecutive429Count = 0; // 成功后重置连续 429 计数
  }

  /**
   * 记录失败请求
   */
  recordFailure(token, error) {
    if (!token) return;
    const stats = this.initStats(token);
    if (!stats) return;

    stats.totalRequests++;
    stats.failureCount++;
    stats.lastUsedTime = Date.now();
    stats.lastError = {
      statusCode: error.statusCode || null,
      message: error.message || String(error),
      timestamp: Date.now(),
      isNetworkError: error.isNetworkError || false  // 保存网络错误标记
    };

    // 根据错误类型设置状态
    if (error.statusCode === 429) {
      stats.status = 'rate_limited';
      stats.consecutive429Count = (stats.consecutive429Count || 0) + 1;

      // 记录冷却时间（从错误响应中提取）
      // 注意：error.retryAfter 已经是毫秒为单位
      if (error.retryAfter && typeof error.retryAfter === 'number') {
        stats.cooldownUntil = Date.now() + error.retryAfter;
      } else {
        // 如果没有提供冷却时间，使用固定延迟
        // 让轮询机制自然切换到其他 token，而不是指数退避
        stats.cooldownUntil = Date.now() + 2000; // 固定 2 秒
      }
    } else if (error.statusCode === 401 || error.statusCode === 403) {
      stats.status = 'disabled';
      stats.cooldownUntil = null; // 被禁用的 token 不需要冷却时间
      stats.consecutive429Count = 0;
    } else {
      // 其他错误，清除冷却时间
      stats.cooldownUntil = null;
      stats.consecutive429Count = 0;
    }
  }

  /**
   * 记录 token 刷新
   */
  recordRefresh(token) {
    if (!token) return;
    const stats = this.initStats(token);
    if (!stats) return;

    stats.refreshCount++;
  }

  /**
   * 重置所有 token 的每日统计数据
   */
  resetDailyStats() {
    log.info('🔄 执行每日统计重置...');
    let resetCount = 0;

    this.stats.forEach((stats, tokenKey) => {
      // 重置每日统计数据
      stats.totalRequests = 0;
      stats.successCount = 0;
      stats.failureCount = 0;
      // 保留：lastUsedTime, lastError, status, cooldownUntil, consecutive429Count, refreshCount
      resetCount++;
    });

    log.info(`✓ 已重置 ${resetCount} 个 token 的每日统计数据`);
  }

  /**
   * 计划每日0点重置统计数据
   */
  scheduleDailyReset() {
    // 清除旧的定时器（如果存在）
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer);
      this.dailyResetTimer = null;
    }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0); // 设置为明天0点

    const msUntilMidnight = tomorrow - now;

    log.info(`📅 每日统计重置已计划，将在 ${tomorrow.toLocaleString('zh-CN')} 执行（${Math.round(msUntilMidnight / 1000 / 60)} 分钟后）`);

    // 保存定时器 ID，方便清理
    this.dailyResetTimer = setTimeout(() => {
      this.resetDailyStats();
      // 重置后，重新计划下一次（避免时间漂移）
      this.scheduleDailyReset();
    }, msUntilMidnight);
  }

  /**
   * 停止每日重置定时器
   */
  stopDailyReset() {
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer);
      this.dailyResetTimer = null;
      log.info('⏹️ 已停止每日统计重置定时任务');
    }
  }

  /**
   * 获取可用 token 数量
   */
  getTokenCount() {
    return this.tokens.length;
  }

  /**
   * 获取 token 的活跃请求数
   * 使用 refresh_token 作为键，因为 access_token 会在刷新时改变
   */
  getActiveCount(token) {
    if (!token || !token.refresh_token) return 0;
    return this.activeRequests.get(token.refresh_token) || 0;
  }

  /**
   * 增加 token 的活跃请求计数
   */
  incrementActive(token) {
    if (!token || !token.refresh_token) return;
    const current = this.getActiveCount(token);
    this.activeRequests.set(token.refresh_token, current + 1);
  }

  /**
   * 释放 token（请求完成后调用）
   */
  releaseToken(token) {
    if (!token || !token.refresh_token) return;
    const current = this.getActiveCount(token);
    if (current > 0) {
      this.activeRequests.set(token.refresh_token, current - 1);
    }
  }

  /**
   * 获取所有 token 的负载状态
   */
  getLoadStatus() {
    return this.tokens.map((t, i) => ({
      index: i,
      active: this.getActiveCount(t)
    }));
  }

  /**
   * 获取所有 token 的统计信息（用于监控界面）
   */
  getAllStats() {
    const allTokens = [];

    // 读取所有 token（包括已禁用的）
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const tokenArray = JSON.parse(data);

      tokenArray.forEach((token, index) => {
        const stats = this.stats.get(token.refresh_token) || {
          totalRequests: 0,
          successCount: 0,
          failureCount: 0,
          lastUsedTime: null,
          lastError: null,
          refreshCount: 0,
          status: token.enable === false ? 'disabled' : 'idle',
          cooldownUntil: null,
          consecutive429Count: 0
        };

        // 计算成功率
        const successRate = stats.totalRequests > 0
          ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
          : '0.0';

        // 检查冷却是否已过期
        const now = Date.now();
        const isCoolingDown = stats.cooldownUntil && stats.cooldownUntil > now;
        const cooldownRemaining = isCoolingDown ? stats.cooldownUntil - now : 0;

        // 获取 token 状态（优先级：disabled > active > rate_limited > idle）
        let status = stats.status;
        if (token.enable === false) {
          status = 'disabled';
        } else if (this.getActiveCount(token) > 0) {
          status = 'active';
        } else if (isCoolingDown) {
          // 正在冷却中，显示限流状态
          status = 'rate_limited';
        } else if (stats.status === 'rate_limited') {
          // 冷却已过期，但状态还是 rate_limited，恢复为 idle
          status = 'idle';
        }

        // 计算最后状态（基于最后一次操作的结果）
        let lastStatus = 'unknown';
        let lastStatusText = '-';
        if (stats.totalRequests === 0) {
          lastStatus = 'unused';
          lastStatusText = '未使用';
        } else if (stats.lastError) {
          // 有错误记录，判断错误类型
          const errorCode = stats.lastError.statusCode;

          // 优先检查网络错误（可能没有statusCode）
          if (stats.lastError.isNetworkError) {
            lastStatus = 'network_error';
            lastStatusText = '网络错误';
          } else if (errorCode === 429) {
            lastStatus = 'rate_limited';
            lastStatusText = '限流(429)';
          } else if (errorCode === 401 || errorCode === 403) {
            lastStatus = 'auth_failed';
            lastStatusText = `认证失败(${errorCode})`;
          } else if (errorCode && errorCode >= 500 && errorCode < 600) {
            lastStatus = 'server_error';
            lastStatusText = `服务器错误(${errorCode})`;
          } else if (errorCode) {
            lastStatus = 'error';
            lastStatusText = `错误(${errorCode})`;
          } else {
            // 没有statusCode的错误
            lastStatus = 'error';
            lastStatusText = '错误';
          }
        } else {
          // 没有错误记录，最后一次是成功的
          lastStatus = 'success';
          lastStatusText = '成功';
        }

        allTokens.push({
          id: `token_${index}`,
          index: index,
          // 隐藏敏感信息，只显示部分
          tokenPreview: token.refresh_token ? `${token.refresh_token.substring(0, 10)}...` : 'N/A',
          enabled: token.enable !== false,
          activeRequests: this.getActiveCount(token),
          totalRequests: stats.totalRequests,
          successCount: stats.successCount,
          failureCount: stats.failureCount,
          successRate: successRate,
          refreshCount: stats.refreshCount,
          lastUsedTime: stats.lastUsedTime,
          lastError: stats.lastError,
          lastStatus: lastStatus,           // 最后状态类型
          lastStatusText: lastStatusText,   // 最后状态文本
          status: status,
          expiresAt: token.timestamp && token.expires_in
            ? token.timestamp + (token.expires_in * 1000)
            : null,
          cooldownUntil: stats.cooldownUntil, // 冷却结束时间戳
          cooldownRemaining: cooldownRemaining, // 剩余冷却时间（毫秒）
          consecutive429Count: stats.consecutive429Count || 0, // 连续 429 失败次数
          remark: token.remark || '' // 备注（从accounts.json读取）
        });
      });
    } catch (error) {
      log.error('读取统计信息失败:', error.message);
    }

    return {
      tokens: allTokens,
      summary: {
        total: allTokens.length,
        enabled: allTokens.filter(t => t.enabled).length,
        disabled: allTokens.filter(t => !t.enabled).length,
        active: allTokens.filter(t => t.activeRequests > 0).length,
        totalRequests: allTokens.reduce((sum, t) => sum + t.totalRequests, 0),
        totalSuccess: allTokens.reduce((sum, t) => sum + t.successCount, 0),
        totalFailure: allTokens.reduce((sum, t) => sum + t.failureCount, 0)
      }
    };
  }

  loadTokens() {
    try {
      log.info('正在加载token...');
      const data = fs.readFileSync(this.filePath, 'utf8');
      let tokenArray = JSON.parse(data);
      let needSave = false;

      // 为每个token添加projectId（如果没有）
      // projectId会持久化到accounts.json，确保每个token有固定的项目ID
      tokenArray = tokenArray.map(token => {
        if (!token.projectId) {
          token.projectId = generateProjectId();
          needSave = true;
          log.info(`为token生成projectId: ${token.projectId}`);
        }
        return token;
      });

      // 如果有新生成的projectId，保存到文件
      // 注意：这个写入只在首次启动时发生，不会有并发问题
      if (needSave) {
        fs.writeFileSync(this.filePath, JSON.stringify(tokenArray, null, 2), 'utf8');
        log.info('已保存projectId到accounts.json');
      }

      // 过滤启用的token，并为每个token生成sessionId（内存中）
      // sessionId每次启动时重新生成，不持久化
      this.tokens = tokenArray
        .filter(token => token.enable !== false)
        .map(token => ({
          ...token,
          sessionId: generateSessionId() // 每次启动生成新的sessionId
        }));

      this.currentIndex = 0;
      log.info(`成功加载 ${this.tokens.length} 个可用token`);
    } catch (error) {
      log.error('加载token失败:', error.message);
      this.tokens = [];
    }
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    let response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Length': body.toString().length.toString(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        body: body.toString()
      });
    } catch (networkError) {
      // 网络错误（DNS解析失败、连接超时等）
      throw {
        statusCode: null,
        message: `网络错误: ${networkError.message}`,
        retryAfter: null,
        isNetworkError: true
      };
    }

    if (response.ok) {
      const data = await response.json();
      token.access_token = data.access_token;
      token.expires_in = data.expires_in;
      token.timestamp = Date.now();
      this.recordRefresh(token); // 记录刷新
      this.saveToFile();
      return token;
    } else {
      const retryAfter = this.parseRetryAfter(response.headers.get('retry-after'));
      throw {
        statusCode: response.status,
        message: await response.text(),
        retryAfter
      };
    }
  }

  /**
   * 解析 Retry-After 头部
   * @param {string} retryAfter - Retry-After 头部值（秒数或HTTP日期）
   * @returns {number} 等待时间（毫秒）
   */
  parseRetryAfter(retryAfter) {
    if (!retryAfter) return null;

    // 如果是数字（秒数）
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // 如果是HTTP日期格式
    try {
      const retryDate = new Date(retryAfter);
      const now = new Date();
      const diff = retryDate - now;
      return diff > 0 ? diff : null;
    } catch {
      return null;
    }
  }

  /**
   * 计算指数退避等待时间
   * @param {number} retryCount - 当前重试次数
   * @param {number} baseDelay - 基础延迟（毫秒）
   * @param {number} maxDelay - 最大延迟（毫秒）
   * @returns {number} 等待时间（毫秒）
   */
  calculateBackoff(retryCount, baseDelay = 1000, maxDelay = 10000) {
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    // 添加随机抖动（jitter）避免同时重试
    const jitter = Math.random() * 0.3 * delay;
    return Math.floor(delay + jitter);
  }

  /**
   * 等待指定时间
   * @param {number} ms - 等待时间（毫秒）
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 带锁的文件写入操作（防止并发写入冲突）
   * @param {Function} operation - 文件操作函数，接收 allTokens 数组，返回修改后的数组
   * @returns {Promise<boolean>} 操作是否成功
   */
  async writeFileWithLock(operation) {
    // 将新的写入操作加入队列
    this.fileLock = this.fileLock.then(async () => {
      try {
        const data = fs.readFileSync(this.filePath, 'utf8');
        const allTokens = JSON.parse(data);

        // 执行操作
        const modifiedTokens = await operation(allTokens);

        // 写入文件
        fs.writeFileSync(this.filePath, JSON.stringify(modifiedTokens, null, 2), 'utf8');
        return true;
      } catch (error) {
        log.error('文件写入失败:', error.message);
        return false;
      }
    });

    return this.fileLock;
  }

  /**
   * 更新token的备注
   * @param {number} tokenIndex - token索引（从0开始）
   * @param {string} remark - 新的备注内容
   * @returns {Promise<boolean>} 是否更新成功
   */
  async updateRemark(tokenIndex, remark) {
    const success = await this.writeFileWithLock((allTokens) => {
      if (tokenIndex < 0 || tokenIndex >= allTokens.length) {
        log.error(`更新备注失败: 索引 ${tokenIndex} 超出范围`);
        throw new Error('索引超出范围');
      }

      allTokens[tokenIndex].remark = remark;

      // 同步更新内存中的token
      const memToken = this.tokens.find(t => t.refresh_token === allTokens[tokenIndex].refresh_token);
      if (memToken) {
        memToken.remark = remark;
      }

      log.info(`成功更新token ${tokenIndex} 的备注: ${remark}`);
      return allTokens;
    });

    return success;
  }

  async saveToFile() {
    return await this.writeFileWithLock((allTokens) => {
      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) {
          // 从内存token中排除sessionId（不持久化到文件）
          const { sessionId, ...tokenToSave } = memToken;
          allTokens[index] = tokenToSave;
        }
      });

      return allTokens;
    });
  }

  async disableToken(token) {
    log.warn(`禁用token`)
    token.enable = false;
    await this.saveToFile();
    this.loadTokens();
  }

  async getToken() {
    if (this.tokens.length === 0) {
      const error = new Error('没有可用的 token，请运行 npm run login 获取 token');
      error.statusCode = 503;
      throw error;
    }

    // 记录初始token数量，避免循环中数组变化导致问题
    const initialLength = this.tokens.length;
    // 跟踪本次请求中已尝试失败的 token
    const triedTokens = new Set();

    for (let i = 0; i < initialLength; i++) {
      // 检查是否还有可用token
      if (this.tokens.length === 0) {
        const error = new Error('所有 token 已被禁用');
        error.statusCode = 503;
        throw error;
      }

      // 智能分配：选择负载最低的 token（排除已尝试失败的）
      let selectedToken = null;
      let minActive = Infinity;
      let coolingDownCount = 0; // 正在冷却中的 token 数量
      let overloadedCount = 0; // 达到并发上限的 token 数量
      let untriedCount = 0; // 未尝试的 token 数量
      let minCooldownRemaining = Infinity; // 最短冷却剩余时间

      // 获取每个 token 最大并发限制
      const perTokenLimit = config.concurrency?.perTokenConcurrency || 2;

      for (const t of this.tokens) {
        if (triedTokens.has(t.refresh_token)) continue;

        untriedCount++; // 统计未尝试的 token

        // 检查是否正在冷却中
        const stats = this.stats.get(t.refresh_token);
        if (stats?.cooldownUntil && stats.cooldownUntil > Date.now()) {
          coolingDownCount++;
          const cooldownRemaining = stats.cooldownUntil - Date.now();
          minCooldownRemaining = Math.min(minCooldownRemaining, cooldownRemaining);
          continue;
        }

        const active = this.getActiveCount(t);

        // 检查是否达到单个 token 的并发上限
        if (active >= perTokenLimit) {
          overloadedCount++;
          continue; // 跳过已达到并发上限的 token
        }

        if (active < minActive) {
          minActive = active;
          selectedToken = t;
        }
      }

      if (!selectedToken) {
        // 没有可用的 token，判断原因
        if (untriedCount === 0) {
          // 所有 token 都已尝试过但都失败了
          const error = new Error('所有 token 都不可用');
          error.statusCode = 503;
          throw error;
        } else if (coolingDownCount === untriedCount && coolingDownCount > 0) {
          // 所有未尝试的 token 都在冷却中
          const error = new Error('所有 token 都在冷却中，请稍后重试');
          error.statusCode = 429;
          error.retryAfter = Math.ceil(minCooldownRemaining / 1000); // 转换为秒
          throw error;
        } else if (overloadedCount + coolingDownCount === untriedCount && untriedCount > 0) {
          // 所有未尝试的 token 都达到并发上限或正在冷却
          const error = new Error(`所有 token 都已达到并发上限 (每个token最多${perTokenLimit}个并发)`);
          error.statusCode = 503;
          throw error;
        } else {
          // 其他情况（理论上不应该到这里）
          const error = new Error('所有 token 都不可用');
          error.statusCode = 503;
          throw error;
        }
      }

      const token = selectedToken;

      // 立即增加活跃计数，防止并发请求选择同一个 token
      this.incrementActive(token);

      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        // 成功获取token
        return token;
      } catch (error) {
        // 刷新失败，回滚活跃计数
        const current = this.getActiveCount(token);
        if (current > 0) {
          this.activeRequests.set(token.refresh_token, current - 1);
        }

        // 标记此 token 已尝试失败
        triedTokens.add(token.refresh_token);

        const statusCode = error.statusCode;
        const tokenIndex = this.tokens.indexOf(token);

        // 根据状态码分类处理
        if (error.isNetworkError) {
          // 网络错误 - 直接切换到下一个 token
          log.warn(`Token ${tokenIndex} 网络错误，切换到下一个`);
          this.recordFailure(token, error);
        } else if (statusCode === 401) {
          // 401 未授权 - 可能是refresh_token过期，禁用账号
          log.warn(`Token ${tokenIndex} 认证失败(401)，refresh_token可能已过期，禁用账号`);
          this.recordFailure(token, { statusCode, message: error.message });
          this.disableToken(token);
          // disableToken 会重新加载tokens，不需要手动移动索引
          continue;
        } else if (statusCode === 403) {
          // 403 权限不足 - 永久性错误，禁用账号
          log.warn(`Token ${tokenIndex} 无权限(403)，禁用账号`);
          this.recordFailure(token, { statusCode, message: error.message });
          this.disableToken(token);
          // disableToken 会重新加载tokens，不需要手动移动索引
          continue;
        } else if (statusCode === 429) {
          // 429 限流 - 记录失败并设置冷却时间
          log.warn(`Token ${tokenIndex} 遇到限流(429)，切换到下一个`);
          this.recordFailure(token, { statusCode, message: error.message, retryAfter: error.retryAfter });
        } else if (statusCode >= 500 && statusCode < 600) {
          // 5xx 服务器错误 - 直接切换到下一个 token
          log.warn(`Token ${tokenIndex} 遇到服务器错误(${statusCode})，切换到下一个`);
          this.recordFailure(token, { statusCode, message: error.message });
        } else {
          // 其他错误 - 记录并切换
          log.error(`Token ${tokenIndex} 刷新失败(${statusCode || 'unknown'}):`, error.message);
          this.recordFailure(token, { statusCode, message: error.message });
        }

        // 切换到下一个token（非禁用情况）
        if (this.tokens.length > 0) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        }
      }
    }

    // 所有 token 都尝试过但都失败了
    const error = new Error('所有 token 都不可用，请检查账号状态');
    error.statusCode = 503;
    throw error;
  }

  /**
   * 带智能重试的获取Token方法
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise<Object|null>} Token对象或null
   */
  async getTokenWithRetry(maxRetries = null) {
    const retries = maxRetries !== null ? maxRetries : this.maxRetries;
    let retryCount = 0;
    let lastError = null;

    while (retryCount <= retries) {
      try {
        const token = await this.getToken();
        if (retryCount > 0) {
          log.info(`经过 ${retryCount} 次重试后成功获取token`);
        }
        return token;
      } catch (error) {
        lastError = error;
        const statusCode = error.statusCode;

        // 只对特定错误重试（429、5xx、网络错误）
        const isRetryable = error.isNetworkError || statusCode === 429 || (statusCode >= 500 && statusCode < 600);
        if (isRetryable) {
          retryCount++;
          if (retryCount <= retries) {
            const waitTime = error.retryAfter || this.calculateBackoff(retryCount - 1);
            const errorType = error.isNetworkError ? '网络错误' : statusCode;
            log.warn(`第 ${retryCount}/${retries} 次重试(${errorType})，等待 ${Math.round(waitTime/1000)}秒 后重试`);
            await this.sleep(waitTime);
            continue;
          }
        }

        // 不可重试的错误或重试次数耗尽
        throw error;
      }
    }

    throw lastError || new Error('获取Token失败，重试次数已耗尽');
  }

  async disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      await this.disableToken(found);
    }
  }

  /**
   * 处理API请求错误，根据状态码智能处理
   * @param {Object} error - 错误对象
   * @param {string} currentAccessToken - 当前使用的access_token
   * @returns {Promise<Object|null>} 新的Token或null
   */
  async handleRequestError(error, currentAccessToken) {
    const statusCode = error.statusCode;

    // 找到当前token
    const currentToken = this.tokens.find(t => t.access_token === currentAccessToken);

    // 根据状态码分类处理
    if (statusCode === 401 || statusCode === 403) {
      // 401/403 - 认证/权限错误
      log.warn(`API请求遇到${statusCode}错误，禁用当前token`);
      if (currentToken) {
        this.disableToken(currentToken);
      }
      // 尝试获取下一个可用token
      return await this.getTokenWithRetry(1);
    } else if (statusCode === 429) {
      // 429 - 限流错误
      const waitTime = error.retryAfter || this.calculateBackoff(0, 2000, 5000);
      log.warn(`API请求遇到限流(429)，等待 ${Math.round(waitTime/1000)}秒 后切换token`);
      await this.sleep(waitTime);
      // 切换到下一个token
      return await this.getToken();
    } else if (statusCode >= 500 && statusCode < 600) {
      // 5xx - 服务器错误
      const waitTime = this.calculateBackoff(0, 1000, 3000);
      log.warn(`API请求遇到服务器错误(${statusCode})，等待 ${Math.round(waitTime/1000)}秒 后重试`);
      await this.sleep(waitTime);
      // 尝试刷新当前token或切换
      if (currentToken && this.isExpired(currentToken)) {
        try {
          await this.refreshToken(currentToken);
          return currentToken;
        } catch (refreshError) {
          log.warn('刷新失败，切换到下一个token');
          return await this.getToken();
        }
      }
      return currentToken || await this.getToken();
    }

    // 其他错误不处理
    return null;
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
