import { Connection, clusterApiUrl } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env only in Node environments (scripts/tests)
if (typeof window === 'undefined') {
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

/**
 * Global Blockchain RPC Configuration
 *
 * This file centralizes the RPC endpoint selection logic.
 * To change providers, set ALCHEMY_RPC_URL in your .env file.
 * To switch networks, set NEXT_PUBLIC_SOLANA_RPC_URL in your .env file.
 */

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_CLUSTER || 'devnet';

/**
 * Primary RPC URL — read from env (server-side only).
 * Falls back to the public devnet node so the app still works
 * even if the env var is temporarily missing.
 */
export const SOLANA_RPC_URL =
  process.env.ALCHEMY_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

/** Public fallback used for calls that the primary provider restricts (e.g. getProgramAccounts on Alchemy free tier). */
export const FALLBACK_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  'https://api.devnet.solana.com';

/**
 * Standard Connection configuration for consistency.
 */
export const CONNECTION_CONFIG = {
  commitment: 'confirmed' as const,
  confirmTransactionInitialTimeout: 90000, // 90s timeout for stability
  // Automatic Fallback Middleware
  fetchMiddleware: async (info: any, init: any, fetch: any) => {
    try {
      let currentUrl = typeof info === 'string' ? info : info.url;
      let body = init?.body ? JSON.parse(init.body) : null;

      // BYPASS: Alchemy Free tier doesn't support getProgramAccounts.
      // Force these calls to use the public Devnet.
      if (body?.method === 'getProgramAccounts' && currentUrl.includes('alchemy')) {
        const bypassUrl = FALLBACK_RPC_URL;
        console.log(`[RPC] Routing getProgramAccounts to public Devnet (Alchemy restriction)...`);
        return await fetch(bypassUrl, init);
      }

      const response = await fetch(info, init);
      
      // Fallback on rate limits (429), server errors (500+), or Alchemy restrictions (400)
      if (response && (response.status === 429 || response.status >= 500 || response.status === 400)) {
        const fallbackUrl = typeof info === 'string' 
          ? info.replace(SOLANA_RPC_URL, FALLBACK_RPC_URL)
          : FALLBACK_RPC_URL;
          
        console.warn(`[RPC] Request failed (${response.status}). Retrying with ${fallbackUrl}...`);
        return await fetch(fallbackUrl, init);
      }
      return response;
    } catch (err) {
      console.warn(`[RPC] Request threw error. Falling back...`, err);
      return await fetch(FALLBACK_RPC_URL, init);
    }
  }
};

/**
 * Factory for creating a standard Connection object.
 */
export const createDefaultConnection = () => {
  return new Connection(SOLANA_RPC_URL, CONNECTION_CONFIG);
};
