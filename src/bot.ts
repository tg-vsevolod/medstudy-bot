import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import { registerAdmin, setAdminMenu, userCommands } from './admin.js';
import { adminIds, loadMasterClassDates } from './admins.js';
import { registerChannel } from './channel.js';
import { env } from './config.js';
import { registerFlow } from './flow.js';
import { startScheduler } from './scheduler.js';

loadMasterClassDates();

const bot = new Bot(env.botToken);
bot.api.config.use(autoRetry());

registerChannel(bot);
registerAdmin(bot);
registerFlow(bot);

bot.catch(({ error, ctx }) => {
  console.error(`Ошибка при обработке update ${ctx.update.update_id}:`, error);
});

await bot.api.setMyCommands(userCommands);
for (const adminId of adminIds()) await setAdminMenu(bot.api, adminId);

if (adminIds().length === 0) console.warn('ADMIN_IDS не задан: админ-команды и пересылка вопросов отключены');

startScheduler(bot.api);

process.once('SIGINT', () => void bot.stop());
process.once('SIGTERM', () => void bot.stop());

await bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущен`) });
