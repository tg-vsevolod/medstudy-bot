import type { Api, Bot } from 'grammy';
import { adminIds, isAdmin } from './admins.js';
import { getSetting, setSetting } from './db.js';

export function channelId(): number | null {
  const value = Number(getSetting('channel_id'));
  return value ? value : null;
}

/** Telegram отдаёт участников канала только боту-админу этого канала. */
export async function isChannelMember(api: Api, userId: number): Promise<boolean> {
  const chatId = channelId();
  if (!chatId) return false;
  try {
    const member = await api.getChatMember(chatId, userId);
    if (member.status === 'restricted') return member.is_member;
    return member.status === 'creator' || member.status === 'administrator' || member.status === 'member';
  } catch (err) {
    console.error(`Не удалось проверить участие ${userId} в группе:`, err);
    return false;
  }
}

async function notifyAdmins(api: Api, text: string): Promise<void> {
  for (const adminId of adminIds()) {
    await api.sendMessage(adminId, text).catch((err) => console.error(`Не удалось уведомить админа ${adminId}:`, err));
  }
}

export function registerChannel(bot: Bot): void {
  bot.on('my_chat_member', async (ctx) => {
    const { chat, from, new_chat_member } = ctx.myChatMember;
    if (chat.type === 'private') return;
    const { title } = chat;

    if (new_chat_member.status === 'administrator' || new_chat_member.status === 'member') {
      // Иначе любой, кто добавит бота в свою группу, подменит группу для проверки.
      if (!isAdmin(from.id)) return;
      setSetting('channel_id', String(chat.id));
      await notifyAdmins(
        ctx.api,
        `✅ Бот подключён к группе «${title}». Теперь доступ к платформе выдаётся только после вступления в неё.`,
      );
      return;
    }

    if (channelId() === chat.id) {
      setSetting('channel_id', '');
      await notifyAdmins(
        ctx.api,
        `⚠️ Бота убрали из группы «${title}» или лишили прав. Проверка вступления отключена: добавь бота админом в группу снова.`,
      );
    }
  });
}
