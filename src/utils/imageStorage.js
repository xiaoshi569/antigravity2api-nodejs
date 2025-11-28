import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import { getDefaultIp } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_DIR = path.join(__dirname, '../../public/images');

// 确保图片目录存在
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// MIME 类型到文件扩展名映射
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/**
 * 清理超过限制数量的旧图片
 * @param {number} maxCount - 最大保留图片数量
 */
function cleanOldImages(maxCount = 10) {
  const files = fs.readdirSync(IMAGE_DIR)
    .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
    .map(f => ({
      name: f,
      path: path.join(IMAGE_DIR, f),
      mtime: fs.statSync(path.join(IMAGE_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > maxCount) {
    files.slice(maxCount).forEach(f => fs.unlinkSync(f.path));
  }
}

/**
 * 保存 base64 图片到本地并返回访问 URL
 * @param {string} base64Data - base64 编码的图片数据
 * @param {string} mimeType - 图片 MIME 类型
 * @returns {string} 图片访问 URL
 */
export function saveBase64Image(base64Data, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || 'jpg';
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
  const filepath = path.join(IMAGE_DIR, filename);
  
  // 解码并保存
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filepath, buffer);
  
  // 清理旧图片
  cleanOldImages(config.imageStorage?.maxImages || 10);

  // 返回访问 URL
  const baseUrl = config.imageStorage?.baseUrl || `http://${getDefaultIp()}:${config.server.port}`;
  return `${baseUrl}/images/${filename}`;
}
