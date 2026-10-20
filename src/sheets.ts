import { google, type sheets_v4 } from 'googleapis';
import { TIME_ZONE, env } from './config.js';
import type { User } from './db.js';
import { labels } from './texts.js';

const HEADER = [
  'Дата регистрации',
  'Telegram ID',
  'Username',
  'Имя',
  'Кто поступает',
  'Направление',
  'Прага / переезд',
  'Формат участия',
];

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: TIME_ZONE,
});

let client: sheets_v4.Sheets | null = null;
let headerReady = false;

function getClient(): sheets_v4.Sheets | null {
  if (!env.google.sheetId || !env.google.credentialsFile) return null;
  if (!client) {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.google.credentialsFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    client = google.sheets({ version: 'v4', auth });
  }
  return client;
}

function range(cells: string): string {
  return `'${env.google.sheetName}'!${cells}`;
}

async function ensureHeader(sheets: sheets_v4.Sheets): Promise<void> {
  if (headerReady) return;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.google.sheetId, range: range('A1:H1') });
  if (!res.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.google.sheetId,
      range: range('A1:H1'),
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  }
  headerReady = true;
}

function toRow(user: User): string[] {
  return [
    dateFormat.format(new Date(user.registered_at ?? Date.now())),
    String(user.id),
    user.username ? `@${user.username}` : '',
    user.first_name ?? '',
    user.applicant ? labels.applicant[user.applicant] : '',
    user.track ? labels.track[user.track] : '',
    user.location ? labels.location[user.location] : '',
    user.attendance ? labels.attendance[user.attendance] : '',
  ];
}

/** Возвращает номер строки в таблице или null, если Sheets не настроен или запрос не удался. */
export async function appendRegistration(user: User): Promise<number | null> {
  const sheets = getClient();
  if (!sheets) return null;
  try {
    await ensureHeader(sheets);
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: env.google.sheetId,
      range: range('A:H'),
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [toRow(user)] },
    });
    const match = res.data.updates?.updatedRange?.match(/![A-Z]+(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (err) {
    console.error(`Google Sheets: не удалось добавить пользователя ${user.id}:`, err);
    return null;
  }
}

export async function updateAttendance(user: User): Promise<void> {
  const sheets = getClient();
  if (!sheets || !user.sheet_row || !user.attendance) return;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.google.sheetId,
      range: range(`H${user.sheet_row}`),
      valueInputOption: 'RAW',
      requestBody: { values: [[labels.attendance[user.attendance]]] },
    });
  } catch (err) {
    console.error(`Google Sheets: не удалось обновить формат участия ${user.id}:`, err);
  }
}
