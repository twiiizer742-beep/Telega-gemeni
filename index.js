import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not set');
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');

// ВОТ ЭТИХ СТРОК НЕ ХВАТАЛО:
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

const SYSTEM_PROMPT = `Ты — современный ИИ-ассистент Кирилла. Ты эксперт в маркетинге, фото и видео.
Твой стиль: дружелюбный, без официоза. Пиши как реальный человек в мессенджере.

ПРАВИЛА ОФОРМЛЕНИЯ ТЕКСТА:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ: звездочки (*), двойные звездочки (**), решетки (#) и длинные линии (---).
2. ДЛЯ СПИСКОВ: Используй только обычные жирные точки (•), эмодзи или цифры (1, 2, 3).
3. СТРУКТУРА: Разделяй мысли пустой строкой.
4. ЧИСТЫЙ ТЕКСТ: Весь текст должен быть готов к копированию.
5. КРАТКОСТЬ: Никогда не превышай лимит в 2500 символов. Если информации много, давай только самую суть и предлагай спросить подробнее о конкретном пункте.`;

// ... дальше остальной код ...

const MODELS = {
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
};

const MENU_BUTTONS = [
  '🚀 Быстрый режим (Flash)',
  '🧠 Умный режим (Pro)',
  '🧹 Очистить память',
  '📊 Статус',
  '🎨 Нарисовать картинку',
];

function getMainMenu() {
  return Markup.keyboard([
    ['🚀 Быстрый режим (Flash)', '🧠 Умный режим (Pro)'],
    ['🎨 Нарисовать картинку', '🧹 Очистить память'],
    ['📊 Статус'],
  ]).resize();
}

function getUserData(userId) {
  const id = String(userId);
  if (!db.data.users[id]) {
    db.data.users[id] = {
      currentModel: 'flash',
      flashHistory: [],
      proHistory: [],
      awaitingDraw: false,
    };
  }
  if (db.data.users[id].awaitingDraw === undefined) {
    db.data.users[id].awaitingDraw = false;
  }
  return db.data.users[id];
}

async function saveDB() {
  await db.write();
}

// ─── Translation ──────────────────────────────────────────────────────────────

async function translateToEnglish(text) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return text;
    const json = await res.json();
    const translated = json?.responseData?.translatedText;
    if (translated && !translated.includes('MYMEMORY WARNING') && translated !== text) {
      return translated;
    }
  } catch (_) {}
  return text;
}

// ─── Image providers ──────────────────────────────────────────────────────────

// Provider 1: Pollinations Flux — best quality, 1024x1024
async function tryPollinations(prompt) {
  console.log('Trying Pollinations flux...');
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) { console.log(`Pollinations: ${res.status}`); return null; }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('image')) { console.log(`Pollinations: bad ct ${ct}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5000) { console.log(`Pollinations: too small ${buf.length}`); return null; }
    console.log(`Pollinations ✅ ${buf.length} bytes`);
    return buf;
  } catch (e) {
    console.log(`Pollinations error: ${e.message}`);
    return null;
  }
}

// Provider 2: Stable Horde — reliable crowdsourced, 512x512 (anonymous limit)
async function tryStableHorde(prompt) {
  console.log('Trying Stable Horde...');
  const submitRes = await fetch('https://stablehorde.net/api/v2/generate/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': '0000000000' },
    body: JSON.stringify({
      prompt,
      params: { steps: 20, width: 512, height: 512, cfg_scale: 7, sampler_name: 'k_euler_a' },
      models: ['stable_diffusion'],
      r2: true,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!submitRes.ok) {
    const err = await submitRes.text().catch(() => '');
    console.log(`Horde submit ${submitRes.status}: ${err.slice(0, 80)}`);
    return null;
  }

  const { id } = await submitRes.json();
  console.log(`Horde job: ${id}`);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const check = await fetch(`https://stablehorde.net/api/v2/generate/check/${id}`, {
      signal: AbortSignal.timeout(10000),
    }).then((r) => r.json()).catch(() => ({}));
    console.log(`Horde [${(i + 1) * 5}s] done=${check.done} wait=${check.wait_time}s`);
    if (check.done) {
      const result = await fetch(`https://stablehorde.net/api/v2/generate/status/${id}`, {
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json()).catch(() => ({}));
      const imgUrl = result.generations?.[0]?.img;
      if (!imgUrl) return null;
      const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
      if (!imgRes.ok) return null;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      console.log(`Horde ✅ ${buf.length} bytes`);
      return buf;
    }
  }
  console.log('Horde timed out');
  return null;
}

