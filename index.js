import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// Сервер для Render
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is live');
}).listen(process.env.PORT || 10000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Работаем через v1, так как v1beta нестабильна
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY, { apiVersion: 'v1' });

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

// Новые актуальные модели
const MODELS = {
  flash: 'gemini-2.0-flash',
  pro: 'gemini-1.5-pro', // Pro 2.0 пока в превью, оставим стабильную 1.5
};

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

function getUserData(userId) {
  const id = String(userId);
  if (!db.data.users[id]) {
    db.data.users[id] = { currentModel: 'flash', flashHistory: [], proHistory: [] };
  }
  return db.data.users[id];
}

const getMainMenu = () => Markup.keyboard([
  ['🚀 Быстрый (2.0 Flash)', '🧠 Умный (Pro)'],
  ['🧹 Очистить память', '📊 Статус']
]).resize();

bot.start((ctx) => ctx.reply('Кирилл на связи! Используем Gemini 2.0.', getMainMenu()));

bot.hears('🚀 Быстрый (2.0 Flash)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'flash';
  await db.write();
  ctx.reply('⚡ Gemini 2.0 Flash включен');
});

bot.hears('🧠 Умный (Pro)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'pro';
  await db.write();
  ctx.reply('🧠 Режим Pro включен');
});

bot.hears('🧹 Очистить память', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.flashHistory = []; user.proHistory = [];
  await db.write();
  ctx.reply('🧹 Память очищена');
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/') || ['🚀 Быстрый (2.0 Flash)', '🧠 Умный (Pro)', '🧹 Очистить память'].includes(text)) return;
  
  const user = getUserData(ctx.from.id);
  await ctx.sendChatAction('typing');

  try {
    // В версии v1 для некоторых моделей systemInstruction передается иначе
    // Чтобы избежать ошибки 400, мы просто добавим инструкцию в начало истории
    const model = genAI.getGenerativeModel({ model: MODELS[user.currentModel] });
    
    const history = user.currentModel === 'flash' ? user.flashHistory : user.proHistory;
    
    // Если история пуста, добавим системную роль как обычный текст для надежности
    const chatHistory = history.length === 0 
      ? [{ role: 'user', parts: [{ text: "Инструкция: Ты Кирилл. Пиши кратко, без символов * и #." }] }, { role: 'model', parts: [{ text: "Понял, я Кирилл. Буду писать просто." }] }]
      : history.slice(-10);

    const chat = model.startChat({ history: chatHistory });
    
    const result = await chat.sendMessage(text);
    let aiText = result.response.text().replace(/[*#]/g, '').trim();

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: aiText }] });
    await db.write();

    await ctx.reply(aiText);
  } catch (e) {
    console.error('Ошибка:', e.message);
    await ctx.reply('Проблема с Gemini 2.0. Попробуй еще раз через пару секунд.');
  }
});

bot.launch({ dropPendingUpdates: true }).then(() => console.log('✅ Бот на Gemini 2.0 запущен!'));
