import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export async function generateAssistantResponse(requestBody, callback, retryCount = 0) {
  const maxRetries = config.retry?.maxRetries ?? 3;
  const baseDelay = config.retry?.baseDelay ?? 1000;
  const token = await tokenManager.getToken(); // 如果没有可用token，会抛出带 statusCode 的错误

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
    // 网络错误（连接超时、网络中断等）- 直接切换 token 重试
    tokenManager.recordFailure(token, { message: networkError.message, isNetworkError: true });
    if (retryCount < maxRetries) {
      logger.warn(`网络错误(${networkError.message})，切换token重试 (${retryCount + 1}/${maxRetries})`);
      tokenManager.releaseToken(token); // 递归前释放
      return generateAssistantResponse(requestBody, callback, retryCount + 1);
    }
    // 重试耗尽，不释放，让 finally 处理
    throw new Error(`网络错误，重试次数已耗尽: ${networkError.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const statusCode = response.status;
    const retryAfter = response.headers.get('retry-after');
    let retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;

    // 尝试从错误响应中提取冷却时间（Google API 格式）
    if (statusCode === 429 && !retryAfterMs) {
      try {
        const errorJson = JSON.parse(errorText);

        // 方法1：从 RetryInfo 中获取 retryDelay（格式: "1514.089089842s"）
        const retryInfo = errorJson?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
        if (retryInfo?.retryDelay) {
          const match = retryInfo.retryDelay.match(/([\d.]+)s/);
          if (match) {
            const seconds = parseFloat(match[1]);
            retryAfterMs = seconds * 1000;
          }
        }

        // 方法2：从 ErrorInfo 的 metadata 中获取 quotaResetDelay（格式: "25m14.089089842s"）
        if (!retryAfterMs) {
          const errorInfo = errorJson?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
          const quotaResetDelay = errorInfo?.metadata?.quotaResetDelay;
          if (quotaResetDelay) {
            const match = quotaResetDelay.match(/(\d+)m([\d.]+)s/);
            if (match) {
              const minutes = parseInt(match[1]);
              const seconds = parseFloat(match[2]);
              retryAfterMs = (minutes * 60 + seconds) * 1000;
            }
          }
        }
      } catch (e) {
        // 忽略 JSON 解析错误
      }
    }

    // 根据状态码分类处理
    if (statusCode === 401 || statusCode === 403) {
      tokenManager.recordFailure(token, { statusCode, message: errorText });
      tokenManager.disableCurrentToken(token);
      // 不释放 token，让 finally 统一处理
      throw new Error(`账号认证失败(${statusCode})，已自动禁用。错误详情: ${errorText}`);
    } else if (statusCode === 429) {
      // 429 限流 - 直接切换 token 重试（不等待，让 getToken 自动跳过冷却中的 token）
      tokenManager.recordFailure(token, { statusCode, message: errorText, retryAfter: retryAfterMs });
      if (retryCount < maxRetries) {
        logger.warn(`请求限流(429)，切换token重试 (${retryCount + 1}/${maxRetries})`);
        tokenManager.releaseToken(token); // 递归前释放
        return generateAssistantResponse(requestBody, callback, retryCount + 1);
      }
      // 重试耗尽，不释放，让 finally 处理
      throw new Error(`请求过于频繁(429)，重试次数已耗尽。错误详情: ${errorText}`);
    } else if (statusCode >= 500 && statusCode < 600) {
      // 5xx 服务器错误 - 直接切换 token 重试
      tokenManager.recordFailure(token, { statusCode, message: errorText });
      if (retryCount < maxRetries) {
        logger.warn(`服务器错误(${statusCode})，切换token重试 (${retryCount + 1}/${maxRetries})`);
        tokenManager.releaseToken(token); // 递归前释放
        return generateAssistantResponse(requestBody, callback, retryCount + 1);
      }
      // 重试耗尽，不释放，让 finally 处理
      throw new Error(`服务器错误(${statusCode})，重试次数已耗尽。错误详情: ${errorText}`);
    } else {
      tokenManager.recordFailure(token, { statusCode, message: errorText });
      // 不释放，让 finally 处理
      throw new Error(`API请求失败 (${statusCode}): ${errorText}`);
    }
  }

  logger.debug('开始处理响应流...');

  let streamSuccess = false; // 标记流是否成功处理完成
  try {
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
              logger.debug('检测到 functionCall:', JSON.stringify(part.functionCall).substring(0, 200));
              // 将 thought_signature 编码到 id 中，格式: id::thought_signature
              // 兼容 thoughtSignature 和 thought_signature 两种字段名
              const baseId = part.functionCall.id || `call_${Date.now()}_${toolCalls.length}`;
              const thoughtSig = part.functionCall.thoughtSignature || part.functionCall.thought_signature || '';
              const encodedId = thoughtSig ? `${baseId}::${thoughtSig}` : baseId;

              toolCalls.push({
                index: toolCalls.length, // 添加 index 字段，从 0 开始
                id: encodedId,
                type: 'function',
                function: {
                  name: part.functionCall.name || 'unknown',
                  arguments: JSON.stringify(part.functionCall.args || {})
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

  // 成功完成请求，记录统计
  streamSuccess = true;
  tokenManager.recordSuccess(token);
  } catch (streamError) {
    // 流处理过程中的错误
    logger.error('流处理失败:', streamError.message);
    tokenManager.recordFailure(token, { message: streamError.message, isStreamError: true });
    throw streamError; // 重新抛出错误
  } finally {
    // 请求完成，释放 token（确保无论成功或异常都会释放）
    tokenManager.releaseToken(token);
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken(); // 如果没有可用token，会抛出带 statusCode 的错误

  try {
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
  } finally {
    tokenManager.releaseToken(token);
  }
}
