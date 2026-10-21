import { InlineKeyboard, type Api } from 'grammy';
import { channelId, channelUrl, isChannelMember } from './channel.js';
import { env, masterClasses, type MasterClass, type Track } from './config.js';
import { getSetting, scheduleJob, updateUser, type Step, type User } from './db.js';
import { remindDelayMin } from './delays.js';
import * as t from './texts.js';

export type QuestionStep = Exclude<Step, 'registered'>;

export function platformUrl(): string | null {
  return getSetting('platform_url') ?? (env.platformUrl || null);
}

export function streamLink(track: Track): string | null {
  return getSetting(`stream_link_${track}`);
}

const questions: Record<QuestionStep, { text: string; keyboard: () => InlineKeyboard }> = {
  q_applicant: {
    text: t.questionApplicant,
    keyboard: () =>
      new InlineKeyboard().text(t.buttons.applicantSelf, 'a:self').row().text(t.buttons.applicantChild, 'a:child'),
  },
  q_track: {
    text: t.questionTrack,
    keyboard: () => new InlineKeyboard().text(t.buttons.trackMed, 't:med').row().text(t.buttons.trackTech, 't:tech'),
  },
  q_location: {
    text: t.questionLocation,
    keyboard: () =>
      new InlineKeyboard()
        .text(t.buttons.locationPrague, 'l:prague')
        .row()
        .text(t.buttons.locationRelocating, 'l:relocating'),
  },
};

export async function sendQuestion(api: Api, userId: number, step: QuestionStep): Promise<void> {
  const question = questions[step];
  await api.sendMessage(userId, question.text, { reply_markup: question.keyboard() });
  updateUser(userId, { last_question_at: Date.now() });
  scheduleJob(userId, 'no_answer', Date.now() + remindDelayMin() * 60_000);
}

export async function sendNoAnswer(api: Api, userId: number, step: QuestionStep): Promise<void> {
  await api.sendMessage(userId, t.noAnswer(t.shortQuestions[step]), { reply_markup: questions[step].keyboard() });
}

export async function sendPickButton(api: Api, userId: number, step: QuestionStep): Promise<void> {
  await api.sendMessage(userId, t.pickButton, { reply_markup: questions[step].keyboard() });
}

export type PlatformKind = 'platform' | 'access' | 'trial';

const platformLabels: Record<PlatformKind, string> = {
  platform: t.buttons.platform,
  access: t.buttons.getAccess,
  trial: t.buttons.getTrial,
};

export function platformButton(kind: PlatformKind): InlineKeyboard | undefined {
  const url = platformUrl();
  if (!url) {
    console.warn('Ссылка на платформу не задана: используй /setplatform или PLATFORM_URL');
    return undefined;
  }
  return new InlineKeyboard().url(platformLabels[kind], url);
}

/** Пока бот не подключён к группе, проверить вступление нельзя, поэтому ссылка на платформу даётся сразу. */
async function platformKeyboard(
  api: Api,
  userId: number,
  kind: PlatformKind,
): Promise<{ keyboard?: InlineKeyboard; hint?: string }> {
  const keyboard = platformButton(kind);
  const joinUrl = channelUrl();
  if (!keyboard || !joinUrl) return { keyboard };
  if (!channelId()) {
    console.warn('Бот не подключён к группе: добавь его админом в группу из /setchannel или CHANNEL_URL');
    return { keyboard: keyboard.row().url(t.buttons.joinChannel, joinUrl), hint: t.joinChannelSoftHint };
  }
  if (await isChannelMember(api, userId)) return { keyboard };
  return {
    keyboard: new InlineKeyboard()
      .url(t.buttons.joinChannel, joinUrl)
      .row()
      .text(t.buttons.joinedChannel, `join:${kind}`),
    hint: t.joinChannelHint,
  };
}

function withHint(text: string, hint?: string): string {
  return hint ? `${text}\n\n${hint}` : text;
}

export async function sendRegistrationComplete(api: Api, user: User): Promise<void> {
  const { keyboard, hint } = await platformKeyboard(api, user.id, 'platform');
  await api.sendMessage(user.id, withHint(t.bonus(Boolean(keyboard)), hint), { reply_markup: keyboard });
  await api.sendMessage(user.id, t.registrationConfirmed(userMasterClass(user)));
}

export function userMasterClass(user: User): MasterClass {
  if (!user.track) throw new Error(`У пользователя ${user.id} не выбрано направление`);
  return masterClasses[user.track];
}

export async function sendReminder3Days(api: Api, user: User): Promise<void> {
  await api.sendMessage(user.id, t.reminder3Days(user.first_name || 'друг', userMasterClass(user)), {
    reply_markup: new InlineKeyboard().text(t.buttons.remindHour, 'r1h'),
  });
}

export async function sendReminderDay(api: Api, user: User): Promise<void> {
  await api.sendMessage(user.id, t.reminderDay(userMasterClass(user)), {
    reply_markup: new InlineKeyboard()
      .text(t.buttons.attendOffline, 'att:offline')
      .row()
      .text(t.buttons.attendOnline, 'att:online'),
  });
}

export async function sendReminderHour(api: Api, user: User): Promise<void> {
  await api.sendMessage(user.id, t.reminderHour(userMasterClass(user)));
}

export async function sendReminderFiveMinutes(api: Api, user: User): Promise<void> {
  const link = streamLink(userMasterClass(user).track);
  if (!link) console.warn(`Ссылка на трансляцию ${user.track} не задана: используй /setlink`);
  await api.sendMessage(user.id, t.reminderFiveMinutes(link));
}

export async function sendMasterClassEnded(api: Api, user: User): Promise<void> {
  const { keyboard, hint } = await platformKeyboard(api, user.id, 'access');
  await api.sendMessage(user.id, withHint(t.masterClassEnded, hint), { reply_markup: keyboard });
}

export async function sendTrialOffer(api: Api, user: User): Promise<void> {
  const { keyboard, hint } = await platformKeyboard(api, user.id, 'trial');
  await api.sendMessage(user.id, withHint(t.trialOffer, hint), { reply_markup: keyboard });
}
