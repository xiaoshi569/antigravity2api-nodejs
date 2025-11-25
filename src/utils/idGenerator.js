import { randomUUID } from 'crypto';

/**
 * 生成请求ID
 * 格式: agent-{uuid}
 * 每次请求都生成新的ID
 */
function generateRequestId() {
  return `agent-${randomUUID()}`;
}

/**
 * 生成会话ID
 * 格式: 负数大整数
 * 每个token每次启动时生成一个固定的sessionId（内存中）
 */
function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

/**
 * 生成项目ID
 * 格式: {adjective}-{noun}-{random}
 * 每个token固定一个projectId（持久化到accounts.json）
 */
function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}

export {
  generateProjectId,
  generateSessionId,
  generateRequestId
};
