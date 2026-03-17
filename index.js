import { Telegraf, Markup } from 'telegraf';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// 1. КОСТЫЛЬ ДЛЯ RENDER: Чтобы он не искал порты и не убивал бота
http.createServer((req, res) => res.end('Bot is alive')).listen(process.env.PORT || 10000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not set');
if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter, { users: {} });
await db.read();

// 2. ЖЕСТКИЙ ПРОМПТ ДЛЯ КИРИЛЛА
const SYSTEM_PROMPT = `Ты — Кирилл, ИИ-ассистент. Пиши просто, как в ТГ.
ПРАВИЛА ОФОРМЛЕНИЯ:
- НИКАКИХ звездочек (*), решеток (#), скобок [] и римских цифр.
- Для списков используй только точки (•).
- Пиши коротко (до 2000 знаков).`;

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

// 3. ФУНКЦИЯ ОЧИСТКИ ТЕКСТА: Если ИИ всё же прислал мусор
function cleanText(text) {
  return text.replace(/[*#\[\]]/g, '').trim();
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  getUserData(ctx.from.id);
  await saveDB();
  await ctx.reply('Кирилл на связи. Погнали!', getMainMenu());
});

// ... логика кнопок (Flash, Pro, Статус, Память) ...
bot.hears('🚀 Быстрый режим (Flash)', async (ctx) => { getUserData(ctx.from.id).currentModel = 'flash'; await saveDB(); ctx.reply('⚡ Flash включен'); });
bot.hears('🧠 Умный режим (Pro)', async (ctx) => { getUserData(ctx.from.id).currentModel = 'pro'; await saveDB(); ctx.reply('🧠 Pro включен'); });
bot.hears('🧹 Очистить память', async (ctx) => { const u = getUserData(ctx.from.id); u.flashHistory = []; u.proHistory = []; await saveDB(); ctx.reply('🧹 Память чиста'); });

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  if (MENU_BUTTONS.includes(text) || text.startsWith('/')) return;

  const user = getUserData(ctx.from.id);
  await ctx.sendChatAction('typing');

  try {
    const model = genAI.getGenerativeModel({ model: MODELS[user.currentModel], systemInstruction: SYSTEM_PROMPT });
    const history = user.currentModel === 'flash' ? user.flashHistory : user.proHistory;
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(text);
    
    // ПРИНУДИТЕЛЬНО ЧИСТИМ ОТ ЗВЕЗДОЧЕК
    let responseText = cleanText(result.response.text());

    // ЗАЩИТА ОТ "MESSAGE IS TOO LONG"
    if (responseText.length > 4000) {
        responseText = responseText.substring(0, 3900) + '... (текст сокращен)';
    }

    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: responseText }] });
    await saveDB();

    await ctx.reply(responseText, getMainMenu());
  } catch (e) {
    console.error('AI Error:', e.message);
    await ctx.reply('Ошибка. Попробуй еще раз.');
  }
});

bot.launch().then(() => console.log('Bot is running!'));