// Master: translate → run Flux + Horde in parallel → first wins
async function generateImage(originalPrompt) {
  // Build English prompt (no Gemini — quota always exhausted, just wastes time)
  const translated = await translateToEnglish(originalPrompt);
  const engineeredPrompt = `${translated}, cinematic lighting, photorealistic, highly detailed, 8k, sharp focus`;
  console.log(`Final prompt: "${engineeredPrompt}"`);

  // Race Pollinations Flux vs Stable Horde — take whoever finishes first
  const winner = await Promise.any([
    tryPollinations(engineeredPrompt).then((buf) => {
      if (!buf) return Promise.reject(new Error('no result'));
      return { buffer: buf, source: 'Flux' };
    }),
    tryStableHorde(engineeredPrompt).then((buf) => {
      if (!buf) return Promise.reject(new Error('no result'));
      return { buffer: buf, source: 'Stable Horde' };
    }),
  ]).catch(() => null);

  if (winner) return winner;

  // Both failed — send clickable link
  const encoded = encodeURIComponent(engineeredPrompt);
  const seed = Math.floor(Math.random() * 999999);
  return {
    buffer: null,
    url: `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`,
  };
}

// ─── Draw handler ─────────────────────────────────────────────────────────────

async function handleDraw(ctx, prompt) {
  // Truncate very long prompts — user might paste a mega-prompt
  const shortPrompt = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
  // Caption limit in Telegram is 1024 chars
  const caption = `🎨 ${shortPrompt}`.slice(0, 1020);

  await ctx.sendChatAction('upload_photo');
  await ctx.reply('✨ Генерирую шедевр через Flux...');

  const result = await generateImage(prompt);

  if (result.buffer) {
    await ctx.replyWithPhoto({ source: result.buffer }, { caption, ...getMainMenu() });
  } else {
    await ctx.reply(
      `🎨 Серверы немного перегружены прямо сейчас.\n\nОткрой ссылку в браузере — там будет картинка:\n${result.url}`,
      getMainMenu()
    );
  }
}

// ─── Bot handlers ─────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  getUserData(ctx.from.id);
  await saveDB();
  await ctx.reply(
    'Привет! Я ИИ-ассистент Кирилла 👋\n\n' +
      'Эксперт в маркетинге, фото и видео. Давай работать!\n\n' +
      'Выбери режим или просто пиши 👇',
    getMainMenu()
  );
});

bot.hears('🚀 Быстрый режим (Flash)', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.currentModel = 'flash';
  user.awaitingDraw = false;
  await saveDB();
  await ctx.reply(
    'Включил быстрый режим Flash ⚡\nГенерирую ответы быстро и чётко. Пиши!',
    getMainMenu()
  );
});

bot.hears('🧠 Умный режим (Pro)', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.currentModel = 'pro';
  user.awaitingDraw = false;
  await saveDB();
  await ctx.reply(
    'Включил умный режим Pro 🧠\n\n' +
      '⚠️ Heads up: у этой модели лимит ~50 запросов в день. ' +
      'Используй для серьёзных задач, где нужна глубина.',
    getMainMenu()
  );
});

bot.hears('🧹 Очистить память', async (ctx) => {
  const user = getUserData(ctx.from.id);
  const mode = user.currentModel;
  user.awaitingDraw = false;
  if (mode === 'flash') {
    user.flashHistory = [];
  } else {
    user.proHistory = [];
  }
  await saveDB();
  const modeName = mode === 'flash' ? 'Flash' : 'Pro';
  await ctx.reply(
    `Память режима ${modeName} очищена 🧹\nНачинаем с чистого листа!`,
    getMainMenu()
  );
});

