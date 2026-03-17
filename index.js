import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// 1. Сервер для работы на Render
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is live');
}).listen(process.env.PORT || 10000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 2. Инициализация ИИ (версия v1 — самая стабильная для квот)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY, { apiVersion: 'v1' });

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

// 3. Используем 1.5 Flash — у неё самые большие бесплатные лимиты
const MODELS = {
  flash: 'gemini-1.5-flash',
  pro: 'gemini-1.5-pro',
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
  ['🚀 Быстрый режим', '🧠 Умный режим (Pro)'],
  ['🧹 Очистить память', '📊 Статус']
]).resize();

bot.start((ctx) => ctx.reply('Кирилл на связи! Бот обновлен.', getMainMenu()));

bot.hears('🚀 Быстрый режим', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'flash';
  await db.write();
  ctx.reply('⚡ Режим 1.5 Flash включен');
});

bot.hears('🧠 Умный режим (Pro)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'pro';
  await db.write();
  ctx.reply('🧠 Режим Pro включен');
});

bot.hears('🧹 Очистить память', async (ctx) => {
  const user = getUserData(ctx.from.id);
  user.flashHistory = []; user.proHistory = [];
  await db.write();
  ctx.reply('🧹 Память диалога очищена');
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/') || ['🚀 Быстрый режим', '🧠 Умный режим (Pro)', '🧹 Очистить память'].includes(text)) return;
  
  const user = getUserData(ctx.from.id);
  await ctx.sendChatAction('typing');

  try {
    // Вызываем модель с жестким указанием версии API
    const model = genAI.getGenerativeModel({ 
      model: MODELS[user.currentModel] 
    }, { apiVersion: 'v1' });
    
    const history = user.currentModel === 'flash' ? user.flashHistory : user.proHistory;
    
    // Вставляем системную инструкцию прямо в начало чата, чтобы не было ошибки 400
    const chatHistory = history.length === 0 
      ? [{ role: 'user', parts: [{ text: "Ты Кирилл. Пиши кратко, без символов * и #." }] }, { role: 'model', parts: [{ text: "Понял!" }] }]
      : history.slice(-10);

    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(text);
    let aiText = result.response.text().replace(/[*#]/g, '').trim();

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: aiText }] });
    await db.write();

    await ctx.reply(aiText);
  } catch (e) {
    console.error('Ошибка ИИ:', e.message);
    if (e.message.includes('429')) {
      await ctx.reply('Google вредничает (лимиты). Подожди пару минут.');
    } else {
      await ctx.reply('Произошла ошибка. Попробуй еще раз через 10 секунд.');
    }
  }
});

// 4. Запуск с защитой от двойных сессий (Conflict 409)
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('✅ Бот полностью готов и запущен!');
});
