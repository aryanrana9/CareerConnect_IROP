const { createClient } = require('redis');
require('dotenv').config();

// In-memory fallback store for OTPs if Redis is unreachable
const memoryStore = new Map();

let client = null;
let isRedisAvailable = false;

const hasRedisConfig = process.env.REDIS_HOST && 
                       process.env.REDIS_HOST !== 'localhost' && 
                       !process.env.REDIS_HOST.includes('example');

if (hasRedisConfig || process.env.REDIS_HOST === 'localhost') {
  try {
    client = createClient({
      username: process.env.REDIS_UNAME || undefined,
      password: process.env.REDIS_PASS || undefined,
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        reconnectStrategy: (retries) => {
          if (retries >= 2) {
            console.log('[Redis] Connection not reachable. Falling back to in-memory store for OTPs.');
            return false; // Stop reconnect loop
          }
          return 1000;
        }
      }
    });

    client.on('error', (err) => {
      // Quietly log once to avoid terminal spam
      if (isRedisAvailable) {
        console.warn('[Redis] Connection dropped:', err.message);
        isRedisAvailable = false;
      }
    });

    client.on('connect', () => {
      console.log('✅ Redis Client Connected');
      isRedisAvailable = true;
    });

    client.connect().catch(() => {
      console.log('[Redis] Remote Redis unavailable. Using in-memory fallback store.');
    });
  } catch (err) {
    console.log('[Redis] Initialization skipped, using in-memory fallback.');
  }
} else {
  console.log('[Redis] No Redis host configured. Running with in-memory fallback store.');
}

// Wrapper providing Redis methods used by the application
const redisWrapper = {
  get isOpen() {
    return isRedisAvailable && client && client.isOpen;
  },

  async get(key) {
    if (this.isOpen) {
      try {
        return await client.get(key);
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    const item = memoryStore.get(key);
    if (!item) return null;
    if (item.expires && item.expires < Date.now()) {
      memoryStore.delete(key);
      return null;
    }
    return item.value;
  },

  async setEx(key, seconds, value) {
    if (this.isOpen) {
      try {
        return await client.setEx(key, seconds, value);
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    memoryStore.set(key, { value, expires: Date.now() + seconds * 1000 });
    return 'OK';
  },

  async del(key) {
    if (this.isOpen) {
      try {
        return await client.del(key);
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    memoryStore.delete(key);
    return 1;
  },

  async keys(pattern) {
    if (this.isOpen) {
      try {
        return await client.keys(pattern);
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    return Array.from(memoryStore.keys());
  },

  async flushDb() {
    if (this.isOpen) {
      try {
        return await client.flushDb();
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    memoryStore.clear();
    return 'OK';
  },

  async ping() {
    if (this.isOpen) {
      try {
        return await client.ping();
      } catch (err) {
        // Fall back to memoryStore
      }
    }
    return 'PONG';
  }
};

module.exports = redisWrapper;
