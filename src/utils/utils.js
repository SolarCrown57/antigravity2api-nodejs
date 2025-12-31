// 通用工具函数
import config from '../config/config.js';
import os from 'os';
import { REASONING_EFFORT_MAP, DEFAULT_STOP_SEQUENCES } from '../constants/index.js';
import { toGenerationConfig } from './parameterNormalizer.js';

// ==================== 工具名称规范化 ====================
export function sanitizeToolName(name) {
  if (!name || typeof name !== 'string') return 'tool';
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  if (!cleaned) cleaned = 'tool';
  if (cleaned.length > 128) cleaned = cleaned.slice(0, 128);
  return cleaned;
}

// ==================== 模型映射 ====================
export function modelMapping(modelName) {
  if (modelName === 'claude-sonnet-4-5-thinking') return 'claude-sonnet-4-5';
  if (modelName === 'claude-opus-4-5') return 'claude-opus-4-5-thinking';
  if (modelName === 'gemini-2.5-flash-thinking') return 'gemini-2.5-flash';
  return modelName;
}

export function isEnableThinking(modelName) {
  return modelName.includes('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === 'rev19-uic3-1p' ||
    modelName === 'gpt-oss-120b-medium';
}

// ==================== 生成配置 ====================
export function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  // 使用 config.defaults 兜底
  const normalizedParams = {
    temperature: parameters.temperature ?? config.defaults.temperature,
    top_p: parameters.top_p ?? config.defaults.top_p,
    top_k: parameters.top_k ?? config.defaults.top_k,
    max_tokens: parameters.max_tokens ?? config.defaults.max_tokens,
    thinking_budget: parameters.thinking_budget,
  };

  // 处理 reasoning_effort 到 thinking_budget 的转换
  if (normalizedParams.thinking_budget === undefined && parameters.reasoning_effort !== undefined) {
    const defaultThinkingBudget = config.defaults.thinking_budget ?? 1024;
    normalizedParams.thinking_budget = REASONING_EFFORT_MAP[parameters.reasoning_effort] ?? defaultThinkingBudget;
  }

  // 使用统一的参数转换函数
  const generationConfig = toGenerationConfig(normalizedParams, enableThinking, actualModelName);
  
  // 添加 stopSequences
  generationConfig.stopSequences = DEFAULT_STOP_SEQUENCES;
  
  return generationConfig;
}

// ==================== System 指令提取 ====================
export function extractSystemInstruction(openaiMessages) {
  const baseSystem = config.systemInstruction || '';
  if (!config.useContextSystemPrompt) return baseSystem;

  const systemTexts = [];
  for (const message of openaiMessages) {
    if (message.role === 'system') {
      const content = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content)
            ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
            : '');
      if (content.trim()) systemTexts.push(content.trim());
    } else {
      break;
    }
  }

  const parts = [];
  if (baseSystem.trim()) parts.push(baseSystem.trim());
  if (systemTexts.length > 0) parts.push(systemTexts.join('\n\n'));
  return parts.join('\n\n');
}

// ==================== 图片请求准备 ====================
export function prepareImageRequest(requestBody) {
  if (!requestBody || !requestBody.request) return requestBody;
  let imageSize = "1K";
  if (requestBody.model.includes('4K')){
    imageSize = "4K";
  } else if (requestBody.model.includes('2K')){
    imageSize = "2K";
  } else {
    imageSize = "1K";
  }
  if (imageSize !== "1K"){
    requestBody.model = requestBody.model.slice(0, -3);
  }
  requestBody.request.generationConfig = { 
    candidateCount: 1,
    imageConfig: {
      imageSize: imageSize
    }
  };
  requestBody.requestType = 'image_gen';
  delete requestBody.request.systemInstruction;
  delete requestBody.request.tools;
  delete requestBody.request.toolConfig;
  return requestBody;
}

// ==================== 其他工具 ====================
export function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN) {
    for (const inter of interfaces.WLAN) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}

// 重导出主要函数
export { generateRequestId } from './idGenerator.js';
export { generateRequestBody } from './converters/openai.js';
export { generateClaudeRequestBody } from './converters/claude.js';
export { generateGeminiRequestBody } from './converters/gemini.js';
