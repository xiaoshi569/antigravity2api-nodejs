import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

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
    this.loadTokens();
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
    return this.activeRequests.get(token.refresh_token) || 0;
  }

  /**
   * 增加 token 的活跃请求计数
   */
  incrementActive(token) {
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

  loadTokens() {
    try {
      log.info('正在加载token...');
      const data = fs.readFileSync(this.filePath, 'utf8');
      const tokenArray = JSON.parse(data);
      this.tokens = tokenArray.filter(token => token.enable !== false);
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

  saveToFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) allTokens[index] = memToken;
      });
      
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  disableToken(token) {
    log.warn(`禁用token`)
    token.enable = false;
    this.saveToFile();
    this.loadTokens();
  }

  async getToken() {
    if (this.tokens.length === 0) return null;

    // 记录初始token数量，避免循环中数组变化导致问题
    const initialLength = this.tokens.length;
    // 跟踪本次请求中已尝试失败的 token
    const triedTokens = new Set();

    for (let i = 0; i < initialLength; i++) {
      // 检查是否还有可用token
      if (this.tokens.length === 0) return null;

      // 智能分配：选择负载最低的 token（排除已尝试失败的）
      let selectedToken = null;
      let minActive = Infinity;

      for (const t of this.tokens) {
        if (triedTokens.has(t.refresh_token)) continue;
        const active = this.getActiveCount(t);
        if (active < minActive) {
          minActive = active;
          selectedToken = t;
        }
      }

      if (!selectedToken) {
        // 所有 token 都尝试过了
        return null;
      }

      const token = selectedToken;

      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        // 成功获取token，增加活跃计数
        this.incrementActive(token);
        return token;
      } catch (error) {
        // 标记此 token 已尝试失败
        triedTokens.add(token.refresh_token);

        const statusCode = error.statusCode;
        const tokenIndex = this.tokens.indexOf(token);

        // 根据状态码分类处理
        if (error.isNetworkError) {
          // 网络错误 - 暂时性错误，等待后切换
          const waitTime = this.calculateBackoff(0, 1000, 3000);
          log.warn(`Token ${tokenIndex} 网络错误，等待 ${Math.round(waitTime/1000)}秒 后切换到下一个`);
          await this.sleep(waitTime);
        } else if (statusCode === 401) {
          // 401 未授权 - 可能是refresh_token过期，禁用账号
          log.warn(`Token ${tokenIndex} 认证失败(401)，refresh_token可能已过期，禁用账号`);
          this.disableToken(token);
          // disableToken 会重新加载tokens，不需要手动移动索引
          continue;
        } else if (statusCode === 403) {
          // 403 权限不足 - 永久性错误，禁用账号
          log.warn(`Token ${tokenIndex} 无权限(403)，禁用账号`);
          this.disableToken(token);
          // disableToken 会重新加载tokens，不需要手动移动索引
          continue;
        } else if (statusCode === 429) {
          // 429 限流 - 暂时性错误，等待后继续
          const waitTime = error.retryAfter || this.calculateBackoff(0, 2000, 5000);
          log.warn(`Token ${tokenIndex} 遇到限流(429)，等待 ${Math.round(waitTime/1000)}秒 后切换到下一个`);
          await this.sleep(waitTime);
        } else if (statusCode >= 500 && statusCode < 600) {
          // 5xx 服务器错误 - 暂时性错误，短暂等待后切换
          const waitTime = this.calculateBackoff(0, 500, 2000);
          log.warn(`Token ${tokenIndex} 遇到服务器错误(${statusCode})，等待 ${Math.round(waitTime/1000)}秒 后切换`);
          await this.sleep(waitTime);
        } else {
          // 其他错误 - 记录并切换
          log.error(`Token ${tokenIndex} 刷新失败(${statusCode || 'unknown'}):`, error.message);
        }

        // 切换到下一个token（非禁用情况）
        if (this.tokens.length > 0) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        }
      }
    }

    return null;
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
        if (token) {
          if (retryCount > 0) {
            log.info(`经过 ${retryCount} 次重试后成功获取token`);
          }
          return token;
        }

        // getToken返回null，检查是否还有可用token
        if (this.tokens.length === 0) {
          throw new Error('所有token都已被禁用');
        }

        // 有token但获取失败，增加重试次数避免无限循环
        retryCount++;
        if (retryCount <= retries) {
          const waitTime = this.calculateBackoff(retryCount - 1);
          log.warn(`获取token失败，等待 ${Math.round(waitTime/1000)}秒 后进行第 ${retryCount}/${retries} 次重试`);
          await this.sleep(waitTime);
        }
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

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
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
