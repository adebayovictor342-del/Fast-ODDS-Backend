import * as Baileys from 'baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { webhookManager } from './webhookManager.js';
import { supabase } from './supabaseClient.js';

const makeWASocket =
  typeof Baileys.makeWASocket === 'function'
    ? Baileys.makeWASocket
    : typeof Baileys.default === 'function'
    ? Baileys.default
    : Baileys.default?.default || Baileys.default?.makeWASocket;

const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = Baileys;

const logger = pino({ level: 'silent' });

// Cache the latest WhatsApp Web version so socket startup is instant
let cachedWaVersion = [2, 3000, 1043857760];
if (typeof fetchLatestBaileysVersion === 'function') {
  fetchLatestBaileysVersion()
    .then((res) => {
      if (res?.version) cachedWaVersion = res.version;
    })
    .catch(() => {});
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    if (!global.activeSessions) {
      global.activeSessions = new Map();
    }
    this.sessionsDir = path.resolve('./sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  async restoreSessions() {
    if (!supabase) return;
    try {
      console.log('[SessionManager] Restoring sessions from database...');
      const { data, error } = await supabase.from('whatsapp_sessions').select('*');
      if (error) throw error;

      if (data && data.length > 0) {
        for (const sessionRow of data) {
          const { session_id, key_id, data: credsData } = sessionRow;
          const sessionPath = path.join(this.sessionsDir, session_id);
          
          if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
          }
          
          const credsFile = path.join(sessionPath, 'creds.json');
          // Always write the latest creds from DB to local filesystem
          fs.writeFileSync(credsFile, JSON.stringify(credsData, null, 2));
          
          // Re-start the session background connection
          console.log(`[SessionManager] Re-pairing session: ${session_id}`);
          this.startSession(session_id, key_id, false, true).catch(err => {
            console.warn(`[SessionManager] Failed to restore session ${session_id}:`, err.message);
          });
        }
        console.log(`[SessionManager] Successfully initiated restoration for ${data.length} session(s).`);
      }
    } catch (err) {
      console.warn('[SessionManager] Database session restoration warning:', err.message);
    }
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Starts or reconnects a Baileys WhatsApp session.
   * @param {string} sessionId
   * @param {string} apiKey
   * @param {boolean} forceNew - If true and not registered, clears stale auth state to ensure a clean handshake
   * @param {boolean} isInternalReconnect - True when called automatically during the 515 restartRequired handshake
   */
  async startSession(sessionId, apiKey, forceNew = false, isInternalReconnect = false) {
    if (!forceNew && !isInternalReconnect && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      if (existing.status === 'CONNECTED') {
        return existing;
      }
      if (existing.status === 'SCAN_QR' && existing.qrCode && existing.socket) {
        return existing;
      }
    }

    // Clean up any previous socket listeners before creating a new socket
    if (this.sessions.has(sessionId)) {
      const prev = this.sessions.get(sessionId);
      if (prev?.socket) {
        try {
          prev.socket.ev.removeAllListeners();
          prev.socket.end(undefined);
        } catch (e) {}
      }
    }

    const sessionPath = path.join(this.sessionsDir, sessionId);

    // CRITICAL FIX: If starting a brand new QR pairing session (not an internal 515 post-scan restart),
    // check if existing credentials are unregistered/corrupted and wipe them so WhatsApp doesn't reject linking
    if (forceNew && !isInternalReconnect && fs.existsSync(sessionPath)) {
      try {
        const credsFile = path.join(sessionPath, 'creds.json');
        let isRegistered = false;
        if (fs.existsSync(credsFile)) {
          const credsJson = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
          isRegistered = Boolean(credsJson?.registered || credsJson?.me?.id);
        }
        if (!isRegistered) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      } catch (e) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const customSaveCreds = async () => {
      await saveCreds();
      try {
        if (supabase) {
          const credsPath = path.join(sessionPath, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
            await supabase.from('whatsapp_sessions').upsert(
              [
                {
                  session_id: sessionId,
                  key_id: apiKey,
                  data: credsData,
                  updated_at: new Date().toISOString()
                }
              ],
              { onConflict: 'session_id,key_id' }
            );
          }
        }
      } catch (dbErr) {
        console.warn('[SessionManager] Supabase upsert warning:', dbErr.message);
      }
    };

    const existingSession = this.sessions.get(sessionId);
    const sessionObj = existingSession || {
      socket: null,
      status: 'INITIALIZING',
      qrCode: null,
      qrCreatedAt: null,
      pairingCode: null,
      user: null,
      lastQR: null
    };

    if (forceNew && !isInternalReconnect && sessionObj.status !== 'CONNECTED') {
      sessionObj.qrCode = null;
      sessionObj.lastQR = null;
      sessionObj.pairingCode = null;
      sessionObj.status = 'INITIALIZING';
    }

    this.sessions.set(sessionId, sessionObj);

    let qrResolved = false;
    let resolveInitialWait;
    const initialWaitPromise = new Promise((resolve) => {
      resolveInitialWait = resolve;
    });

    try {
      if (typeof fetchLatestBaileysVersion === 'function') {
        try {
          const versionResult = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
          ]);
          if (versionResult?.version) {
            cachedWaVersion = versionResult.version;
          }
        } catch (e) {}
      }

      const authPayload = {
        creds: state.creds,
        keys:
          typeof makeCacheableSignalKeyStore === 'function'
            ? makeCacheableSignalKeyStore(state.keys, logger)
            : state.keys
      };

      const browserTuple =
        Browsers && typeof Browsers.ubuntu === 'function'
          ? Browsers.ubuntu('Chrome')
          : ['Ubuntu', 'Chrome', '22.04.4'];

      const sock = makeWASocket({
        version: cachedWaVersion,
        auth: authPayload,
        logger,
        printQRInTerminal: false,
        browser: browserTuple,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
      });

      sessionObj.socket = sock;

      sock.ev.on('creds.update', async () => {
        await customSaveCreds();
        if (state.creds?.me) {
          sessionObj.user = {
            id: state.creds.me.id.split(':')[0],
            name: state.creds.me.name || 'WhatsApp User'
          };
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          sessionObj.status = 'SCAN_QR';
          sessionObj.lastQR = qr;
          sessionObj.qrCreatedAt = Date.now();
          try {
            sessionObj.qrCode = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
          } catch (e) {
            console.error('[SessionManager] QR code generation error:', e);
          }
          if (!qrResolved) {
            qrResolved = true;
            resolveInitialWait();
          }
        }

        if (connection === 'open') {
          sessionObj.status = 'CONNECTED';
          sessionObj.qrCode = null;
          sessionObj.lastQR = null;
          sessionObj.pairingCode = null;
          global.activeSessions.set(sessionId, sock);
          const activeUser = sock.user || state.creds?.me;
          if (activeUser) {
            sessionObj.user = {
              id: activeUser.id.split(':')[0],
              name: activeUser.name || 'WhatsApp User'
            };
          }
          if (!qrResolved) {
            qrResolved = true;
            resolveInitialWait();
          }
          await webhookManager.dispatch(apiKey, 'session.connected', { user: sessionObj.user });
        }

        if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          global.activeSessions.delete(sessionId);

          // Do not reconnect if explicitly logged out via logoutSession
          if (!this.sessions.has(sessionId)) {
            return;
          }

          if (isLoggedOut) {
            // Device was logged out or rejected; clear auth state so next attempt is clean
            sessionObj.status = 'DISCONNECTED';
            sessionObj.qrCode = null;
            sessionObj.socket = null;
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            if (!qrResolved) {
              qrResolved = true;
              resolveInitialWait();
            }
            return;
          }

          // Status 515 (restartRequired) happens immediately after scanning QR code on phone!
          // We must reconnect immediately with isInternalReconnect = true to preserve the newly saved credentials!
          const isRestartRequired =
            statusCode === DisconnectReason.restartRequired ||
            statusCode === 515 ||
            Boolean(state.creds?.me);

          const delayMs = isRestartRequired ? 250 : 2500;
          setTimeout(() => {
            if (this.sessions.has(sessionId)) {
              this.startSession(sessionId, apiKey, false, true);
            }
          }, delayMs);
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
          for (const msg of messages) {
            if (!msg.key.fromMe) {
              const inboundRecord = messageQueue.recordInbound(apiKey, msg);
              await webhookManager.dispatch(apiKey, 'message.upsert', {
                remoteJid: msg.key.remoteJid,
                pushName: msg.pushName,
                message: msg.message,
                timestamp: msg.messageTimestamp,
                inboxRecord: inboundRecord
              });
            }
          }
        }
      });

      sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
          if (update.update.status) {
            const waId = update.key.id;
            const statusMap = {
              1: 'PENDING',
              2: 'SENT',
              3: 'DELIVERED',
              4: 'READ',
              5: 'PLAYED'
            };
            const newStatus = statusMap[update.update.status] || 'UNKNOWN';
            
            const messageRecord = messageQueue.updateHistoryStatus(sessionId, null, newStatus, null, waId);
            if (messageRecord) {
              await webhookManager.dispatch(apiKey, 'message.status.update', {
                messageId: messageRecord.id,
                waId: waId,
                status: newStatus,
                timestamp: new Date().toISOString(),
                remoteJid: update.key.remoteJid
              });
            }
          }
        }
      });

      // Wait up to 8 seconds for WhatsApp Web to emit the genuine QR code or open connection
      if (!isInternalReconnect) {
        await Promise.race([
          initialWaitPromise,
          new Promise((resolve) => setTimeout(resolve, 8000))
        ]);
      }
    } catch (err) {
      console.error('[SessionManager] Error starting session:', err);
      sessionObj.status = 'ERROR';
      sessionObj.error = err.message;
    }

    return sessionObj;
  }

  /**
   * Requests an 8-character WhatsApp Pairing Code for linking via phone number
   * ("Link with phone number instead")
   */
  async requestPairingCode(sessionId, apiKey, phoneNumber) {
    const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 7) {
      throw new Error('Please provide a valid phone number in international format (e.g. 2348012345678)');
    }

    // Start a fresh session so credentials are clean for phone pairing
    const sessionObj = await this.startSession(sessionId, apiKey, true, false);
    if (sessionObj.status === 'CONNECTED') {
      return { status: 'CONNECTED', pairingCode: null, user: sessionObj.user };
    }

    if (!sessionObj.socket || typeof sessionObj.socket.requestPairingCode !== 'function') {
      throw new Error('Socket not ready for pairing code request. Please try again.');
    }

    const code = await sessionObj.socket.requestPairingCode(cleanPhone);
    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
    sessionObj.pairingCode = formattedCode;
    return {
      status: sessionObj.status,
      pairingCode: formattedCode
    };
  }

  async logoutSession(sessionId) {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    global.activeSessions.delete(sessionId);

    if (session) {
      session.status = 'DISCONNECTED';
      session.qrCode = null;
      session.pairingCode = null;
      session.user = null;
      if (session.socket) {
        try {
          session.socket.ev.removeAllListeners();
          await Promise.race([
            session.socket.logout().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 400))
          ]);
          session.socket.end(undefined);
        } catch (e) {}
      }
    }

    const sessionPath = path.join(this.sessionsDir, sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }
}

export const sessionManager = new SessionManager();
