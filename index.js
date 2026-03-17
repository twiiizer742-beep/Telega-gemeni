import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// Обманка для Render, чтобы он видел активный порт
http.createServer((req, res) => res.end('Bot is alive')).listen(process.env.PORT || 10000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not set');
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

const SYSTEM_PROMPT = `Ты — современный ИИ-ассистент Кирилл. Пиши просто. 
КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ: звездочки (*), решетки (#), линии (---). 
Для списков используй только точки (•).`;

const MODELS = {
  flash: 'gemini-1.5-flash',
  pro: 'gemini-1.5-pro',
};

const MENU_BUTTONS = ['🚀 Быстрый режим (Flash)', '🧠 Умный режим (Pro)', '🧹 Очистить память', '📊 Статус', '🎨 Нарисовать картинку'];

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
    db.data.users[id] = { currentModel: 'flash', flashHistory: [], proHistory: [], awaitingDraw: false };
  }
  return db.data.users[id];
}

async function saveDB() { await db.write(); }

async function translateToEnglish(text) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ru|en`;
    const res = await fetch(url);
    const json = await res.json();
    return json?.responseData?.translatedText || text;
  } catch (_) { return text; }
}

async function handleDraw(ctx, prompt) {
  await ctx.sendChatAction('upload_photo');
  const tr = await translateToEnglish(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(tr)}?width=1024&height=1024&model=flux&nologo=true`;
  try {
    await ctx.replyWithPhoto({ url }, { caption: `🎨 ${prompt}`, ...getMainMenu() });
  } catch (e) {
    await ctx.reply(`Ссылка на фото: ${url}`, getMainMenu());
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  getUserData(ctx.from.id);
  await saveDB();
  await ctx.reply('Кирилл на связи. Погнали!', getMainMenu());
});

bot.hears('🚀 Быстрый режим (Flash)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'flash';
  await saveDB();
  await ctx.reply('⚡ Flash включен', getMainMenu());
});

bot.hears('🧠 Умный режим (Pro)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'pro';
  await saveDB();
  await ctx.reply('🧠 Pro включен', getMainMenu());
});

bot.hears('🧹 Очистить память', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.flashHistory = []; user.proHistory = [];
  await saveDB();
  await ctx.reply('🧹 Память очищена', getMainMenu());
});

bot.hears('📊 Статус', async (ctx) => {
  const user = getUserData(ctx.from.id);
  await ctx.reply(`📊 Модель: ${user.currentModel}`, getMainMenu());
});

bot.hears('🎨 Нарисовать картинку', async (ctx) => {
  getUserData(ctx.from.id).awaitingDraw = true;
  await saveDB();
  await ctx.reply('Что рисуем?', Markup.keyboard([['❌ Отмена']]).resize());
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (MENU_BUTTONS.includes(text)) return;
  const user = getUserData(ctx.from.id);
  
  if (text === '❌ Отмена') {
    user.awaitingDraw = false;
    await saveDB();
    return ctx.reply('Отмена', getMainMenu());
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
    
    // ПРИНУДИТЕЛЬНАЯ ОЧИСТКА: вырезаем мусорные символы
    let aiText = result.response.text().replace(/[*#\[\]]/g, ''); 

    // ЗАЩИТА ОТ ДЛИННЫХ СООБЩЕНИЙ: Telegram не примет > 4096 знаков
    if (aiText.length > 4000) {
      aiText = aiText.substring(0, 3900) + '... (текст сокращен)';
    }

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: aiText }] });
    await saveDB();

    await ctx.reply(aiText, getMainMenu());
  } catch (e) {
    console.error('AI Error:', e.message);
    await ctx.reply('Ошибка. Попробуй еще раз через минуту.', getMainMenu());
  }
});

bot.launch().then(() => console.log('Bot is running!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
