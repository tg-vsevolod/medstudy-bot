import type { Bot, Context } from 'grammy';
import { setAdminMenu } from './admin.js';
import { adminIds, isAdmin } from './admins.js';
import { addLeadComment, lateRegistrationComment } from './bitrix.js';
import { channelId, isChannelMember } from './channel.js';
import { masterClasses } from './config.js';
import { cancelJob, getUser, updateUser, upsertUser, type Step, type User } from './db.js';
import {
  platformButton,
  sendPickButton,
  sendQuestion,
  sendRegistrationComplete,
  userMasterClass,
  type PlatformKind,
  type QuestionStep,
} from './messages.js';
import { scheduleReminders } from './scheduler.js';
import { appendRegistration, updateAttendance } from './sheets.js';
import * as t from './texts.js';

async function markAnswered(ctx: Context, answer: string): Promise<void> {
  const text = ctx.callbackQuery?.message?.text;
  try {
    if (text) await ctx.editMessageText(`${text}\n\n✅ ${answer}`);
    else await ctx.editMessageReplyMarkup();
  } catch {
    // Сообщение могло быть уже изменено или слишком старое для редактирования.
  }
}

async function answerQuestion(
  ctx: Context,
  expected: QuestionStep,
  answer: string,
  apply: (user: User) => Partial<User> & { step: Step },
): Promise<User | null> {
  const user = getUser(ctx.from!.id);
  if (!user || user.step !== expected) {
    await ctx.answerCallbackQuery({ text: t.staleButton });
    return null;
  }
  const updated = updateUser(user.id, apply(user));
  await ctx.answerCallbackQuery();
  await markAnswered(ctx, answer);
  return updated;
}

async function completeRegistration(ctx: Context, user: User): Promise<void> {
  cancelJob(user.id, 'no_answer');
  if (user.bitrix_lead_id) {
    void addLeadComment(user.bitrix_lead_id, lateRegistrationComment(user)).catch((err) =>
      console.error(`Не удалось дописать комментарий в лид ${user.bitrix_lead_id}:`, err),
    );
  }
  await sendRegistrationComplete(ctx.api, user);
  scheduleReminders(user);

  const row = await appendRegistration(user);
  if (row) updateUser(user.id, { sheet_row: row });
}

async function notifyAdmins(ctx: Context, text: string): Promise<void> {
  for (const adminId of adminIds()) {
    try {
      await ctx.api.sendMessage(adminId, text);
    } catch (err) {
      console.error(`Не удалось отправить сообщение админу ${adminId}:`, err);
    }
  }
}

export function registerFlow(bot: Bot): void {
  const pm = bot.chatType('private');

  pm.command('start', async (ctx) => {
    const { user } = upsertUser(ctx.from);
    if (isAdmin(user.id)) await setAdminMenu(ctx.api, user.id);

    if (user.step === 'registered') {
      await ctx.reply(t.alreadyRegistered(userMasterClass(user)));
      return;
    }
    await sendQuestion(ctx.api, user.id, user.step);
  });

  pm.callbackQuery(/^a:(self|child)$/, async (ctx) => {
    const applicant = ctx.match[1] as 'self' | 'child';
    const answer = applicant === 'self' ? t.buttons.applicantSelf : t.buttons.applicantChild;
    const user = await answerQuestion(ctx, 'q_applicant', answer, () => ({ applicant, step: 'q_track' }));
    if (user) await sendQuestion(ctx.api, user.id, 'q_track');
  });

  pm.callbackQuery(/^t:(med|tech)$/, async (ctx) => {
    const track = ctx.match[1] as 'med' | 'tech';
    const answer = track === 'med' ? t.buttons.trackMed : t.buttons.trackTech;
    const user = await answerQuestion(ctx, 'q_track', answer, () => ({ track, step: 'q_location' }));
    if (user) await sendQuestion(ctx.api, user.id, 'q_location');
  });

  pm.callbackQuery(/^l:(prague|relocating)$/, async (ctx) => {
    const location = ctx.match[1] as 'prague' | 'relocating';
    const answer = location === 'prague' ? t.buttons.locationPrague : t.buttons.locationRelocating;
    const user = await answerQuestion(ctx, 'q_location', answer, () => ({
      location,
      step: 'registered',
      registered_at: Date.now(),
    }));
    if (user) await completeRegistration(ctx, user);
  });

  pm.callbackQuery(/^att:(offline|online)$/, async (ctx) => {
    const attendance = ctx.match[1] as 'offline' | 'online';
    const user = getUser(ctx.from.id);
    if (!user?.track) {
      await ctx.answerCallbackQuery();
      return;
    }
    const updated = updateUser(user.id, { attendance });
    await ctx.answerCallbackQuery();
    await markAnswered(ctx, attendance === 'offline' ? t.buttons.attendOffline : t.buttons.attendOnline);
    await ctx.reply(t.attendanceConfirmed(attendance, masterClasses[user.track]));
    await updateAttendance(updated);
  });

  pm.callbackQuery('r1h', async (ctx) => {
    await ctx.answerCallbackQuery();
    await markAnswered(ctx, t.buttons.remindHour);
    await ctx.reply(t.remindHourConfirmed);
  });

  pm.callbackQuery(/^join:(platform|access|trial)$/, async (ctx) => {
    if (channelId() && !(await isChannelMember(ctx.api, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: t.notJoinedAlert, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const reply_markup = platformButton(ctx.match[1] as PlatformKind);
    const text = ctx.callbackQuery.message?.text;
    if (text?.endsWith(t.joinChannelHint)) {
      await ctx.editMessageText(text.slice(0, -t.joinChannelHint.length).trimEnd(), { reply_markup });
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup });
    }
  });

  pm.callbackQuery(/.*/, (ctx) => ctx.answerCallbackQuery());

  pm.on('message', async (ctx) => {
    if (isAdmin(ctx.from.id) || ctx.message.text?.startsWith('/')) return;
    const { user } = upsertUser(ctx.from);

    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const username = ctx.from.username ? ` (@${ctx.from.username})` : '';
    const content = ctx.message.text ?? ctx.message.caption ?? '[вложение без текста]';
    await notifyAdmins(
      ctx,
      `✉️ Сообщение от ${name}${username} #id${user.id}\n\n${content}\n\n↩️ Ответь реплаем на это сообщение, чтобы ответить пользователю.`,
    );

    if (user.step === 'registered') await ctx.reply(t.questionReceived);
    else await sendPickButton(ctx.api, user.id, user.step);
  });
}
