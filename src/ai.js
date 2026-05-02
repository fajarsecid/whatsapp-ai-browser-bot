import { generateGeminiCliReply } from './gemini-cli.js';
import { generateOllamaReply } from './ollama.js';
import { generateAiReply as generateOpenAiReply } from './openai.js';
import { generateWebAiReply } from './web-ai.js';

export async function generateReply({ config, input, fetchImpl = fetch }) {
  const provider = config.aiProvider.toLowerCase();

  if (provider === 'web') {
    return generateWebAiReply({
      input,
      service: config.webAiService,
      customUrl: config.webAiUrl,
      includeContext: config.webAiIncludeContext
    });
  }

  if (provider === 'gemini-cli') {
    return generateGeminiCliReply({
      command: config.geminiCliCommand,
      model: config.geminiCliModel,
      cwd: config.geminiCliCwd,
      allowApiKey: config.geminiCliAllowApiKey,
      input,
      timeoutMs: config.requestTimeoutMs
    });
  }

  if (provider === 'ollama') {
    return generateOllamaReply({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      messages: input,
      keepAlive: config.ollamaKeepAlive,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl
    });
  }

  if (provider === 'openai') {
    return generateOpenAiReply({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      input,
      maxOutputTokens: config.openaiMaxOutputTokens,
      timeoutMs: config.requestTimeoutMs,
      fetchImpl
    });
  }

  throw new Error(`Unsupported AI provider: ${config.aiProvider}`);
}
