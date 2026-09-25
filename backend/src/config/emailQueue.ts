// BullMQ background email queue (v1.5.0).
//
// Async Nodemailer dispatches (OTP, borrow confirmation, return confirmation,
// reminders) are enqueued here and processed by a BullMQ worker when Redis is
// configured. Without REDIS_URL the queue stays disabled and callers fall back
// to the existing direct `transporter.sendMail()` path, so local dev and the
// test suite are unaffected.
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';
import { REDIS_URL, isRedisEnabled } from './redis';
import { getSmtpUser, getSmtpPass } from '../services/emailService';

export interface EmailJobData {
  kind: string;
  mailOptions: Record<string, unknown>;
}

const QUEUE_NAME = 'cicr-email-queue';

let emailQueue: Queue<EmailJobData> | null = null;
let worker: Worker<EmailJobData> | null = null;
let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;

let isQueueDisabled = process.env.DISABLE_EMAIL_QUEUE === 'true';
let hasLoggedQuotaExceeded = false;
let lastWorkerErrorLogTime = 0;
let lastWorkerErrorMessage = '';

const isQuotaLimitError = (msg?: string): boolean => {
  if (!msg) return false;
  return /max requests limit exceeded|ERR max requests|quota exceeded|OOM command not allowed/i.test(msg);
};

const shutdownQueueDueToQuota = async (reason: string) => {
  if (hasLoggedQuotaExceeded) return;
  hasLoggedQuotaExceeded = true;
  isQueueDisabled = true;

  console.warn(
    `\n⚠️ [EMAIL QUEUE] Redis command limit reached: ${reason}.\n` +
    `   BullMQ background worker has been safely shut down to silence terminal spam.\n` +
    `   All email notifications will continue to send reliably via direct SMTP dispatches.\n`
  );

  try {
    if (worker) {
      const w = worker;
      worker = null;
      await w.close().catch(() => {});
    }
  } catch {}

  try {
    if (emailQueue) {
      const q = emailQueue;
      emailQueue = null;
      await q.close().catch(() => {});
    }
  } catch {}

  try {
    queueConnection?.disconnect();
    workerConnection?.disconnect();
  } catch {}
};

if (!isQueueDisabled && isRedisEnabled && REDIS_URL) {
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
  };

  let hasLoggedQueueConnError = false;
  queueConnection = new Redis(REDIS_URL, redisOptions);
  queueConnection.on('error', (err: Error) => {
    if (isQuotaLimitError(err.message)) {
      shutdownQueueDueToQuota(err.message);
      return;
    }
    if (!hasLoggedQueueConnError) {
      console.warn('[EMAIL QUEUE] Queue Redis error:', err.message);
      hasLoggedQueueConnError = true;
    }
  });

  let hasLoggedWorkerConnError = false;
  workerConnection = new Redis(REDIS_URL, redisOptions);
  workerConnection.on('error', (err: Error) => {
    if (isQuotaLimitError(err.message)) {
      shutdownQueueDueToQuota(err.message);
      return;
    }
    if (!hasLoggedWorkerConnError) {
      console.warn('[EMAIL QUEUE] Worker Redis error:', err.message);
      hasLoggedWorkerConnError = true;
    }
  });

  emailQueue = new Queue<EmailJobData>(QUEUE_NAME, { connection: queueConnection });
  emailQueue.on('error', (err: Error) => {
    if (isQuotaLimitError(err.message)) {
      shutdownQueueDueToQuota(err.message);
      return;
    }
    if (!hasLoggedQueueConnError) {
      console.warn('[EMAIL QUEUE] Queue instance error:', err.message);
      hasLoggedQueueConnError = true;
    }
  });

  // Lazily created on first job: emailService imports enqueueEmail from this
  // module, so resolving SMTP credentials at module top-level would read a
  // partially-initialized circular import (getSmtpUser is not a function yet).
  // Deferring to job time also picks up late-arriving env configuration.
  let workerTransporter: nodemailer.Transporter | null = null;
  const getWorkerTransporter = (): nodemailer.Transporter => {
    if (!workerTransporter) {
      workerTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        family: 4, // Force IPv4 to prevent ENETUNREACH on platforms without IPv6 routing
        auth: {
          user: getSmtpUser(),
          pass: getSmtpPass()
        },
        connectionTimeout: 10000,
        greetingTimeout: 8000,
        socketTimeout: 15000,
        tls: {
          rejectUnauthorized: false
        }
      } as any);
    }
    return workerTransporter;
  };

  worker = new Worker<EmailJobData>(
    QUEUE_NAME,
    async (job) => {
      const { kind, mailOptions } = job.data;
      if (process.env.DISABLE_ALL_EMAILS === 'true') {
        console.log(`[EMAIL QUEUE] Dispatches suppressed per configuration. Skipping job ${job.id}.`);
        return;
      }

      const finalOptions: nodemailer.SendMailOptions = {
        ...(mailOptions as nodemailer.SendMailOptions)
      };

      const info = await getWorkerTransporter().sendMail(finalOptions);
      console.log(
        `[EMAIL QUEUE] ${kind} sent to ${JSON.stringify(finalOptions.to)} (job ${job.id}) | messageId=${info.messageId} | accepted=${JSON.stringify(info.accepted || [])}`
      );
    },
    { connection: workerConnection, concurrency: 3 }
  );

  worker.on('error', (err: Error) => {
    if (isQuotaLimitError(err.message)) {
      shutdownQueueDueToQuota(err.message);
      return;
    }
    const now = Date.now();
    // Throttle worker errors so they never flood the console or logs
    if (err.message !== lastWorkerErrorMessage || now - lastWorkerErrorLogTime > 60000) {
      console.warn('[EMAIL QUEUE] Worker instance error:', err.message);
      lastWorkerErrorMessage = err.message;
      lastWorkerErrorLogTime = now;
    }
  });

  worker.on('failed', (job, err) => {
    if (isQuotaLimitError(err.message)) {
      shutdownQueueDueToQuota(err.message);
      return;
    }
    console.error(`[EMAIL QUEUE] ${job?.data?.kind} failed (job ${job?.id}): ${err.message}`);
  });

  console.log('⚡ BullMQ email queue enabled (Redis).');
}

export const isEmailQueueEnabled = (): boolean => !isQueueDisabled && emailQueue !== null;

export const enqueueEmail = async (kind: string, mailOptions: Record<string, unknown>): Promise<boolean> => {
  if (isQueueDisabled || !emailQueue) return false;
  try {
    await emailQueue.add(kind, { kind, mailOptions }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    return true;
  } catch (err: any) {
    if (isQuotaLimitError(err?.message)) {
      shutdownQueueDueToQuota(err?.message || 'max requests exceeded');
    } else {
      console.warn('[EMAIL QUEUE] enqueue failed (falling back to direct SMTP):', err.message);
    }
    return false;
  }
};
