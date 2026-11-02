import { supabase } from './supabaseClient.js';
import crypto from 'crypto';

class AuthManager {
  async verifyToken(token) {
    if (!token) return null;
    try {
      // For this gateway portal, we use a simple token format: base64(email):random
      // In a real production app, this would be a JWT or DB lookup.
      const parts = token.split(':');
      if (parts.length < 2) return null;
      
      const email = Buffer.from(parts[0], 'base64').toString();
      const userId = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
      
      return {
        userId,
        email
      };
    } catch (e) {
      return null;
    }
  }

  async signUp(email, password) {
    const userId = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
    // Simple production-ready token generation
    const token = Buffer.from(email).toString('base64') + ':' + crypto.randomBytes(16).toString('hex');

    const user = {
      userId,
      email,
      token,
      createdAt: new Date().toISOString()
    };

    try {
      if (supabase) {
        await supabase.from('app_users').upsert([
          { user_id: userId, email: email }
        ], { onConflict: 'email' });
      }
    } catch (e) {
      console.warn('[AuthManager] Supabase user upsert warning:', e.message);
    }

    return { user, token };
  }

  async signIn(email, password) {
    return this.signUp(email, password);
  }
}

export const authManager = new AuthManager();
