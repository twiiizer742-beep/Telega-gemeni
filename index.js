import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// Фикс для Render: создание сервера
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is live');
}).listen(process.env.PORT || 10000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

// Тот самый жесткий промпт, чтобы не было звездочек
const SYSTEM_PROMPT = "Ты Кирилл. Пиши просто. ЗАПРЕЩЕНЫ: звездочки (*), решетки (#). Для списков используй только точки (•).";

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
  ['🚀 Быстрый режим (Flash)', '🧠 Умный режим (Pro)'],
  ['🧹 Очистить память', '📊 Статус']
]).resize();

bot.start((ctx) => ctx.reply('Кирилл на связи!', getMainMenu()));

bot.hears('🚀 Быстрый режим (Flash)', async (ctx) => {
  getUserData(ctx.from.id).currentModel = 'flash';
  await db.write();
  ctx.reply('⚡ Режим Flash включен');
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
  ctx.reply('🧹 Память очищена');
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/') || ['🚀 Быстрый режим (Flash)', '🧠 Умный режим (Pro)', '🧹 Очистить память', '📊 Статус'].includes(text)) return;
  
  const user = getUserData(ctx.from.id);
  await ctx.sendChatAction('typing');

  try {
    const model = genAI.getGenerativeModel({ 
      model: MODELS[user.currentModel],
      systemInstruction: SYSTEM_PROMPT 
    });
    
    const history = user.currentModel === 'flash' ? user.flashHistory : user.proHistory;
    const chat = model.startChat({ history: history.slice(-10) });
    
    const result = await chat.sendMessage(text);
    // Дополнительная чистка текста на случай, если ИИ проигнорирует промпт
    let aiText = result.response.text().replace(/[*#]/g, '').trim();

    if (aiText.length > 4000) aiText = aiText.substring(0, 3900) + '...';

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: aiText }] });
    await db.write();

    await ctx.reply(aiText);
  } catch (e) {
    console.error('Ошибка ИИ:', e.message);
    await ctx.reply('Что-то пошло не так. Попробуй еще раз через 10 секунд.');
  }
});

bot.launch().then(() => console.log('Bot is running!'));