bot.hears('📊 Статус', async (ctx) => {
  const user = getUserData(ctx.from.id);
  const mode = user.currentModel;
  user.awaitingDraw = false;
  const history = mode === 'flash' ? user.flashHistory : user.proHistory;
  const messagesCount = Math.floor(history.length / 2);
  const modeName = mode === 'flash' ? '🚀 Flash (быстрый)' : '🧠 Pro (умный)';
  await saveDB();
  await ctx.reply(
    `📊 Текущий статус:\n\nРежим: ${modeName}\nМодель: ${MODELS[mode]}\nСообщений в памяти: ${messagesCount}`,
    getMainMenu()
  );
});

bot.hears('🎨 Нарисовать картинку', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.awaitingDraw = true;
  await saveDB();
  await ctx.reply(
    '🎨 Опиши что нарисовать — и я пришлю картинку!\n\nНапример: чёрный Camaro на закате, киношная атмосфера',
    Markup.keyboard([['❌ Отмена']]).resize()
  );
});

bot.command('draw', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.awaitingDraw = false;
  await saveDB();
  const prompt = ctx.message.text.replace('/draw', '').trim();
  if (!prompt) {
    await ctx.reply(
      'Напиши описание после команды. Например:\n/draw закат над океаном в стиле акварели',
      getMainMenu()
    );
    return;
  }
  await handleDraw(ctx, prompt);
});

bot.on('text', async (ctx) => {
  const messageText = ctx.message.text;

  if (MENU_BUTTONS.includes(messageText)) return;
  if (messageText.startsWith('/')) return;

  const user = getUserData(ctx.from.id);

  if (messageText === '❌ Отмена') {
    user.awaitingDraw = false;
    await saveDB();
    await ctx.reply('Отменил 👌', getMainMenu());
    return;
  }

  if (user.awaitingDraw) {
    user.awaitingDraw = false;
    await saveDB();
    await handleDraw(ctx, messageText);
    return;
  }

  const mode = user.currentModel;
  await ctx.sendChatAction('typing');

  try {
    const model = genAI.getGenerativeModel({
      model: MODELS[mode],
      systemInstruction: SYSTEM_PROMPT,
    });

    const history = mode === 'flash' ? user.flashHistory : user.proHistory;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(messageText);
    const responseText = result.response.text();

    if (mode === 'flash') {
      user.flashHistory.push({ role: 'user', parts: [{ text: messageText }] });
      user.flashHistory.push({ role: 'model', parts: [{ text: responseText }] });
    } else {
      user.proHistory.push({ role: 'user', parts: [{ text: messageText }] });
      user.proHistory.push({ role: 'model', parts: [{ text: responseText }] });
    }

    await saveDB();
    await ctx.reply(responseText, getMainMenu());
  } catch (error) {
    console.error('AI error:', error.message);
    if (
      error.message?.includes('quota') ||
      error.message?.includes('RESOURCE_EXHAUSTED') ||
      error.message?.includes('429')
    ) {
      await ctx.reply(
        'Лимит запросов исчерпан 😔 Переключись на Flash режим или подожди немного.',
        getMainMenu()
      );
    } else {
      await ctx.reply('Что-то пошло не так. Попробуй ещё раз!', getMainMenu());
    }
  }
});

// ─── Global crash protection ──────────────────────────────────────────────────

// Catch all Telegraf-level errors so a bad update never crashes the process
bot.catch((err, ctx) => {
  console.error(`Bot error for update ${ctx?.update?.update_id}:`, err.message);
});

// Catch any unhandled promise rejection — log and continue, never crash
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Catch any synchronous uncaught exception — log and continue, never crash
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

// ─── Keep-alive self-ping every 4 minutes ────────────────────────────────────
// Prevents Replit from marking the process as idle
setInterval(() => {
  console.log(`[keep-alive] ${new Date().toISOString()} — bot alive`);
}, 4 * 60 * 1000);

// ─── Auto-reconnect: relaunch bot on network drops ───────────────────────────
async function launchWithRetry() {
  while (true) {
    try {
      console.log('Telegram bot starting...');
      await bot.launch();
    } catch (err) {
      console.error('Bot launch/connection dropped:', err.message);
      console.log('Reconnecting in 10 seconds...');
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

launchWithRetry();
console.log('Bot is running!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
