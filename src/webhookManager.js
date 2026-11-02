import fetch from 'node-fetch';

class WebhookManager {
  constructor() {
    this.configs = new Map();
    this.logs = new Map();
  }

  setWebhook(apiKey, url) {
    this.configs.set(apiKey, url);
    if (!this.logs.has(apiKey)) {
      this.logs.set(apiKey, []);
    }
  }

  getWebhook(apiKey) {
    return this.configs.get(apiKey) || null;
  }

  getLogs(apiKey) {
    return this.logs.get(apiKey) || [];
  }

  async dispatch(apiKey, eventType, payload) {
    const url = this.getWebhook(apiKey);
    const logEntry = {
      timestamp: new Date().toISOString(),
      event: eventType,
      payload,
      status: 200
    };

    if (!this.logs.has(apiKey)) {
      this.logs.set(apiKey, []);
    }
    const userLogs = this.logs.get(apiKey);
    userLogs.unshift(logEntry);
    if (userLogs.length > 50) userLogs.pop();

    if (!url) return;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventType, data: payload, timestamp: logEntry.timestamp })
      });
      logEntry.status = res.status;
    } catch (err) {
      logEntry.status = 500;
      logEntry.error = err.message;
    }
  }
}

export const webhookManager = new WebhookManager();
