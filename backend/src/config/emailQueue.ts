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

if (isRedisEnabled && REDIS_URL) {
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined
  };

  // Dedicated separate connections: BullMQ worker runs blocking commands,
  // so Queue and Worker must NEVER share the same ioredis client instance.
  const queueConnection = new Redis(REDIS_URL, redisOptions);
  queueConnection.on('error', (err: Error) => console.warn('[EMAIL QUEUE] Queue Redis error:', err.message));

  const workerConnection = new Redis(REDIS_URL, redisOptions);
  workerConnection.on('error', (err: Error) => console.warn('[EMAIL QUEUE] Worker Redis error:', err.message));

  emailQueue = new Queue<EmailJobData>(QUEUE_NAME, { connection: queueConnection });
  emailQueue.on('error', (err: Error) => console.warn('[EMAIL QUEUE] Queue instance error:', err.message));

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
      });
    }
    return workerTransporter;
  };

  const worker = new Worker<EmailJobData>(
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
    console.warn('[EMAIL QUEUE] Worker instance error:', err.message);
  });
  worker.on('failed', (job, err) => {
    console.error(`[EMAIL QUEUE] ${job?.data?.kind} failed (job ${job?.id}): ${err.message}`);
  });

  console.log('⚡ BullMQ email queue enabled (Redis).');
}

export const isEmailQueueEnabled = (): boolean => emailQueue !== null;

export const enqueueEmail = async (kind: string, mailOptions: Record<string, unknown>): Promise<boolean> => {
  if (!emailQueue) return false;
  try {
    await emailQueue.add(kind, { kind, mailOptions }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    return true;
  } catch (err: any) {
    console.error('[EMAIL QUEUE] enqueue failed:', err.message);
    return false;
  }
};
