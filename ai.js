/**
 * Connect AI — server-side only. User never sees provider names.
 * Env: GEMINI_API_KEY | OPENAI_API_KEY | XAI_API_KEY, AI_PROVIDER=gemini|openai|xai
 */
import express from 'express';
import { rateLimit as memLimit } from './scale.js';

const router = express.Router();

const SYSTEM_PROMPTS = {
  chat: `You are Connect AI, the built-in assistant inside the Connect messaging app.
Be helpful, clear, and concise. Match a modern chat tone.
Never say you are Gemini, ChatGPT, Grok, OpenAI, Google, or xAI.
If asked who you are, say you are Connect AI.`,
  study: `You are Connect AI in Study Helper mode.
Explain concepts clearly, step by step. Use simple language.
Never mention underlying model providers.`,
  code: `You are Connect AI in Code Assistant mode.
Help with programming: explain, debug, write clean code.
Never mention underlying model providers.`,
};

function aiRateLimit(req, res, next) {
  const uid = req.userId || req.user?.id || req.ip;
  const r = memLimit(`ai:${uid}`, { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!r.ok) {
    return res.status(429).json({
      error: 'AI limit reached. Try again later.',
      code: 'AI_RATE_LIMIT',
      retryAfterMs: r.retryAfterMs,
    });
  }
  next();
}

async function callGemini(messages, system) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('NO_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: String(m.content || '') }] });
  }
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ||
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    '';
  if (!text.trim()) throw new Error('Empty AI response');
  return text.trim();
}

async function callOpenAI(messages, system) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('NO_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI error ${res.status}`);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('Empty AI response');
  return text.trim();
}

async function callXai(messages, system) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('NO_KEY');
  const model = process.env.XAI_MODEL || 'grok-2-latest';
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `xAI error ${res.status}`);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('Empty AI response');
  return text.trim();
}

async function generateReply(feature, messages) {
  const system = SYSTEM_PROMPTS[feature] || SYSTEM_PROMPTS.chat;
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  const order =
    provider === 'openai'
      ? ['openai', 'gemini', 'xai']
      : provider === 'xai'
        ? ['xai', 'gemini', 'openai']
        : ['gemini', 'openai', 'xai'];
  let lastErr = null;
  for (const p of order) {
    try {
      if (p === 'gemini' && process.env.GEMINI_API_KEY) return await callGemini(messages, system);
      if (p === 'openai' && process.env.OPENAI_API_KEY) return await callOpenAI(messages, system);
      if (p === 'xai' && process.env.XAI_API_KEY) return await callXai(messages, system);
    } catch (e) {
      if (e?.message === 'NO_KEY') continue;
      lastErr = e;
      console.error(`[ai] ${p} failed:`, e?.message || e);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('NO_KEY');
}

router.post('/chat', aiRateLimit, async (req, res) => {
  try {
    const feature = String(req.body?.feature || 'chat').toLowerCase();
    if (!['chat', 'study', 'code'].includes(feature)) {
      return res.status(400).json({ error: 'Invalid feature', code: 'BAD_FEATURE' });
    }
    let messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    messages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-20)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Send a user message', code: 'NO_MESSAGE' });
    }
    const reply = await generateReply(feature, messages);
    return res.status(200).json({
      success: true,
      data: { message: { role: 'assistant', content: reply } },
    });
  } catch (err) {
    console.error('[ai] chat error:', err?.message || err);
    if (err?.message === 'NO_KEY') {
      return res.status(503).json({
        error: 'Connect AI is not configured yet. Add GEMINI_API_KEY on the server.',
        code: 'AI_NOT_CONFIGURED',
      });
    }
    return res.status(502).json({
      error: 'Connect AI is temporarily unavailable. Try again.',
      code: 'AI_UPSTREAM',
    });
  }
});

router.get('/status', async (req, res) => {
  const ready = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.XAI_API_KEY);
  res.json({ success: true, data: { ready, features: ['chat', 'study', 'code'] } });
});

export default router;
