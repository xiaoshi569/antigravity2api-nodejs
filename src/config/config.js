import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import log from '../utils/logger.js';

// 获取项目根目录的绝对路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const configPath = join(projectRoot, 'config.json');

const defaultConfig = {
  server: { port: 8045, host: '127.0.0.1' },
  api: {
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    host: 'daily-cloudcode-pa.sandbox.googleapis.com',
    userAgent: 'antigravity/1.11.3 windows/amd64'
  },
  defaults: { temperature: 1, top_p: 0.85, top_k: 50, max_tokens: 8096 },
  security: { maxRequestSize: '50mb', apiKey: null },
  retry: {
    maxRetries: 3,
    baseDelay: 1000
  },
  concurrency: {
    maxConcurrent: 10,
    perTokenConcurrency: 2,
    queueLimit: 50,
    timeout: 300000
  },
  imageStorage: {
    maxImages: 10,
    baseUrl: null  // 如果为 null，将自动使用局域网 IP 或 127.0.0.1
  },
  systemInstruction: '你是聊天机器人，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演，也可以提供数学或者代码上的建议',
  thinking: {
    output: 'reasoning_content'
  }
};

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  log.info('✓ 配置文件加载成功');
} catch (error) {
  config = defaultConfig;
  log.warn(`⚠ 配置文件未找到: ${configPath}`);
  log.warn(`错误信息: ${error.message}`);
}

export default config;
