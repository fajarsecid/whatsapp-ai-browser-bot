import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function generateGeminiCliReply({
  command = 'gemini',
  model = '',
  cwd = process.cwd(),
  allowApiKey = false,
  input,
  timeoutMs = 90_000,
  spawnImpl = spawn
}) {
  const prompt = formatGeminiCliPrompt(input);
  const args = buildGeminiCliArgs(model, prompt);
  const executable = resolveGeminiExecutable(command);

  const { stdout, stderr, code, signal } = await runProcess({
    command: executable,
    args,
    input: '',
    cwd,
    allowApiKey,
    timeoutMs,
    spawnImpl
  });

  if (code !== 0) {
    throw new Error(`Gemini CLI failed (${signal || code}): ${stderr || stdout}`.slice(0, 1200));
  }

  const text = stripAnsi(stdout).trim();
  if (!text) {
    throw new Error('Gemini CLI returned an empty response.');
  }

  return text;
}

export function formatGeminiCliPrompt(messages) {
  const systemMessages = messages.filter((message) => message.role === 'developer' || message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'developer' && message.role !== 'system');

  const systemText = systemMessages.map((message) => message.content).join('\n\n').trim();
  const conversationText = conversation
    .map((message) => {
      const speaker = message.role === 'assistant' ? 'Assistant' : 'User';
      return `${speaker}: ${message.content}`;
    })
    .join('\n\n');

  return [
    systemText,
    'Kamu menerima konteks percakapan WhatsApp berikut. Jawab hanya pesan User terakhir. Jangan menjalankan tool, membaca file, atau mengeksekusi perintah.',
    conversationText
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildGeminiCliArgs(model, prompt) {
  const args = [
    '--output-format',
    'text',
    '--approval-mode',
    'default',
    '--skip-trust',
    '-e',
    'none',
    '--prompt',
    prompt
  ];

  if (model) {
    args.push('--model', model);
  }

  return args;
}

function resolveGeminiExecutable(command) {
  if (command !== 'gemini') return command;

  const localBin = fileURLToPath(new URL('../node_modules/.bin/gemini', import.meta.url));
  return existsSync(localBin) ? localBin : command;
}

function runProcess({ command, args, input, cwd, allowApiKey, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: buildGeminiEnv({ allowApiKey }),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectOnce(new Error(`Gemini CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      rejectOnce(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code, signal });
    });

    child.stdin.end(input);

    function rejectOnce(error) {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

function buildGeminiEnv({ allowApiKey }) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    GEMINI_TELEMETRY_ENABLED: process.env.GEMINI_TELEMETRY_ENABLED || 'false'
  };

  if (!allowApiKey) {
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  return env;
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
