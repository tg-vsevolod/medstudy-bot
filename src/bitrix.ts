import { env } from './config.js';
import type { Step, User } from './db.js';
import { labels } from './texts.js';

const RETRY_AFTER_MS = 5 * 60_000;
const failedAt = new Map<number, number>();

const stepNames: Record<Step, string> = {
  q_applicant: 'первый вопрос: кто поступает',
  q_track: 'второй вопрос: направление',
  q_location: 'третий вопрос: Прага или переезд',
  registered: 'зарегистрировался',
};

export function isBitrixEnabled(): boolean {
  return Boolean(env.bitrix.webhookUrl);
}

async function call<T>(method: string, body: object): Promise<T> {
  const base = env.bitrix.webhookUrl.endsWith('/') ? env.bitrix.webhookUrl : `${env.bitrix.webhookUrl}/`;
  const response = await fetch(`${base}${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string; error_description?: string };
  if (!response.ok || data.error || data.result === undefined) {
    throw new Error(`Битрикс24 ${method}: ${data.error ?? response.status} ${data.error_description ?? ''}`.trim());
  }
  return data.result;
}

function answersText(user: User): string[] {
  return [
    user.applicant && `Кто поступает: ${labels.applicant[user.applicant]}`,
    user.track && `Направление: ${labels.track[user.track]}`,
    user.location && `Прага или переезд: ${labels.location[user.location]}`,
  ].filter((line): line is string => Boolean(line));
}

function leadComments(user: User): string {
  const answers = answersText(user);
  return [
    `Telegram ID: ${user.id}`,
    user.username ? `Telegram: @${user.username} (https://t.me/${user.username})` : 'Telegram: ника нет',
    `Остановился на шаге: ${stepNames[user.step]}`,
    answers.length ? `Ответы:\n${answers.join('\n')}` : 'Ответов нет',
    user.blocked ? 'Заблокировал бота' : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Возвращает null, если после прошлой ошибки для этого человека ещё не прошло RETRY_AFTER_MS. */
export async function createLead(user: User): Promise<number | null> {
  const lastFailure = failedAt.get(user.id);
  if (lastFailure && Date.now() - lastFailure < RETRY_AFTER_MS) return null;
  try {
    const leadId = await call<number>('crm.lead.add', {
      fields: {
        TITLE: 'Telegram-бот: не завершил регистрацию',
        NAME: user.first_name ?? '',
        SOURCE_ID: env.bitrix.sourceId,
        SOURCE_DESCRIPTION: 'Telegram-бот MedStudy',
        COMMENTS: leadComments(user),
        ...(user.username && { IM: [{ VALUE: `t.me/${user.username}`, VALUE_TYPE: 'TELEGRAM' }] }),
      },
    });
    failedAt.delete(user.id);
    return Number(leadId);
  } catch (err) {
    failedAt.set(user.id, Date.now());
    console.error(`Не удалось создать лид для ${user.id}:`, err);
    return null;
  }
}

export async function addLeadComment(leadId: number, text: string): Promise<void> {
  await call('crm.timeline.comment.add', { fields: { ENTITY_ID: leadId, ENTITY_TYPE: 'lead', COMMENT: text } });
}

export function lateRegistrationComment(user: User): string {
  return ['Зарегистрировался позже через бота.', ...answersText(user)].join('\n');
}
