import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export async function generateAssistantResponse(requestBody, callback) {
  const token = await tokenManager.getToken();

  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }

  const url = config.api.url;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Host': config.api.host,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      body: JSON.stringify(requestBody)
    });
  } catch (networkError) {
    // 网络错误（DNS解析失败、连接超时等）
    throw new Error(`网络错误: ${networkError.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const statusCode = response.status;
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;

    // 根据状态码分类处理
    if (statusCode === 401 || statusCode === 403) {
      tokenManager.disableCurrentToken(token);
      throw new Error(`账号认证失败(${statusCode})，已自动禁用。错误详情: ${errorText}`);
    } else if (statusCode === 429) {
      const waitTime = retryAfterMs ? Math.round(retryAfterMs / 1000) : '未知';
      throw new Error(`请求过于频繁(429)，建议等待 ${waitTime} 秒。错误详情: ${errorText}`);
    } else if (statusCode >= 500 && statusCode < 600) {
      throw new Error(`服务器错误(${statusCode})，请稍后重试。错误详情: ${errorText}`);
    } else {
      throw new Error(`API请求失败 (${statusCode}): ${errorText}`);
    }
  }

  logger.debug('开始处理响应流...');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let thinkingMode = false;
  let toolCalls = [];
  let textBuffer = ''; // 缓冲区，用于处理跨 chunk 的标记
  let lineBuffer = ''; // 缓冲区，用于处理跨 chunk 的 SSE 行

  // 处理缓冲区中的文本，检测 <think> 和 </think> 标记
  function processBuffer() {
    while (true) {
      if (!thinkingMode) {
        // 当前不在 thinking 模式，寻找 <think> 开始标记
        const thinkStartIndex = textBuffer.indexOf('<think>');
        if (thinkStartIndex === -1) {
          // 没有找到 <think>，但要保留可能不完整的标记（最后 6 个字符）
          if (textBuffer.length > 6) {
            const safeLength = textBuffer.length - 6;
            const safeText = textBuffer.substring(0, safeLength);
            textBuffer = textBuffer.substring(safeLength);
            if (safeText) {
              logger.debug('输出 text:', safeText.substring(0, 50));
              callback({ type: 'text', content: safeText });
            }
          }
          break;
        } else {
          // 找到 <think>，输出之前的文本，然后切换到 thinking 模式
          const beforeThink = textBuffer.substring(0, thinkStartIndex);
          textBuffer = textBuffer.substring(thinkStartIndex + 7); // 7 = '<think>'.length
          thinkingMode = true;
          logger.debug('检测到 <think>，进入 thinking 模式');
          if (beforeThink) {
            logger.debug('输出 beforeThink (text):', beforeThink.substring(0, 50));
            callback({ type: 'text', content: beforeThink });
          }
        }
      } else {
        // 当前在 thinking 模式，寻找 </think> 结束标记
        const thinkEndIndex = textBuffer.indexOf('</think>');
        if (thinkEndIndex === -1) {
          // 没有找到 </think>，保留可能不完整的标记（最后 7 个字符）
          if (textBuffer.length > 7) {
            const safeLength = textBuffer.length - 7;
            const safeText = textBuffer.substring(0, safeLength);
            textBuffer = textBuffer.substring(safeLength);
            if (safeText) {
              logger.debug('输出 thinking:', safeText.substring(0, 50));
              callback({ type: 'thinking', content: safeText });
            }
          }
          break;
        } else {
          // 找到 </think>，输出 thinking 内容，然后切换回普通模式
          const thinkingContent = textBuffer.substring(0, thinkEndIndex);
          textBuffer = textBuffer.substring(thinkEndIndex + 8); // 8 = '</think>'.length
          thinkingMode = false;
          logger.debug('检测到 </think>，退出 thinking 模式');
          if (thinkingContent) {
            logger.debug('输出 thinkingContent:', thinkingContent.substring(0, 50));
            callback({ type: 'thinking', content: thinkingContent });
          }
        }
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      logger.debug('流读取完成');
      break;
    }

    const chunk = decoder.decode(value);
    // 将新chunk添加到行缓冲区
    lineBuffer += chunk;

    // 按换行符分割，保留最后一个可能不完整的行
    const lineParts = lineBuffer.split('\n');
    lineBuffer = lineParts.pop() || ''; // 保留最后一个不完整的行

    // 只处理完整的行
    const lines = lineParts.filter(line => line.startsWith('data: '));
    logger.debug(`收到 ${lines.length} 行数据`);

    for (const line of lines) {
      const jsonStr = line.slice(6);
      try {
        const data = JSON.parse(jsonStr);
        logger.debug('解析JSON成功，数据结构:', JSON.stringify(data).substring(0, 200));

        const parts = data.response?.candidates?.[0]?.content?.parts;
        if (parts) {
          logger.debug(`处理 ${parts.length} 个 parts`);
          for (const part of parts) {
            logger.debug('处理part:', JSON.stringify(part).substring(0, 100));
            // 方式1: 通过 thought 属性判断（某些模型可能使用）
            if (part.thought === true) {
              logger.debug('检测到 thought=true 的内容');
              // 先处理缓冲区
              if (textBuffer) {
                processBuffer();
              }
              callback({ type: 'thinking', content: part.text || '' });
            }
            // 方式2: 通过文本中的 <think> 标记判断
            else if (part.text !== undefined) {
              logger.debug('添加文本到缓冲区，长度:', part.text.length);
              // 将文本添加到缓冲区
              textBuffer += part.text;
              // 处理缓冲区
              processBuffer();
            } else if (part.functionCall) {
              logger.debug('检测到 functionCall');
              toolCalls.push({
                index: toolCalls.length, // 添加 index 字段，从 0 开始
                id: part.functionCall.id || `call_${Date.now()}_${toolCalls.length}`, // 如果没有 id 则生成一个
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args)
                }
              });
            }
          }
        } else {
          logger.debug('没有找到 parts，完整数据:', JSON.stringify(data));
        }

        // 当遇到 finishReason 时，发送所有收集的工具调用
        if (data.response?.candidates?.[0]?.finishReason && toolCalls.length > 0) {
          callback({ type: 'tool_calls', tool_calls: toolCalls });
          toolCalls = [];
        }
      } catch (e) {
        logger.debug('JSON解析失败:', e.message, '原始数据:', jsonStr.substring(0, 100));
      }
    }
  }

  // 流结束时，处理缓冲区中剩余的内容
  if (textBuffer) {
    logger.debug('处理剩余缓冲区内容，长度:', textBuffer.length);
    // 输出剩余内容，根据当前模式决定类型
    const outputType = thinkingMode ? 'thinking' : 'text';
    logger.debug(`输出剩余内容 (${outputType}):`, textBuffer.substring(0, 50));
    callback({ type: outputType, content: textBuffer });
    textBuffer = '';
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();

  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }

  const response = await fetch(config.api.modelsUrl, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取模型列表失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // 检查响应格式
  if (!data.models || typeof data.models !== 'object') {
    throw new Error('获取模型列表失败: 响应格式无效');
  }

  return {
    object: 'list',
    data: Object.keys(data.models).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    }))
  };
}
