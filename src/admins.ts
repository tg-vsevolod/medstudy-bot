import { env, setMasterClassStart, type Track } from './config.js';
import { getSetting, setSetting } from './db.js';

function addedAdminIds(): number[] {
  return (getSetting('admin_ids') ?? '')
    .split(',')
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

export function adminIds(): number[] {
  return [...new Set([...env.adminIds, ...addedAdminIds()])];
}

export function isAdmin(userId: number | undefined): boolean {
  return userId !== undefined && adminIds().includes(userId);
}

export function isEnvAdmin(userId: number): boolean {
  return env.adminIds.includes(userId);
}

/** Возвращает false, если пользователь уже админ. */
export function addAdmin(userId: number): boolean {
  if (isAdmin(userId)) return false;
  setSetting('admin_ids', [...addedAdminIds(), userId].join(','));
  return true;
}

/** Админов из ADMIN_IDS удалить нельзя, иначе можно случайно потерять доступ к боту. */
export function removeAdmin(userId: number): 'removed' | 'env' | 'not_admin' {
  if (isEnvAdmin(userId)) return 'env';
  const added = addedAdminIds();
  if (!added.includes(userId)) return 'not_admin';
  setSetting('admin_ids', added.filter((id) => id !== userId).join(','));
  return 'removed';
}

export function masterClassStartKey(track: Track): string {
  return `mk_starts_at_${track}`;
}

export function loadMasterClassDates(): void {
  for (const track of ['med', 'tech'] as const) {
    const iso = getSetting(masterClassStartKey(track));
    const startsAt = iso ? new Date(iso) : null;
    if (startsAt && !Number.isNaN(startsAt.getTime())) setMasterClassStart(track, startsAt);
  }
}
