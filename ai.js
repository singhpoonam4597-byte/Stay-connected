/**
 * Connect AI — server-side only. User never sees provider names.
 *
 * Env (Render):
 *   GROQ_API_KEY     preferred (free tier)
 *   GROQ_MODEL       optional (default: openai/gpt-oss-20b)
 *   GEMINI_API_KEY   optional
 *   OPENAI_API_KEY   optional
 *   XAI_API_KEY      optional
 *   AI_PROVIDER      groq | gemini | openai | xai  (default: groq)
 */

import express from 'express';
import { rateLimit as memLimit } from './scale.js';

const router = express.Router();

const SYSTEM_PROMPTS = {
  chat: `You are Connect AI — the built-in assistant inside the Connect messaging app.
Be helpful, sharp, and concise. Write like a capable product assistant, not a chatbot script.
Use short paragraphs. Prefer practical answers. Ask a clarifying question only when needed.
Never reveal or name underlying models or providers (not Gemini, ChatGPT, Grok, Groq, Llama, OpenAI, Google, or xAI).
If asked who you are, say you are Connect AI, the assistant inside Connect.
You may help with writing messages, planning, general knowledge, and product questions about Connect (messaging, privacy settings, groups).`,

  study: `You are Connect AI in Study Helper mode.
Teach clearly: break ideas into steps, use simple language, give one example when it helps.
Prefer understanding over dumping long walls of text. End with a short check question when useful.
Never mention underlying model providers. You are Connect AI.`,

  code: `You are Connect AI in Code Assistant mode.
Help with programming: explain, debug, and write clean, modern code.
Prefer correct, minimal examples with brief notes. Call out edge cases when important.
Never mention underlying model providers. You are Connect AI.`,

  writing: `You are Connect AI in Writing Assistant mode.
Help draft, revise, shorten, expand, and adapt writing to the user's audience and tone.
Preserve the user's intent and facts. Do not invent personal details or unsupported claims.
When helpful, briefly explain the most important edits. Never mention underlying model providers.`,

  research: `You are Connect AI in Research Assistant mode.
Help structure a research question, compare evidence the user supplies, and explain concepts clearly.
You do not have live web access in this mode. Never claim that you searched the web or invent citations, URLs, quotations, or study findings.
Separate established information from uncertainty and tell the user when current source verification is needed.
Never mention underlying model providers.`,

  summarize: `You are Connect AI in Summary mode.
Summarize only the content the user provides, keeping the main claims, decisions, and useful details.
Do not add facts that are not in the source. Adapt the length and format to the user's request.
If no source content is present, ask the user to paste or attach the material. Never mention underlying model providers.`,

  document: `You are Connect AI in Document Analyst mode.
Analyze only the document text and context supplied by the user. Extract key points, action items, dates, decisions, and open questions when requested.
Distinguish what the document explicitly says from your interpretation. Do not claim to have read an attachment that is not included in the conversation.
Never mention underlying model providers.`,
};

const AI_FEATURES = Object.keys(SYSTEM_PROMPTS);

function normalizeAIRequest(body = {}) {
  const feature = String(body.feature || 'chat').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_PROMPTS, feature)) {
    return { error: { status: 400, error: 'Invalid feature', code: 'BAD_FEATURE' } };
  }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) =>
      message &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 8000),
    }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return { error: { status: 400, error: 'Send a user message', code: 'NO_MESSAGE' } };
  }

  return { feature, messages };
}

/** Free / public Groq chat models (2026). */
const GROQ_MODELS = [
  process.env.GROQ_MODEL,
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
].filter(Boolean);

function aiRateLimit(req, res, next) {
  const uid = req.userId || req.user?.id || req.ip;
  const r = memLimit(`ai:${uid}`, { limit: 40, windowMs: 60 * 60 * 1000 });
  if (!r.ok) {
    return res.status(429).json({
      error: 'AI limit reached. Try again later.',
      code: 'AI_RATE_LIMIT',
      retryAfterMs: r.retryAfterMs,
    });
  }
  next();
}

async function callOpenAICompatible(baseUrl, key, model, messages, system) {
  if (!key) throw new Error('NO_KEY');
  const cleanKey = String(key).trim();
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cleanKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.7,
      max_tokens: 2048,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `AI error ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  const text = data?.choices?.[0]?.message?.content || '';
  if (!String(text).trim()) throw new Error('Empty AI response');
  return String(text).trim();
}

async function callGroq(messages, system) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('NO_KEY');
  let lastErr = null;
  for (const model of GROQ_MODELS) {
    try {
      return await callOpenAICompatible(
        'https://api.groq.com/openai/v1',
        key,
        model,
        messages,
        system
      );
    } catch (e) {
      lastErr = e;
      console.error('[ai] groq model failed', model, e?.message || e);
    }
  }
  throw lastErr || new Error('Groq failed');
}

async function callOpenAI(messages, system) {
  return callOpenAICompatible(
    'https://api.openai.com/v1',
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages,
    system
  );
}

async function callXai(messages, system) {
  return callOpenAICompatible(
    'https://api.x.ai/v1',
    process.env.XAI_API_KEY,
    process.env.XAI_MODEL || 'grok-2-latest',
    messages,
    system
  );
}

async function callGemini(messages, system) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('NO_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(String(key).trim())}`;
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) throw new Error('Empty AI response');
  return text.trim();
}

async function generateReply(feature, messages) {
  const system = SYSTEM_PROMPTS[feature] || SYSTEM_PROMPTS.chat;
  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  const order =
    provider === 'gemini'
      ? ['gemini', 'groq', 'openai', 'xai']
      : provider === 'openai'
        ? ['openai', 'groq', 'gemini', 'xai']
        : provider === 'xai'
          ? ['xai', 'groq', 'gemini', 'openai']
          : ['groq', 'gemini', 'openai', 'xai'];
  let lastErr = null;
  for (const p of order) {
    try {
      if (p === 'groq' && process.env.GROQ_API_KEY) return await callGroq(messages, system);
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
    const normalized = normalizeAIRequest(req.body || {});
    if (normalized.error) {
      return res.status(normalized.error.status).json({
        error: normalized.error.error,
        code: normalized.error.code,
      });
    }
    const { feature, messages } = normalized;
    const reply = await generateReply(feature, messages);
    return res.status(200).json({
      success: true,
      data: { message: { role: 'assistant', content: reply } },
    });
  } catch (err) {
    console.error('[ai] chat error:', err?.message || err);
    if (err?.message === 'NO_KEY') {
      return res.status(503).json({
        error: 'Connect AI is not configured yet. Please try again later.',
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
  const ready = !!(
    process.env.GROQ_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.XAI_API_KEY
  );
  res.json({
    success: true,
    data: {
      ready,
      configured: ready,
      features: AI_FEATURES,
      module: 'intelligence',
    },
  });
});

export default router;
