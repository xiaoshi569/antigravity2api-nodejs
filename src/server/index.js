import express from 'express';
import { generateAssistantResponse, getAvailableModels } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

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

app.post('/v1/chat/completions', async (req, res) => {
  // OpenAI API 默认 stream = false
  const { messages, model, stream = false, tools, ...params} = req.body;
  try {
    
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    
    const requestBody = generateRequestBody(messages, model, params, tools);
    //console.log(JSON.stringify(requestBody,null,2));
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;
      
      const thinkingOutput = config.thinking?.output || 'filter';

      await generateAssistantResponse(requestBody, (data) => {
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

      await generateAssistantResponse(requestBody, (data) => {
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
        message.tool_calls = toolCalls;
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

    // 根据错误消息判断状态码
    let statusCode = 500;
    if (error.message.includes('(401)') || error.message.includes('(403)')) {
      statusCode = 401;
    } else if (error.message.includes('(429)')) {
      statusCode = 429;
    } else if (error.message.includes('没有可用的token')) {
      statusCode = 503; // Service Unavailable
    }

    if (!res.headersSent) {
      // 错误时统一返回JSON格式，不使用SSE流
      res.status(statusCode).json({
        error: {
          message: error.message,
          type: 'api_error',
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
