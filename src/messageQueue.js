import dotenv from 'dotenv';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

dotenv.config();

if (!global.activeSessions) {
  global.activeSessions = new Map();
}

const MIN_DELAY_MS = 6000; // 1 message every 6 seconds (10 messages per minute)
const MAX_MESSAGES_PER_MINUTE = 10;
const RATE_LIMIT_DURATION_MS = 60000;

let connection = null;
let outboundQueue = null;
let messageWorker = null;
let isRedisReady = false;

// Initialize Redis & BullMQ Queue + Worker with strict rate-limiting (10 msgs / 60,000ms)
if (process.env.REDIS_URL) {
  try {
    connection = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 1000);
      }
    });

    connection.on('error', (err) => {
      console.warn('[Redis] Connection warning (fallback active):', err.message);
      isRedisReady = false;
    });

    connection.on('ready', () => {
      isRedisReady = true;
    });

    // 1. Define the Message Queue
    outboundQueue = new Queue('whatsapp-outbound', { connection });

    // 2. Create the Worker with strict rate-limiting
    messageWorker = new Worker(
      'whatsapp-outbound',
      async (job) => {
        const { sessionId, to, text, options = {}, messageId } = job.data;
        const socket = global.activeSessions.get(sessionId);

        if (!socket) {
          messageQueue.updateHistoryStatus(sessionId, messageId, 'FAILED', `Session ${sessionId} is offline.`);
          throw new Error(`Session ${sessionId} is offline.`);
        }

        // Format phone number and send via Baileys socket
        const cleanNumber = to.replace(/[^0-9]/g, '');
        const formattedTo = to.includes('@') ? to : `${cleanNumber}@c.us`;
        const baileysJid = formattedTo.endsWith('@c.us')
          ? formattedTo.replace('@c.us', '@s.whatsapp.net')
          : formattedTo;

        const result = await socket.sendMessage(baileysJid, { text }, options);
        const waId = result?.key?.id;
        messageQueue.updateHistoryStatus(sessionId, messageId, 'SENT', null, waId);
        console.log(`[Queue] Message delivered to ${to} for session ${sessionId} (WA ID: ${waId})`);
      },
      {
        connection,
        limiter: {
          max: MAX_MESSAGES_PER_MINUTE,      // Maximum 10 messages
          duration: RATE_LIMIT_DURATION_MS   // Per 60,000 milliseconds (1 minute)
        }
      }
    );

    messageWorker.on('error', (err) => {
      console.warn('[BullMQ Worker] Warning:', err.message);
    });
  } catch (err) {
    console.warn('[BullMQ] Initialization fallback:', err.message);
  }
}

