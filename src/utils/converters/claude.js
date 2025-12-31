// Claude 格式转换工具 - 使用新的 format 模块逻辑
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import {
    GEMINI_MAX_OUTPUT_TOKENS,
    MIN_SIGNATURE_LENGTH,
    GEMINI_SKIP_SIGNATURE
} from '../../constants/index.js';
import {
    // Thinking utilities
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking,
    // Content converter
    convertRole,
    convertContentToParts,
    // Schema sanitizer
    sanitizeSchema,
    cleanSchemaForGemini,
    // Signature cache
    cacheSignature
} from '../format/index.js';

// ==================== 模型检测函数 ====================

/**
 * Get the model family from model name
 * @param {string} modelName - The model name from the request
 * @returns {'claude' | 'gemini' | 'unknown'} The model family
 */
function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'unknown';
}

/**
 * Check if a model supports thinking/reasoning output
 * @param {string} modelName - The model name from the request
 * @returns {boolean} True if the model supports thinking blocks
 */
function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();
    // Claude thinking models have "thinking" in the name
    if (lower.includes('claude') && lower.includes('thinking')) return true;
    // Gemini thinking models: explicit "thinking" in name, OR gemini version 3+
    if (lower.includes('gemini')) {
        if (lower.includes('thinking')) return true;
        // Check for gemini-3 or higher
        const versionMatch = lower.match(/gemini-(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
    }
    return false;
}

// ==================== 工具转换 ====================

/**
 * Convert Claude tools to Antigravity format with enhanced schema sanitization
 * @param {Array} tools - Claude format tools
 * @param {boolean} isGeminiModel - Whether target is Gemini model
 * @returns {Array} Antigravity format tools
 */
function convertClaudeToolsToAntigravity(tools, isGeminiModel = false) {
    if (!tools || !Array.isArray(tools) || tools.length === 0) {
        return [];
    }

    const functionDeclarations = tools.map((tool, idx) => {
        // Extract name from various possible locations
        const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

        // Extract description
        const description = tool.description || tool.function?.description || tool.custom?.description || '';

        // Extract schema from various possible locations
        const schema = tool.input_schema
            || tool.function?.input_schema
            || tool.function?.parameters
            || tool.custom?.input_schema
            || tool.parameters
            || { type: 'object' };

        // Sanitize schema for general compatibility
        let parameters = sanitizeSchema(schema);

        // For Gemini models, apply additional cleaning for VALIDATED mode
        if (isGeminiModel) {
            parameters = cleanSchemaForGemini(parameters);
        }

        return {
            name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            description: description,
            parameters
        };
    });

    return [{ functionDeclarations }];
}

// ==================== 请求转换 ====================

/**
 * Convert Claude Messages API request to the format expected by Cloud Code
 * Uses the same logic as antigravity-claude-proxy
 *
 * @param {Array} claudeMessages - Claude format messages
 * @param {string} modelName - Model name
 * @param {Object} parameters - Generation parameters
 * @param {Array} claudeTools - Claude format tools
 * @param {string} systemPrompt - System prompt
 * @param {Object} token - Token object with projectId and sessionId
 * @returns {Object} Request body for Cloud Code API
 */
export function generateClaudeRequestBody(claudeMessages, modelName, parameters, claudeTools, systemPrompt, token) {
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    const baseSystem = config.systemInstruction || '';
    const mergedSystem = systemPrompt
        ? (baseSystem ? `${baseSystem}\n\n${systemPrompt}` : systemPrompt)
        : baseSystem;

    if (mergedSystem) {
        googleRequest.systemInstruction = {
            parts: [{ text: mergedSystem }]
        };
    }

    // Add interleaved thinking hint for Claude thinking models with tools
    if (isClaudeModel && isThinking && claudeTools && claudeTools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Apply thinking recovery for Gemini thinking models when needed
    let processedMessages = claudeMessages;
    if (isGeminiModel && isThinking && needsThinkingRecovery(claudeMessages)) {
        console.log('[ClaudeConverter] Applying thinking recovery for Gemini');
        processedMessages = closeToolLoopForThinking(claudeMessages);
    }

    // Convert messages to contents, then filter unsigned thinking blocks
    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];
        let msgContent = msg.content;

        // For assistant messages, process thinking blocks and reorder content
        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            // First, try to restore signatures for unsigned thinking blocks from cache
            msgContent = restoreThinkingSignatures(msgContent);
            // Remove trailing unsigned thinking blocks
            msgContent = removeTrailingThinkingBlocks(msgContent);
            // Reorder: thinking first, then text, then tool_use
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        // SAFETY: Google API requires at least one part per content message
        if (parts.length === 0) {
            console.log('[ClaudeConverter] WARNING: Empty parts array after filtering, adding placeholder');
            parts.push({ text: '' });
        }

        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Filter unsigned thinking blocks for Claude models
    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    // Generation config
    const defaults = config.defaults || {};

    if (parameters.max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = parameters.max_tokens;
    } else if (defaults.max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = defaults.max_tokens;
    }

    if (parameters.temperature !== undefined) {
        googleRequest.generationConfig.temperature = parameters.temperature;
    } else if (defaults.temperature !== undefined) {
        googleRequest.generationConfig.temperature = defaults.temperature;
    }

    if (parameters.top_p !== undefined) {
        googleRequest.generationConfig.topP = parameters.top_p;
    } else if (defaults.top_p !== undefined) {
        googleRequest.generationConfig.topP = defaults.top_p;
    }

    if (parameters.top_k !== undefined) {
        googleRequest.generationConfig.topK = parameters.top_k;
    } else if (defaults.top_k !== undefined) {
        googleRequest.generationConfig.topK = defaults.top_k;
    }

    // Enable thinking for thinking models
    if (isThinking) {
        if (isClaudeModel) {
            // Claude thinking config
            const thinkingConfig = {
                include_thoughts: true
            };

            // Only set thinking_budget if explicitly provided
            const thinkingBudget = parameters.thinking?.budget_tokens || parameters.thinking_budget;
            if (thinkingBudget) {
                thinkingConfig.thinking_budget = thinkingBudget;
                console.log('[ClaudeConverter] Claude thinking enabled with budget:', thinkingBudget);
            } else {
                console.log('[ClaudeConverter] Claude thinking enabled (no budget specified)');
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            // Gemini thinking config (uses camelCase)
            const thinkingBudget = parameters.thinking?.budget_tokens || parameters.thinking_budget || defaults.thinking_budget || 16000;
            const thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: thinkingBudget
            };
            console.log('[ClaudeConverter] Gemini thinking enabled with budget:', thinkingConfig.thinkingBudget);

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        }
    }

    // Convert tools to Google format with enhanced schema sanitization
    if (claudeTools && claudeTools.length > 0) {
        googleRequest.tools = convertClaudeToolsToAntigravity(claudeTools, isGeminiModel);
        console.log('[ClaudeConverter] Tools:', JSON.stringify(googleRequest.tools).substring(0, 300));
    }

    // Cap max tokens for Gemini models
    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        console.log(`[ClaudeConverter] Capping Gemini max_tokens from ${googleRequest.generationConfig.maxOutputTokens} to ${GEMINI_MAX_OUTPUT_TOKENS}`);
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    // Build final request body
    const requestBody = {
        project: token.projectId,
        requestId: generateRequestId(),
        request: {
            contents: googleRequest.contents,
            tools: googleRequest.tools || [],
            toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
            generationConfig: googleRequest.generationConfig,
            sessionId: token.sessionId
        },
        model: modelName,
        userAgent: 'antigravity'
    };

    if (googleRequest.systemInstruction) {
        requestBody.request.systemInstruction = googleRequest.systemInstruction;
    }

    return requestBody;
}
