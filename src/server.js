import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { authManager } from './authManager.js';
import { sessionManager } from './sessionManager.js';
import { messageQueue } from './messageQueue.js';
import { webhookManager } from './webhookManager.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(express.json());

  // Attach req.userSession for API consumers
  app.use('/api/v1', (req, res, next) => {
    const resolvedSessionId =
      (req.body && req.body.sessionId) ||
      req.headers['x-api-key'] ||
      req.query.apiKey ||
      'wak_default';
    req.userSession = {
      session_id: resolvedSessionId
    };
    const session = sessionManager.getSession(resolvedSessionId);
    if (session && session.socket) {
      global.activeSessions.set(resolvedSessionId, session.socket);
    }
    next();
  });

  // Root Health-Check Route
  app.get('/', (req, res) => {
    res.status(200).send('Fast Odd Backend is active!');
  });

  // API Routes
  app.post('/api/v1/auth/signup', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
      }
      const result = await authManager.signUp(email, password);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/auth/signin', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
      }
      const result = await authManager.signIn(email, password);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/auth/me', async (req, res) => {
    try {
      const token = req.headers['x-auth-token'];
      const user = await authManager.verifyToken(token);
      if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      res.json({ success: true, user });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/session/sandbox', async (req, res) => {
    try {
      const { apiKey, sessionId } = req.body;
      const finalApiKey = apiKey || 'wak_default';
      const finalSessionId = sessionId || finalApiKey;

      // Register mock connected session in SessionManager
      const sessionObj = {
        socket: null,
        status: 'CONNECTED',
        qrCode: null,
        pairingCode: null,
        user: { id: '2348000000000', name: 'WhatsApp Sandbox Agent' }
      };
      sessionManager.sessions.set(finalSessionId, sessionObj);
      global.activeSessions.set(finalSessionId, { isSandbox: true });

      res.json({
        success: true,
        apiKey: finalApiKey,
        sessionId: finalSessionId,
        status: 'CONNECTED',
        user: sessionObj.user,
        message: 'Sandbox WhatsApp session connected successfully.'
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/session/start', async (req, res) => {
    try {
      const { apiKey, sessionId, forceRefreshQr } = req.body;
      const finalApiKey = apiKey || 'wak_default';
      const finalSessionId = sessionId || finalApiKey;

      const existing = sessionManager.getSession(finalSessionId);
      const forceNew = Boolean(forceRefreshQr) || !existing || existing.status !== 'CONNECTED';
      const sessionObj = await sessionManager.startSession(finalSessionId, finalApiKey, forceNew);
      res.json({
        success: true,
        apiKey: finalApiKey,
        sessionId: finalSessionId,
        status: sessionObj.status,
        qrCode: sessionObj.qrCode,
        qrCreatedAt: sessionObj.qrCreatedAt,
        pairingCode: sessionObj.pairingCode,
        user: sessionObj.user,
        message: sessionObj.status === 'CONNECTED' ? 'WhatsApp session connected successfully.' : 'QR code generated. Please scan with WhatsApp.'
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/session/pairing-code', async (req, res) => {
    try {
      const { apiKey, sessionId, phoneNumber } = req.body;
      const finalApiKey = apiKey || 'wak_default';
      const finalSessionId = sessionId || finalApiKey;

      const result = await sessionManager.requestPairingCode(finalSessionId, finalApiKey, phoneNumber);
      res.json({
        success: true,
        apiKey: finalApiKey,
        sessionId: finalSessionId,
        status: result.status,
        pairingCode: result.pairingCode,
        user: result.user || null,
        message: 'Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number instead.'
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/session/status', async (req, res) => {
    try {
      const apiKey = req.query.apiKey || req.headers['x-api-key'] || 'wak_default';
      const sessionId = apiKey;
      const sessionObj = sessionManager.getSession(sessionId);

      if (!sessionObj) {
        return res.json({ success: true, status: 'DISCONNECTED', user: null, qrCode: null });
      }

      res.json({
        success: true,
        status: sessionObj.status,
        user: sessionObj.user,
        qrCode: sessionObj.qrCode,
        qrCreatedAt: sessionObj.qrCreatedAt,
        pairingCode: sessionObj.pairingCode
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/v1/session/logout', async (req, res) => {
    try {
      const sessionId =
        req.userSession?.session_id ||
        (req.body && (req.body.sessionId || req.body.apiKey)) ||
        req.headers['x-api-key'] ||
        'wak_default';
      await sessionManager.logoutSession(sessionId);
      res.json({ success: true, status: 'DISCONNECTED', message: 'Session logged out and disconnected.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/messages/send', async (req, res) => {
    try {
      const { to, text } = req.body;
      if (!to || !text) {
        return res.status(400).json({ success: false, error: 'Recipient "to" and "text" are required' });
      }
      const sessionId = req.userSession.session_id;

      // Instantly queue the message
      const job = await messageQueue.add('send-message', {
        sessionId,
        to,
        text
      });

      // Return fast response to API consumer
      res.status(202).json({
        success: true,
        message: 'Message queued for delivery.',
        jobId: job.id
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/messages/send-bulk', async (req, res) => {
    try {
      const { recipients, text: defaultText } = req.body;
      if (!Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ success: false, error: 'A non-empty "recipients" array is required' });
      }
      const sessionId = req.userSession.session_id;
      const jobs = [];

      for (const entry of recipients) {
        const to = typeof entry === 'string' ? entry : entry.to;
        const text = (typeof entry === 'object' && entry.text) ? entry.text : defaultText;
        if (!to || !text) continue;

        const job = await messageQueue.add('send-message', {
          sessionId,
          to,
          text
        });
        jobs.push({ to, jobId: job.id, status: 'QUEUED' });
      }

      if (jobs.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid recipient/message pairs found to queue' });
      }

      res.status(202).json({
        success: true,
        message: `${jobs.length} message(s) queued for delivery via BullMQ worker.`,
        totalQueued: jobs.length,
        estimatedTotalDurationSeconds: Math.max(0, (jobs.length - 1) * 6),
        jobs
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/messages/history', async (req, res) => {
    try {
      const apiKey = req.query.apiKey || req.headers['x-api-key'] || 'wak_default';
      const history = messageQueue.getHistory(apiKey);
      res.json({ success: true, history });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/messages/status/:messageId', async (req, res) => {
    try {
      const { messageId } = req.params;
      const apiKey = req.query.apiKey || req.headers['x-api-key'] || 'wak_default';
      const status = messageQueue.getMessageStatus(apiKey, messageId);
      if (!status) {
        return res.status(404).json({ success: false, error: 'Message not found in history' });
      }
      res.json({ success: true, status });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/messages/inbox', async (req, res) => {
    try {
      const apiKey = req.query.apiKey || req.headers['x-api-key'] || 'wak_default';
      const inbox = messageQueue.getInbox(apiKey);
      res.json({ success: true, inbox });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Queue Management API
  app.get('/api/v1/queue/tasks', async (req, res) => {
    try {
      if (!outboundQueue) return res.json({ success: true, tasks: [] });
      const waiting = await outboundQueue.getWaiting();
      const active = await outboundQueue.getActive();
      const failed = await outboundQueue.getFailed();

      const tasks = [
        ...waiting.map(j => ({ id: j.id, status: 'waiting', data: j.data, timestamp: j.timestamp })),
        ...active.map(j => ({ id: j.id, status: 'active', data: j.data, timestamp: j.timestamp })),
        ...failed.map(j => ({ id: j.id, status: 'failed', data: j.data, timestamp: j.timestamp, failedReason: j.failedReason }))
      ];
      res.json({ success: true, tasks });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/queue/tasks/:jobId/cancel', async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await outboundQueue.getJob(jobId);
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      await job.remove();
      res.json({ success: true, message: 'Job canceled' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/queue/tasks/:jobId/pause', async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await outboundQueue.getJob(jobId);
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      // "Pause" by moving to delayed (effectively paused)
      await job.moveToDelayed(Date.now() + 1000 * 60 * 60 * 24 * 30); // Delay for 30 days
      res.json({ success: true, message: 'Job paused' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/webhook/config', async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'] || 'wak_default';
      const { webhookUrl } = req.body;
      if (!webhookUrl) {
        return res.status(400).json({ success: false, error: 'webhookUrl is required' });
      }
      webhookManager.setWebhook(apiKey, webhookUrl);
      res.json({ success: true, message: 'Webhook URL configured successfully' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/v1/webhook/test', async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'] || 'wak_default';
      await webhookManager.dispatch(apiKey, 'ping.test', { message: 'Test webhook ping from WhatsApp API Gateway' });
      res.json({ success: true, message: 'Test webhook dispatched' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/v1/webhook/logs', async (req, res) => {
    try {
      const apiKey = req.query.apiKey || req.headers['x-api-key'] || 'wak_default';
      const logs = webhookManager.getLogs(apiKey);
      res.json({ success: true, logs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Setup Vite middleware for development or static serving for production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../dist')));
    app.get('/{*splat}', (req, res) => {
      res.sendFile(path.join(__dirname, '../dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] WhatsApp Gateway running on port ${PORT}`);
    
    // Restore sessions from database on startup
    sessionManager.restoreSessions();
  });
}

// Global Process Error Handlers for Production Stability
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer();
