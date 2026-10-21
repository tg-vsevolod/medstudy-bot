import 'dotenv/config';

export type Track = 'med' | 'tech';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

export const env = {
  botToken: required('BOT_TOKEN'),
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0),
  dbPath: process.env.DB_PATH ?? 'data/bot.db',
  platformUrl: process.env.PLATFORM_URL ?? '',
  channelUrl: process.env.CHANNEL_URL ?? '',
  noAnswerDelayMin: Number(process.env.NO_ANSWER_DELAY_MIN ?? 30),
  leadDelayMin: Number(process.env.LEAD_DELAY_MIN ?? 60),
  bitrix: {
    webhookUrl: process.env.BITRIX_WEBHOOK_URL ?? '',
    sourceId: process.env.BITRIX_SOURCE_ID || 'OTHER',
  },
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID ?? '',
    sheetName: process.env.GOOGLE_SHEET_NAME ?? 'Регистрации',
    credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  },
};

export const TIME_ZONE = 'Europe/Prague';
export const PLACE = 'Прага, школа MedStudy';
export const ADDRESS = 'Politických vězňů 911/8, 3 этаж';

export interface MasterClass {
  track: Track;
  direction: string;
  title: string;
  subjects: string;
  startsAt: Date;
  durationMin: number;
  dateLabel: string;
  timeLabel: string;
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: TIME_ZONE });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

/** Время по Праге в виде «как будто UTC»: разница с настоящим временем и есть смещение пояса. */
function pragueWallClock(ms: number): number {
  const parts = Object.fromEntries(partsFormat.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/** Возвращает null для несуществующей даты (31.02) или времени, пропущенного при переходе на летнее время. */
export function pragueTime(day: number, month: number, year: number, hour: number, minute: number): Date | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1 || hour > 23 || minute > 59) return null;
  let utc = wall - (pragueWallClock(wall) - wall);
  utc = wall - (pragueWallClock(utc) - utc);
  return pragueWallClock(utc) === wall ? new Date(utc) : null;
}

function masterClass(
  track: Track,
  startsAtIso: string,
  rest: Pick<MasterClass, 'direction' | 'title' | 'subjects'>,
): MasterClass {
  const startsAt = new Date(startsAtIso);
  if (Number.isNaN(startsAt.getTime())) throw new Error(`Неверная дата мастер-класса ${track}: ${startsAtIso}`);
  return {
    track,
    ...rest,
    startsAt,
    durationMin: Number(process.env.MK_DURATION_MIN ?? 120),
    dateLabel: dateFormat.format(startsAt),
    timeLabel: timeFormat.format(startsAt),
  };
}

export const masterClasses: Record<Track, MasterClass> = {
  med: masterClass('med', process.env.MED_STARTS_AT ?? '2026-11-23T14:00:00+01:00', {
    direction: 'Медицина и стоматология',
    title: 'Поступление в чешский медицинский ВУЗ',
    subjects: 'чешскому, биологии, химии и физике',
  }),
  tech: masterClass('tech', process.env.TECH_STARTS_AT ?? '2026-11-26T16:00:00+01:00', {
    direction: 'Технические и IT специальности',
    title: 'Поступление в чешский технический ВУЗ',
    subjects: 'чешскому, математике и физике',
  }),
};

export function setMasterClassStart(track: Track, startsAt: Date): void {
  Object.assign(masterClasses[track], {
    startsAt,
    dateLabel: dateFormat.format(startsAt),
    timeLabel: timeFormat.format(startsAt),
  });
}
