import PQueue from 'p-queue';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import tokenManager from '../auth/token_manager.js';

// 计算最大并发数
function calculateMaxConcurrent() {
  const maxConcurrent = config.concurrency?.maxConcurrent;
  const perToken = config.concurrency?.perTokenConcurrency || 2;

  if (maxConcurrent === 'auto') {
    const tokenCount = tokenManager.getTokenCount();
    const calculated = tokenCount * perToken;
    // 至少 1 个并发，最多 100 个
    return Math.max(1, Math.min(calculated, 100));
  }

  return maxConcurrent || 10;
}

// 创建请求队列
const initialConcurrency = calculateMaxConcurrent();
const queue = new PQueue({
  concurrency: initialConcurrency,
  timeout: config.concurrency?.timeout || 300000,
  throwOnTimeout: true
});

logger.info(`并发控制初始化: maxConcurrent=${initialConcurrency}, perToken=${config.concurrency?.perTokenConcurrency || 2}`);

// 监控队列状态
let lastLogTime = 0;
const LOG_INTERVAL = 5000; // 每 5 秒最多记录一次

queue.on('active', () => {
  const now = Date.now();
  if (now - lastLogTime > LOG_INTERVAL && queue.pending > 0) {
    logger.info(`并发控制: 活跃 ${queue.size}/${queue.concurrency}, 队列等待 ${queue.pending}`);
    lastLogTime = now;
  }
});

queue.on('idle', () => {
  if (queue.pending === 0) {
    logger.debug('并发队列已清空');
  }
});

/**
 * 并发控制中间件
 * 限制同时处理的请求数量，超出限制的请求会排队等待
 */
export function concurrencyLimiter(req, res, next) {
  const queueLimit = config.concurrency?.queueLimit || 100;

  // 检查队列是否已满
  if (queue.pending >= queueLimit) {
    logger.warn(`请求队列已满 (${queue.pending}/${queueLimit})，拒绝新请求`);
    return res.status(503).json({
      error: {
        message: '服务器繁忙，请稍后重试',
        type: 'queue_full',
        code: 503,
        queue_size: queue.pending
      }
    });
  }

  // 将请求加入队列
  queue.add(async () => {
    return new Promise((resolve) => {
      // 监听响应完成事件，确保无论如何都会释放队列
      // finish: 响应完全发送完成（包括流式响应）
      // close: 连接被关闭（客户端断开等情况）
      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      res.on('finish', safeResolve);
      res.on('close', safeResolve);

      // 继续处理请求
      next();
    });
  }).catch((error) => {
    // 处理超时错误
    if (error.message && error.message.includes('timeout')) {
      logger.error(`请求超时 (${config.concurrency?.timeout}ms): ${req.method} ${req.path}`);
      if (!res.headersSent) {
        res.status(504).json({
          error: {
            message: '请求处理超时',
            type: 'timeout',
            code: 504
          }
        });
      }
    } else {
      logger.error('队列处理错误:', error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: '服务器内部错误',
            type: 'internal_error',
            code: 500
          }
        });
      }
    }
  });
}

/**
 * 获取当前队列状态（用于健康检查等）
 */
export function getQueueStatus() {
  return {
    concurrency: queue.concurrency,
    size: queue.size,
    pending: queue.pending,
    isPaused: queue.isPaused
  };
}
