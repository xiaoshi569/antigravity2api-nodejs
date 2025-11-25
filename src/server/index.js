import express from 'express';
import { generateAssistantResponse, getAvailableModels } from '../api/client.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import { concurrencyLimiter, getQueueStatus } from '../middleware/concurrency.js';
import tokenManager from '../auth/token_manager.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: config.security.maxRequestSize }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.request(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 健康检查和队列状态端点
app.get('/health', (req, res) => {
  const queueStatus = getQueueStatus();
  res.json({
    status: 'ok',
    queue: queueStatus,
    config: {
      maxConcurrent: config.concurrency?.maxConcurrent || 10,
      queueLimit: config.concurrency?.queueLimit || 100,
      timeout: config.concurrency?.timeout || 300000
    }
  });
});

// Token 统计信息端点（用于监控界面）
app.get('/api/stats', (req, res) => {
  try {
    const stats = tokenManager.getAllStats();
    res.json(stats);
  } catch (error) {
    logger.error('获取统计信息失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 提供静态文件服务（监控界面）
app.use(express.static(path.join(__dirname, '../../public')));

// 应用并发控制中间件到 chat completions 端点
app.post('/v1/chat/completions', concurrencyLimiter, async (req, res) => {
  // OpenAI API 默认 stream = false
  const { messages, model, stream = false, tools, ...params} = req.body;
  try {
    // 记录请求体中的异常字段，用于调试 newapi 转发问题
    if (messages) {
      messages.forEach((msg, idx) => {
        if (msg.tool_calls && typeof msg.tool_calls === 'string') {
          logger.warn(`⚠ 消息 [${idx}] tool_calls 是字符串: "${msg.tool_calls}"`);
        }
        if (msg.tools && typeof msg.tools === 'string') {
          logger.warn(`⚠ 消息 [${idx}] tools 是字符串: "${msg.tools}"`);
        }
      });
    }
    if (tools && typeof tools === 'string') {
      logger.warn(`⚠ 请求的 tools 字段是字符串: "${tools}"`);
    }

    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // 直接传递OpenAI参数给generateAssistantResponse
    // 它会在内部获取token并生成requestBody

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;

      const thinkingOutput = config.thinking?.output || 'filter';

      await generateAssistantResponse(messages, model, params, tools, (data) => {
        if (data.type === 'tool_calls') {
          hasToolCall = true;
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
          })}\n\n`);
        } else if (data.type === 'text') {
          // 输出正文内容
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
          })}\n\n`);
        } else if (data.type === 'thinking') {
          // 根据配置决定如何处理思维链
          if (thinkingOutput === 'reasoning_content') {
            // DeepSeek 风格：输出到 reasoning_content 字段
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { reasoning_content: data.content }, finish_reason: null }]
            })}\n\n`);
          } else if (thinkingOutput === 'raw') {
            // 原始格式：思维链也输出到 content
            res.write(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
            })}\n\n`);
          }
          // thinkingOutput === 'filter' 时不输出
        }
      });
      
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      let fullContent = '';
      let reasoningContent = '';
      let toolCalls = [];
      const thinkingOutput = config.thinking?.output || 'filter';

      await generateAssistantResponse(messages, model, params, tools, (data) => {
        if (data.type === 'tool_calls') {
          toolCalls = data.tool_calls;
        } else if (data.type === 'text') {
          fullContent += data.content;
        } else if (data.type === 'thinking') {
          if (thinkingOutput === 'reasoning_content') {
            reasoningContent += data.content;
          } else if (thinkingOutput === 'raw') {
            fullContent += data.content;
          }
          // thinkingOutput === 'filter' 时不累积
        }
      });

      // 构建 message，reasoning_content 放在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) {
        message.reasoning_content = reasoningContent;
      }
      message.content = fullContent;
      if (toolCalls.length > 0) {
        // 非流式模式下移除 index 字段（OpenAI 规范：非流式不包含 index）
        message.tool_calls = toolCalls.map(({ index, ...rest }) => rest);
      }
      
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }]
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);

    // 优先使用错误对象上的 statusCode，否则根据错误消息判断
    let statusCode = error.statusCode || 500;
    if (!error.statusCode) {
      // 向后兼容：根据错误消息判断状态码
      if (error.message.includes('(401)') || error.message.includes('(403)')) {
        statusCode = 401;
      } else if (error.message.includes('(429)')) {
        statusCode = 429;
      } else if (error.message.includes('没有可用的token') || error.message.includes('都不可用')) {
        statusCode = 503;
      }
    }

    if (!res.headersSent) {
      // 如果是 429 错误且有 retryAfter，添加 Retry-After 响应头
      if (statusCode === 429 && error.retryAfter) {
        res.setHeader('Retry-After', error.retryAfter);
      }

      // 错误时统一返回JSON格式，不使用SSE流
      res.status(statusCode).json({
        error: {
          message: error.message,
          type: statusCode === 429 ? 'rate_limit_error' :
                statusCode === 503 ? 'service_unavailable' :
                statusCode === 401 ? 'authentication_error' : 'api_error',
          code: statusCode
        }
      });
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
