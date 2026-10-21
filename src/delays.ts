import { env } from './config.js';
import { getSetting, setSetting } from './db.js';

export const MAX_DELAY_MIN = 7 * 24 * 60;

function minutesSetting(key: string, fallback: number): number {
  const value = Number(getSetting(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Через сколько минут без ответа приходит напоминание «Нет ответа». */
export function remindDelayMin(): number {
  return minutesSetting('remind_delay_min', env.noAnswerDelayMin);
}

/** Через сколько минут без ответа человек считается бросившим опрос и уходит лидом в Битрикс24. */
export function leadDelayMin(): number {
  return minutesSetting('lead_delay_min', env.leadDelayMin);
}

export function setRemindDelayMin(minutes: number): void {
  setSetting('remind_delay_min', String(minutes));
}

export function setLeadDelayMin(minutes: number): void {
  setSetting('lead_delay_min', String(minutes));
}
