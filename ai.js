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
import { prisma } from './prisma.js';

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
};

const GROQ_MODELS = [
  process.env.GROQ_MODEL,
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
].filter(Boolean);

const VALID_FEATURES = ['chat', 'study', 'code'];

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

function getUserId(req) {
  return req.userId || req.user?.id || null;
}

function cleanFeature(value) {
  const feature = String(value || 'chat').toLowerCase();
  return VALID_FEATURES.includes(feature) ? feature : null;
}

function cleanTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
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

/*
 * Persistent conversation endpoints.
 * All /api/ai routes are mounted behind authenticateToken in server.js.
 * Every database lookup is scoped to the authenticated user.
 */
router.get('/threads', async (req, res) => {
  try {
    const userId = getUserId(req);
    const feature = req.query.feature ? cleanFeature(req.query.feature) : null;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (req.query.feature && !feature) {
      return res.status(400).json({ error: 'Invalid feature', code: 'BAD_FEATURE' });
    }

    const threads = await prisma.aiThread.findMany({
      where: { userId, ...(feature ? { feature } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        feature: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { role: true, content: true, createdAt: true },
        },
      },
    });
    return res.json({ success: true, data: { threads } });
  } catch (err) {
    console.error('[ai] list threads:', err?.message || err);
    return res.status(500).json({ error: 'Could not load AI conversations' });
  }
});

router.post('/threads', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const feature = cleanFeature(req.body?.feature);
    if (!feature) return res.status(400).json({ error: 'Invalid feature', code: 'BAD_FEATURE' });

    const title = cleanTitle(req.body?.title) || 'New conversation';
    const thread = await prisma.aiThread.create({
      data: { userId, feature, title },
      select: { id: true, title: true, feature: true, createdAt: true, updatedAt: true },
    });
    return res.status(201).json({ success: true, data: { thread } });
  } catch (err) {
    console.error('[ai] create thread:', err?.message || err);
    return res.status(500).json({ error: 'Could not create AI conversation' });
  }
});

router.get('/threads/:threadId', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const thread = await prisma.aiThread.findFirst({
      where: { id: req.params.threadId, userId },
      select: {
        id: true,
        title: true,
        feature: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, role: true, content: true, createdAt: true },
        },
      },
    });
    if (!thread) return res.status(404).json({ error: 'Conversation not found' });
    thread.messages.reverse();
    return res.json({ success: true, data: { thread } });
  } catch (err) {
    console.error('[ai] get thread:', err?.message || err);
    return res.status(500).json({ error: 'Could not load AI conversation' });
  }
});

router.patch('/threads/:threadId', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const title = cleanTitle(req.body?.title);
    if (!title) return res.status(400).json({ error: 'A conversation title is required' });

    const result = await prisma.aiThread.updateMany({
      where: { id: req.params.threadId, userId },
      data: { title },
    });
    if (!result.count) return res.status(404).json({ error: 'Conversation not found' });
    const thread = await prisma.aiThread.findFirst({
      where: { id: req.params.threadId, userId },
      select: { id: true, title: true, feature: true, createdAt: true, updatedAt: true },
    });
    return res.json({ success: true, data: { thread } });
  } catch (err) {
    console.error('[ai] rename thread:', err?.message || err);
    return res.status(500).json({ error: 'Could not rename AI conversation' });
  }
});

router.delete('/threads/:threadId', async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const result = await prisma.aiThread.deleteMany({
      where: { id: req.params.threadId, userId },
    });
    if (!result.count) return res.status(404).json({ error: 'Conversation not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[ai] delete thread:', err?.message || err);
    return res.status(500).json({ error: 'Could not delete AI conversation' });
  }
});

router.post('/chat', aiRateLimit, async (req, res) => {
  try {
    const feature = cleanFeature(req.body?.feature);
    if (!feature) {
      return res.status(400).json({ error: 'Invalid feature', code: 'BAD_FEATURE' });
    }

    let incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    incoming = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-20)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));

    if (!incoming.length || incoming[incoming.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Send a user message', code: 'NO_MESSAGE' });
    }

    const threadId = typeof req.body?.threadId === 'string' ? req.body.threadId.trim() : '';
    const userId = getUserId(req);
    let messages = incoming;
    let thread = null;

    if (threadId) {
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      thread = await prisma.aiThread.findFirst({
        where: { id: threadId, userId },
        select: { id: true, feature: true, title: true },
      });
      if (!thread) return res.status(404).json({ error: 'Conversation not found' });
      if (thread.feature !== feature) {
        return res.status(400).json({ error: 'Conversation feature mismatch', code: 'FEATURE_MISMATCH' });
      }

      const lastUserMessage = incoming[incoming.length - 1];
      const history = await prisma.aiMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: 'desc' },
        take: 19,
        select: { role: true, content: true },
      });
      messages = [...history.reverse(), lastUserMessage];
    }

    const reply = await generateReply(feature, messages);

    if (thread) {
      const firstUserMessage = messages.find((m) => m.role === 'user')?.content || '';
      const nextTitle =
        thread.title === 'New conversation' && firstUserMessage
          ? firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 72) || 'New conversation'
          : thread.title;

      await prisma.$transaction([
        prisma.aiMessage.create({
          data: { threadId: thread.id, role: 'user', content: messages[messages.length - 1].content },
        }),
        prisma.aiMessage.create({
          data: { threadId: thread.id, role: 'assistant', content: reply },
        }),
        prisma.aiThread.update({
          where: { id: thread.id },
          data: { title: nextTitle },
        }),
      ]);
    }

    return res.status(200).json({
      success: true,
      data: {
        message: { role: 'assistant', content: reply },
        ...(thread ? { threadId: thread.id } : {}),
      },
    });
  } catch (err) {
    console.error('[ai] chat error:', err?.message || err);
    if (err?.message === 'NO_KEY') {
      return res.status(503).json({
        error:
          'Connect AI is not configured yet. Add GROQ_API_KEY on the server (free at console.groq.com).',
        code: 'AI_NOT_CONFIGURED',
      });
    }
    const hint = String(err?.message || '').slice(0, 120);
    return res.status(502).json({
      error: hint
        ? `Connect AI is temporarily unavailable. (${hint})`
        : 'Connect AI is temporarily unavailable. Try again.',
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
      features: ['chat', 'study', 'code'],
      module: 'intelligence',
      persistence: true,
    },
  });
});

export default router;