class SessionQueue {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.queue = [];
    this.isProcessing = false;
    this.rateLimitTimestamps = [];
    this.history = [];
    this.inbox = [];
  }

  getRateLimitStatus() {
    const now = Date.now();
    this.rateLimitTimestamps = this.rateLimitTimestamps.filter((t) => now - t < RATE_LIMIT_DURATION_MS);
    const count = this.rateLimitTimestamps.length;
    const isLimited = count >= MAX_MESSAGES_PER_MINUTE;
    const oldestTimestamp = this.rateLimitTimestamps[0] || now;
    const retryAfterMs = isLimited ? Math.max(0, RATE_LIMIT_DURATION_MS - (now - oldestTimestamp)) : 0;
    return { count, max: MAX_MESSAGES_PER_MINUTE, isLimited, retryAfterMs };
  }

  recordHistory(item) {
    const existingIndex = this.history.findIndex((h) => h.id === item.id);
    const record = {
      id: item.id,
      sessionId: item.sessionId,
      to: item.to,
      text: item.text,
      status: item.status,
      queuedAt: item.queuedAt,
      timestamp: item.queuedAt,
      sentAt: item.sentAt,
      delayMsApplied: item.delayMsApplied,
      waId: item.waId,
      error: item.error,
    };

    if (existingIndex >= 0) {
      this.history[existingIndex] = record;
    } else {
      this.history.unshift(record);
      if (this.history.length > 100) this.history.pop();
    }
  }

  recordInbound(msg) {
    const record = {
      id: msg.key.id,
      remoteJid: msg.key.remoteJid,
      pushName: msg.pushName,
      text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
      timestamp: msg.messageTimestamp,
      fullMessage: msg
    };
    this.inbox.unshift(record);
    if (this.inbox.length > 100) this.inbox.pop();
    return record;
  }

  async enqueueMessage(getSocketFn, to, text, options = {}) {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const queuedAt = new Date().toISOString();

    const queueItem = {
      id: messageId,
      sessionId: this.sessionId,
      to,
      text,
      options,
      status: 'QUEUED',
      queuedAt,
      sentAt: null,
      delayMsApplied: 0,
      error: null,
      waId: null,
      getSocketFn,
    };

    this.recordHistory(queueItem);

    // If BullMQ + Redis connection is live, add job to BullMQ 'whatsapp-outbound' queue
    if (outboundQueue && isRedisReady) {
      try {
        const sock = getSocketFn ? getSocketFn() : null;
        if (sock) {
          global.activeSessions.set(this.sessionId, sock);
        }
        const bullJob = await outboundQueue.add('send-message', {
          sessionId: this.sessionId,
          to,
          text,
          options,
          messageId,
        });
        this.rateLimitTimestamps.push(Date.now());
        return {
          id: bullJob.id || messageId,
          messageId,
          status: 'QUEUED',
          queuePosition: this.rateLimitTimestamps.length,
          estimatedDelayMs: Math.max(0, (this.rateLimitTimestamps.length - 1) * MIN_DELAY_MS),
        };
      } catch (err) {
        console.warn('[BullMQ] Redis enqueue failed, falling back to local limiter:', err.message);
      }
    }

    // Fallback local worker with identical 10 messages / 60,000ms limiter
    const promise = new Promise((resolve, reject) => {
      queueItem.resolve = resolve;
      queueItem.reject = reject;
    });

    this.queue.push(queueItem);
    this.processQueue();

    return {
      id: messageId,
      messageId,
      status: 'QUEUED',
      queuePosition: this.queue.length,
      estimatedDelayMs: (this.queue.length - 1) * MIN_DELAY_MS,
      promise,
    };
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue[0];
      const socket = (item.getSocketFn && item.getSocketFn()) || global.activeSessions.get(this.sessionId);

      if (!socket) {
        item.status = 'FAILED';
        item.error = `Session ${this.sessionId} is offline.`;
        this.recordHistory(item);
        if (item.reject) item.reject(new Error(item.error));
        this.queue.shift();
        continue;
      }

      item.status = 'SENDING';
      this.recordHistory(item);

      try {
        const cleanNumber = item.to.replace(/[^0-9]/g, '');
        const formattedTo = `${cleanNumber}@s.whatsapp.net`;

        const sentResult = await socket.sendMessage(formattedTo, { text: item.text }, item.options);
        const waId = sentResult?.key?.id;
        this.rateLimitTimestamps.push(Date.now());

        item.delayMsApplied = MIN_DELAY_MS;
        item.sentAt = new Date().toISOString();
        item.status = 'SENT';
        item.waId = waId;
        this.recordHistory(item);
        console.log(`[Queue] Message delivered to ${item.to} for session ${this.sessionId} (WA ID: ${waId})`);

        if (item.resolve) {
          item.resolve({ messageId: item.id, status: 'SENT', sentAt: item.sentAt, whatsappResult: sentResult });
        }
      } catch (err) {
        item.status = 'FAILED';
        item.error = err.message;
        this.recordHistory(item);
        if (item.reject) item.reject(err);
      }

      this.queue.shift();

      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS));
      }
    }

    this.isProcessing = false;
  }

  getHistory() {
    return this.history;
  }
}

class MessageQueueManager {
  constructor() {
    this.sessionQueues = new Map();
  }

  getQueue(sessionId) {
    if (!this.sessionQueues.has(sessionId)) {
      this.sessionQueues.set(sessionId, new SessionQueue(sessionId));
    }
    return this.sessionQueues.get(sessionId);
  }

  // Standard BullMQ-compatible .add() method
  async add(jobName, data, opts = {}) {
    const { sessionId = 'wak_default', to, text, options = {} } = data;
    const getSocketFn = () => global.activeSessions.get(sessionId) || null;
    return await this.enqueue(sessionId, getSocketFn, to, text, options);
  }

  async enqueue(sessionId, getSocketFn, to, text, options = {}) {
    const queue = this.getQueue(sessionId);
    return await queue.enqueueMessage(getSocketFn, to, text, options);
  }

  updateHistoryStatus(sessionId, messageId, status, error = null, waId = null) {
    if (!messageId && !waId) return;
    const queue = this.getQueue(sessionId);
    const existing = waId 
      ? queue.history.find((h) => h.waId === waId)
      : queue.history.find((h) => h.id === messageId);
    
    if (existing) {
      existing.status = status;
      if (status === 'SENT') {
        existing.sentAt = new Date().toISOString();
        if (waId) existing.waId = waId;
      }
      if (error) existing.error = error;
      return existing;
    }
    return null;
  }

  getMessageByWaId(sessionId, waId) {
    const queue = this.getQueue(sessionId);
    return queue.history.find((h) => h.waId === waId);
  }

  getMessageStatus(sessionId, messageId) {
    const queue = this.getQueue(sessionId);
    return queue.history.find((h) => h.id === messageId);
  }

  getHistory(sessionId) {
    const queue = this.sessionQueues.get(sessionId);
    return queue ? queue.getHistory() : [];
  }

  getInbox(sessionId) {
    const queue = this.sessionQueues.get(sessionId);
    return queue ? queue.inbox : [];
  }

  recordInbound(sessionId, msg) {
    const queue = this.getQueue(sessionId);
    return queue.recordInbound(msg);
  }
}

export const messageQueue = new MessageQueueManager();
export { messageWorker, outboundQueue };
