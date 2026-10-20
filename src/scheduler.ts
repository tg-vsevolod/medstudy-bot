import { GrammyError, type Api } from 'grammy';
import { masterClasses } from './config.js';
import { dueJobs, getUser, markJobSent, scheduleJob, updateUser, type Job, type JobKind, type User } from './db.js';
import {
  sendMasterClassEnded,
  sendNoAnswer,
  sendReminder3Days,
  sendReminderDay,
  sendReminderFiveMinutes,
  sendReminderHour,
  sendTrialOffer,
} from './messages.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_MS = 30_000;

const senders: Record<Exclude<JobKind, 'no_answer'>, (api: Api, user: User) => Promise<void>> = {
  remind_3d: sendReminder3Days,
  remind_1d: sendReminderDay,
  remind_1h: sendReminderHour,
  remind_5m: sendReminderFiveMinutes,
  mk_end: sendMasterClassEnded,
  trial_offer: sendTrialOffer,
};

export function scheduleReminders(user: User): void {
  if (!user.track) return;
  const mk = masterClasses[user.track];
  const start = mk.startsAt.getTime();
  const end = start + mk.durationMin * MINUTE;

  const plan: [JobKind, number, number | null][] = [
    ['remind_3d', start - 3 * DAY, start],
    ['remind_1d', start - DAY, start],
    ['remind_1h', start - HOUR, start],
    ['remind_5m', start - 5 * MINUTE, start + 30 * MINUTE],
    ['mk_end', end, null],
    ['trial_offer', end + HOUR, null],
  ];

  const now = Date.now();
  for (const [kind, runAt, expiresAt] of plan) {
    if (runAt > now) scheduleJob(user.id, kind, runAt, expiresAt);
  }
}

async function runJob(api: Api, job: Job): Promise<void> {
  const user = getUser(job.user_id);
  if (!user || user.blocked) return;
  if (job.expires_at && Date.now() > job.expires_at) return;

  if (job.kind === 'no_answer') {
    if (user.step !== 'registered') await sendNoAnswer(api, user.id, user.step);
    return;
  }
  if (user.step !== 'registered') return;
  await senders[job.kind](api, user);
}

let running = false;

async function tick(api: Api): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const job of dueJobs(Date.now())) {
      markJobSent(job.id);
      try {
        await runJob(api, job);
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 403) {
          updateUser(job.user_id, { blocked: 1 });
        } else {
          console.error(`Ошибка задачи ${job.kind} для ${job.user_id}:`, err);
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduler(api: Api): void {
  void tick(api);
  setInterval(() => void tick(api), TICK_MS);
}
