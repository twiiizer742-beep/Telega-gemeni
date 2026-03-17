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

// Инициализация AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

// Финальный промпт для чистого текста
const SYSTEM_PROMPT = `Ты — Кирилл, эксперт. Пиши просто, как в телеграме.

ЖЕСТКИЕ ПРАВИЛА ОФОРМЛЕНИЯ:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ: звездочки (*), двойные звездочки (**), решетки (#) и горизонтальные линии (---).
2. ЗАПРЕЩЕНЫ: римские цифры (I, II, III) и квадратные скобки [ ].
3. СПИСКИ: Используй только жирные точки (•) или обычные цифры (1. 2. 3.).
4. СТРУКТУРА: Заголовки пиши ОБЫЧНЫМИ ЗАГЛАВНЫМИ БУКВАМИ. Разделяй блоки пустой строкой.
5. ЛИМИТ: Пиши кратко, не более 2000 знаков.

Пример ответа:
СПИСОК ДЕЛ
• Умыться
• Почистить зубы`;

const MODELS = {
  flash: 'gemini-1.5-flash',
  pro: 'gemini-1.5-pro',
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
  return db.data.users[id];
}

async function saveDB() {
  await db.write();
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

async function translateToEnglish(text) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return text;
    const json = await res.json();
    return json?.responseData?.translatedText || text;
  } catch (_) { return text; }
}

async function generateImage(prompt) {
  const translated = await translateToEnglish(prompt);
  const encoded = encodeURIComponent(`${translated}, cinematic, highly detailed`);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&model=flux&nologo=true`;
  
  try {
    const res = await fetch(url);
    if (res.ok) return { buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (e) { console.log('Draw error:', e.message); }
  return { url };
}

// ─── Обработчики ─────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  getUserData(ctx.from.id);
  await saveDB();
  await ctx.reply('Привет! Я твой ИИ-ассистент. Выбирай режим и погнали!', getMainMenu());
});

bot.hears('🚀 Быстрый режим (Flash)', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.currentModel = 'flash';
  await saveDB();
  await ctx.reply('Включен быстрый режим Flash ⚡', getMainMenu());
});

bot.hears('🧠 Умный режим (Pro)', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.currentModel = 'pro';
  await saveDB();
  await ctx.reply('Включен умный режим Pro 🧠', getMainMenu());
});

bot.hears('🧹 Очистить память', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.flashHistory = [];
  user.proHistory = [];
  await saveDB();
  await ctx.reply('Память очищена 🧹', getMainMenu());
});

bot.hears('📊 Статус', async (ctx) => {
  const user = getUserData(ctx.from.id);
  await ctx.reply(`📊 Режим: ${user.currentModel}\nМодель: ${MODELS[user.currentModel]}`, getMainMenu());
});

bot.hears('🎨 Нарисовать картинку', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.awaitingDraw = true;
  await saveDB();
  await ctx.reply('Что нарисовать?', Markup.keyboard([['❌ Отмена']]).resize());
});

async function handleDraw(ctx, prompt) {
  await ctx.sendChatAction('upload_photo');
  const res = await generateImage(prompt);
  if (res.buffer) {
    await ctx.replyWithPhoto({ source: res.buffer }, { caption: `🎨 ${prompt}`, ...getMainMenu() });
  } else {
    await ctx.reply(`Не удалось загрузить фото, вот ссылка: ${res.url}`, getMainMenu());
  }
}

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (MENU_BUTTONS.includes(text)) return;
  
  const user = getUserData(ctx.from.id);
  
  if (text === '❌ Отмена') {
    user.awaitingDraw = false;
    await saveDB();
    return ctx.reply('Отменил', getMainMenu());
  }

  if (user.awaitingDraw) {
    user.awaitingDraw = false;
    await saveDB();
    return handleDraw(ctx, text);
  }

  await ctx.sendChatAction('typing');
  try {
    const model = genAI.getGenerativeModel({ 
        model: MODELS[user.currentModel],
        systemInstruction: SYSTEM_PROMPT 
    });
    
    const history = user.currentModel === 'flash' ? user.flashHistory : user.proHistory;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(text);
    const aiText = result.response.text();

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: aiText }] });
    await saveDB();

    // Защита от слишком длинных сообщений
    if (aiText.length > 4000) {
      await ctx.reply(aiText.substring(0, 4000) + '...', getMainMenu());
    } else {
      await ctx.reply(aiText, getMainMenu());
    }
  } catch (e) {
    console.error('AI Error:', e.message);
    await ctx.reply('Ошибка связи с мозгами ИИ. Попробуй позже.', getMainMenu());
  }
});

// Запуск
async function startBot() {
  try {
    await bot.launch();
    console.log('Bot is running!');
  } catch (e) {
    console.error('Launch error:', e.message);
    setTimeout(startBot, 5000);
  }
}
startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
