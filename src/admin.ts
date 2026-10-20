import { GrammyError, InlineKeyboard, InputFile, type Api, type Bot, type Context } from 'grammy';
import { addAdmin, adminIds, isAdmin, isEnvAdmin, masterClassStartKey, removeAdmin } from './admins.js';
import { channelId } from './channel.js';
import { TIME_ZONE, env, masterClasses, pragueTime, setMasterClassStart, type Track } from './config.js';
import {
  allUsers,
  deleteUser,
  getStats,
  getUser,
  resetReminders,
  segmentUserIds,
  setSetting,
  updateUser,
  type Segment,
  type User,
} from './db.js';
import { platformUrl, streamLink } from './messages.js';
import { scheduleReminders } from './scheduler.js';
import { labels } from './texts.js';

export const userCommands = [{ command: 'start', description: 'Регистрация на мастер-класс' }];
export const adminCommands = [
  ...userCommands,
  { command: 'stats', description: 'Статистика' },
  { command: 'export', description: 'Выгрузка CSV' },
  { command: 'broadcast', description: 'Рассылка' },
  { command: 'setlink', description: 'Ссылка на трансляцию: med|tech <url>' },
  { command: 'setplatform', description: 'Ссылка на платформу' },
  { command: 'setdate', description: 'Дата мастер-класса: med|tech ДД.ММ.ГГГГ ЧЧ:ММ' },
  { command: 'admins', description: 'Список админов' },
  { command: 'addadmin', description: 'Добавить админа: <id>' },
  { command: 'removeadmin', description: 'Удалить админа: <id>' },
  { command: 'reset', description: 'Сбросить мою регистрацию (для теста)' },
  { command: 'admin', description: 'Помощь по командам' },
];

/** Telegram отвечает «chat not found», пока человек сам не написал боту. */
export async function setAdminMenu(api: Api, adminId: number): Promise<boolean> {
  try {
    await api.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminId } });
    return true;
  } catch (err) {
    console.warn(`Не удалось задать меню команд для админа ${adminId} (он должен сначала написать боту):`, err);
    return false;
  }
}

const segmentNames: Record<Segment, string> = {
  all: 'Все пользователи',
  med: 'Медицина',
  tech: 'Тех/IT',
  offline: 'Очно',
  online: 'Онлайн',
};

interface Draft {
  segment: Segment;
  stage: 'await_message' | 'await_confirm';
  chatId?: number;
  messageId?: number;
}

const drafts = new Map<number, Draft>();

const helpText = `🛠 Команды администратора:

/stats — статистика регистраций
/export — выгрузка всех пользователей в CSV
/broadcast — рассылка по сегменту
/cancel — отменить рассылку
/setlink med|tech <url> — ссылка на онлайн-трансляцию
/setplatform <url> — ссылка на образовательную платформу
/setdate med|tech ДД.ММ.ГГГГ ЧЧ:ММ — дата и время мастер-класса (по Праге)

/admins — список админов
/addadmin <id> — добавить админа (или реплаем на пересланное сообщение пользователя)
/removeadmin <id> — удалить админа

/reset — сбросить свою регистрацию, чтобы пройти опрос заново

Чтобы ответить пользователю, ответь реплаем на его пересланное сообщение.`;

function isUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function channelStatus(): string {
  if (!env.channelUrl) return 'не требуется (CHANNEL_URL не задан)';
  if (!channelId()) return `❗️ бот не добавлен админом в группу, вступление не проверяется\n${env.channelUrl}`;
  return `✅ подключена, вступление проверяется\n${env.channelUrl}`;
}

function statsText(): string {
  const s = getStats();
  const link = (track: Track) => streamLink(track) ?? '❗️ не задана';
  const when = (track: Track) => `${masterClasses[track].dateLabel}, ${masterClasses[track].timeLabel}`;
  return `📊 Статистика

👥 Всего начали диалог: ${s.total}
✅ Зарегистрировались: ${s.registered}
⏸ Не дошли до конца: ${s.unfinished}
🚫 Заблокировали бота: ${s.blocked}

Направление:
🩺 Медицина: ${s.med}
💻 Тех/IT: ${s.tech}

Кто поступает:
🙋 Сам(а): ${s.self}
👨‍👩‍👧 Для ребенка: ${s.child}

Где живут:
🏙 В Праге: ${s.prague}
✈️ Планируют переезд: ${s.relocating}

Формат участия:
🏫 Очно: ${s.offline}
💻 Онлайн: ${s.online}

📅 Мастер-классы (по Праге):
Медицина: ${when('med')}
Тех/IT: ${when('tech')}

🔗 Ссылки:
Платформа: ${platformUrl() ?? '❗️ не задана'}
Группа: ${channelStatus()}
Трансляция (медицина, ${masterClasses.med.dateLabel}): ${link('med')}
Трансляция (тех, ${masterClasses.tech.dateLabel}): ${link('tech')}`;
}

const csvDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function usersCsv(users: User[]): string {
  const header = [
    'telegram_id',
    'username',
    'имя',
    'шаг',
    'кто поступает',
    'направление',
    'прага/переезд',
    'формат',
    'начал',
    'зарегистрировался',
    'заблокировал',
  ];
  const rows = users.map((u) => [
    u.id,
    u.username,
    u.first_name,
    u.step,
    u.applicant ? labels.applicant[u.applicant] : null,
    u.track ? labels.track[u.track] : null,
    u.location ? labels.location[u.location] : null,
    u.attendance ? labels.attendance[u.attendance] : null,
    csvDate.format(new Date(u.created_at)),
    u.registered_at ? csvDate.format(new Date(u.registered_at)) : null,
    u.blocked ? 'да' : 'нет',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBroadcast(api: Api, adminChatId: number, draft: Required<Draft>): Promise<void> {
  const recipients = segmentUserIds(draft.segment);
  let sent = 0;
  let failed = 0;
  for (const userId of recipients) {
    try {
      await api.copyMessage(userId, draft.chatId, draft.messageId);
      sent++;
    } catch (err) {
      failed++;
      if (err instanceof GrammyError && err.error_code === 403) updateUser(userId, { blocked: 1 });
    }
    await sleep(40);
  }
  await api.sendMessage(adminChatId, `📬 Рассылка завершена.\n✅ Доставлено: ${sent}\n❌ Не доставлено: ${failed}`);
}

async function handleReplyToUser(ctx: Context): Promise<boolean> {
  const original = ctx.message?.reply_to_message;
  const match = (original?.text ?? original?.caption)?.match(/#id(\d+)/);
  if (!match || !ctx.message) return false;
  try {
    await ctx.api.copyMessage(Number(match[1]), ctx.chat!.id, ctx.message.message_id);
    await ctx.reply('✅ Ответ отправлен пользователю.');
  } catch (err) {
    console.error('Не удалось отправить ответ пользователю:', err);
    await ctx.reply('❌ Не удалось отправить ответ: возможно, пользователь заблокировал бота.');
  }
  return true;
}

function personLabel(userId: number): string {
  const user = getUser(userId);
  const name = user?.first_name ?? 'без имени';
  const username = user?.username ? ` (@${user.username})` : '';
  return `${name}${username}, id ${userId}`;
}

function targetUserId(ctx: Context): number | null {
  const arg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (arg) return /^\d+$/.test(arg) ? Number(arg) : null;
  const original = ctx.message?.reply_to_message;
  const match = (original?.text ?? original?.caption)?.match(/#id(\d+)/);
  return match ? Number(match[1]) : null;
}

export function registerAdmin(bot: Bot): void {
  const admin = bot.chatType('private').filter((ctx) => isAdmin(ctx.from?.id));

  admin.command(['admin', 'help'], (ctx) =>
    ctx.reply(helpText, { reply_markup: new InlineKeyboard().text('🧹 Сбросить мою регистрацию', 'adm:reset') }),
  );

  const resetOwnRegistration = async (ctx: Context) => {
    deleteUser(ctx.from!.id);
    await ctx.reply('🧹 Твоя регистрация удалена. Нажми /start, чтобы пройти опрос заново.');
  };

  admin.command('reset', resetOwnRegistration);

  admin.callbackQuery('adm:reset', async (ctx) => {
    await ctx.answerCallbackQuery();
    await resetOwnRegistration(ctx);
  });

  admin.command('stats', (ctx) => ctx.reply(statsText(), { link_preview_options: { is_disabled: true } }));

  admin.command('export', async (ctx) => {
    const csv = `\uFEFF${usersCsv(allUsers())}`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv, 'utf8'), 'users.csv'));
  });

  admin.command('setlink', async (ctx) => {
    const [track, url] = ctx.match.trim().split(/\s+/);
    if ((track !== 'med' && track !== 'tech') || !isUrl(url)) {
      await ctx.reply('Формат: /setlink med|tech https://...');
      return;
    }
    setSetting(`stream_link_${track}`, url);
    await ctx.reply(`✅ Ссылка на трансляцию (${labels.track[track]}) сохранена:\n${url}`);
  });

  admin.command('setplatform', async (ctx) => {
    const url = ctx.match.trim();
    if (!isUrl(url)) {
      await ctx.reply('Формат: /setplatform https://...');
      return;
    }
    setSetting('platform_url', url);
    await ctx.reply(`✅ Ссылка на платформу сохранена:\n${url}`);
  });

  admin.command('setdate', async (ctx) => {
    const match = ctx.match.trim().match(/^(med|tech)\s+(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
    const startsAt = match && pragueTime(...(match.slice(2).map(Number) as [number, number, number, number, number]));
    if (!match || !startsAt) {
      await ctx.reply('Формат: /setdate med|tech ДД.ММ.ГГГГ ЧЧ:ММ\nНапример: /setdate med 23.11.2026 14:00');
      return;
    }
    if (startsAt.getTime() <= Date.now()) {
      await ctx.reply('❌ Эта дата уже прошла.');
      return;
    }
    const track = match[1] as Track;
    setSetting(masterClassStartKey(track), startsAt.toISOString());
    setMasterClassStart(track, startsAt);

    const userIds = segmentUserIds(track);
    for (const userId of userIds) {
      resetReminders(userId);
      const user = getUser(userId);
      if (user) scheduleReminders(user);
    }
    const mk = masterClasses[track];
    await ctx.reply(
      `✅ Мастер-класс (${labels.track[track]}) перенесён на ${mk.dateLabel}, ${mk.timeLabel} (по Праге).\nНапоминания пересозданы для ${userIds.length} чел.`,
    );
  });

  admin.command('admins', async (ctx) => {
    const lines = adminIds().map((id) => `• ${personLabel(id)}${isEnvAdmin(id) ? ' — главный (из .env)' : ''}`);
    await ctx.reply(`👮 Админы:\n\n${lines.join('\n')}`);
  });

  admin.command('addadmin', async (ctx) => {
    const userId = targetUserId(ctx);
    if (!userId) {
      await ctx.reply('Формат: /addadmin <telegram id>\nИли ответь /addadmin реплаем на пересланное сообщение пользователя.');
      return;
    }
    if (!addAdmin(userId)) {
      await ctx.reply(`${personLabel(userId)} уже админ.`);
      return;
    }
    const reachable = await setAdminMenu(ctx.api, userId);
    if (reachable) {
      await ctx.api.sendMessage(userId, '👮 Тебя добавили администратором бота. Список команд: /admin').catch(() => {});
    }
    await ctx.reply(
      `✅ ${personLabel(userId)} теперь админ.` +
        (reachable ? '' : '\n⚠️ Этот человек ещё не писал боту: пусть отправит боту /start, чтобы получать сообщения.'),
    );
  });

  admin.command('removeadmin', async (ctx) => {
    const userId = targetUserId(ctx);
    if (!userId) {
      await ctx.reply('Формат: /removeadmin <telegram id>');
      return;
    }
    const result = removeAdmin(userId);
    if (result === 'env') {
      await ctx.reply('❌ Этот админ задан в ADMIN_IDS в .env, его можно убрать только там.');
      return;
    }
    if (result === 'not_admin') {
      await ctx.reply(`${personLabel(userId)} не админ.`);
      return;
    }
    await ctx.api.deleteMyCommands({ scope: { type: 'chat', chat_id: userId } }).catch(() => {});
    await ctx.reply(`✅ ${personLabel(userId)} больше не админ.`);
  });

  admin.command('broadcast', async (ctx) => {
    const keyboard = new InlineKeyboard();
    for (const [segment, name] of Object.entries(segmentNames)) {
      keyboard.text(`${name} (${segmentUserIds(segment as Segment).length})`, `bc:seg:${segment}`).row();
    }
    keyboard.text('❌ Отмена', 'bc:cancel');
    await ctx.reply('📣 Кому отправить рассылку?', { reply_markup: keyboard });
  });

  admin.command('cancel', async (ctx) => {
    drafts.delete(ctx.from.id);
    await ctx.reply('Рассылка отменена.');
  });

  admin.callbackQuery(/^bc:seg:(all|med|tech|offline|online)$/, async (ctx) => {
    const segment = ctx.match[1] as Segment;
    drafts.set(ctx.from.id, { segment, stage: 'await_message' });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📣 Сегмент: ${segmentNames[segment]}\n\nПришли сообщение для рассылки: текст, фото с подписью или любое другое сообщение.\n/cancel — отмена`,
    );
  });

  admin.callbackQuery('bc:send', async (ctx) => {
    const draft = drafts.get(ctx.from.id);
    await ctx.answerCallbackQuery();
    if (draft?.stage !== 'await_confirm' || !draft.chatId || !draft.messageId) {
      await ctx.reply('Нет подготовленной рассылки. Начни заново: /broadcast');
      return;
    }
    drafts.delete(ctx.from.id);
    await ctx.editMessageText(`🚀 Рассылка запущена: ${segmentNames[draft.segment]}`);
    void runBroadcast(ctx.api, ctx.chat!.id, draft as Required<Draft>).catch((err) =>
      console.error('Ошибка рассылки:', err),
    );
  });

  admin.callbackQuery('bc:cancel', async (ctx) => {
    drafts.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Рассылка отменена.');
  });

  admin.on('message', async (ctx, next) => {
    const draft = drafts.get(ctx.from.id);
    if (draft?.stage === 'await_message' && !ctx.message.text?.startsWith('/')) {
      draft.stage = 'await_confirm';
      draft.chatId = ctx.chat.id;
      draft.messageId = ctx.message.message_id;
      const count = segmentUserIds(draft.segment).length;
      await ctx.reply('👀 Предпросмотр:');
      await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);
      await ctx.reply(`Отправить это сообщение сегменту «${segmentNames[draft.segment]}» (${count} чел.)?`, {
        reply_markup: new InlineKeyboard().text(`✅ Отправить (${count})`, 'bc:send').text('❌ Отмена', 'bc:cancel'),
      });
      return;
    }
    if (await handleReplyToUser(ctx)) return;
    await next();
  });
}
