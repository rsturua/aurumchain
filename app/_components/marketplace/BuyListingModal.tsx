'use client';

import { useState, useMemo, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { SecondaryMarketService } from '@/lib/web3/services/secondaryMarketService';

interface BuyListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  listing: {
    id: string;
    projectId: string;
    price: number;
    totalRemaining: number;
    totalOriginal: number;
    listingCount: number;
    sellers: { address: string; remaining: number; sequence: number; sellOrderPda: string }[];
    projects: {
      id: string;
      name: string;
      location: string;
      country: string;
      token_symbol: string;
      token_decimals: number;
      images: string[];
      blockchain_project_id?: number;
      blockchain_mint_address?: string;
      mint_address?: string;
      accepted_stablecoin?: string;
    };
  } | null;
  onSuccess?: () => void;
}

export function BuyListingModal({ isOpen, onClose, listing, onSuccess }: BuyListingModalProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [tokenAmountStr, setTokenAmountStr] = useState('');
  const [usdcAmountStr, setUsdcAmountStr] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isEligible, setIsEligible] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && listing) {
      setSuccess(false);
      setTxSig(null);
      setTokenAmountStr('');
      setUsdcAmountStr('');
      setError(null);
      checkEligibility();
    }
  }, [isOpen, publicKey?.toBase58(), listing?.id]);

  async function checkEligibility() {
    if (!publicKey || !connection) return;
    setIsValidating(true);
    try {
      const { getComplianceProgram } = await import('@/lib/web3/clients/anchorClients');
      const { ComplianceRepository } = await import('@/lib/web3/repositories/complianceRepository');

      const program = getComplianceProgram(connection);
      const repository = new ComplianceRepository(program);

      const acc = await repository.fetchEligibilityAccount(publicKey);

      if (!acc) {
        setIsEligible(false);
        setError("Your on-chain eligibility account is not initialized. Please ensure your KYC is approved.");
      } else {
        const isApproved = acc.kycStatus?.approved !== undefined || 
                          acc.kycStatus === 1 || 
                          Object.keys(acc.kycStatus || {})[0]?.toLowerCase() === 'approved';
        
        if (!isApproved) {
          setIsEligible(false);
          setError("Your on-chain KYC status is not 'Approved'.");
        } else {
          setIsEligible(true);
        }
      }
    } catch (err) {
      console.error("[BuyListingModal] Eligibility check failed:", err);
      setIsEligible(true); // Fallback to let tx fail naturally
    } finally {
      setIsValidating(false);
    }
  }

  const secondaryMarketService = useMemo(() => {
    if (!connection || !publicKey) return null;
    const mockWallet = {
      publicKey,
      sendTransaction: (tx: any, conn: any, opts: any) => sendTransaction(tx, conn, opts),
    };
    return new SecondaryMarketService(connection, mockWallet);
  }, [connection, publicKey, sendTransaction]);

  if (!isOpen || !listing) return null;

  const maxBuyAmount = listing.totalRemaining;
  const pricePerToken = listing.price;

  const handleTokenChange = (val: string) => {
    setTokenAmountStr(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      setUsdcAmountStr((num * pricePerToken).toFixed(2));
    } else {
      setUsdcAmountStr('');
    }
  };

  const handleUsdcChange = (val: string) => {
    setUsdcAmountStr(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      const tokens = num / pricePerToken;
      // Truncate/format to project decimals
      const decimals = listing.projects.token_decimals || 6;
      setTokenAmountStr(tokens.toFixed(decimals));
    } else {
      setTokenAmountStr('');
    }
  };

  const numericBuyAmount = parseFloat(tokenAmountStr) || 0;
  const totalCost = numericBuyAmount * pricePerToken;

  const projectMintStr = listing.projects?.blockchain_mint_address || listing.projects?.mint_address;
  const stablecoinMintStr = listing.projects?.accepted_stablecoin || process.env.NEXT_PUBLIC_USDC_MINT || 'AJujcxZiQ1jUvSixiFLQNWFCpUtMuVsbyPCQ8ByU3jvf';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!listing) {
      setError('Listing details are missing.');
      return;
    }

    if (!publicKey) {
      setError('Please connect your wallet first.');
      return;
    }

    if (isEligible === false) {
      setError('You are not KYC eligible to trade on-chain.');
      return;
    }

    if (numericBuyAmount <= 0 || numericBuyAmount > maxBuyAmount) {
      setError(`Please buy a valid amount between 0 and ${maxBuyAmount}`);
      return;
    }

    if (!projectMintStr) {
      setError('Project mint address is missing from the listing data.');
      return;
    }

    if (listing.projects.blockchain_project_id === undefined) {
      setError('Blockchain project ID is missing from the listing data.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // 1. Get raw unsigned transaction from backend
      const res = await fetch('/api/secondary-market/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: listing.projects.id,
          amount: numericBuyAmount,
          walletAddress: publicKey.toBase58(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate transaction.');
      }

      const { transaction: txBase64, matchedChunks } = data;

      // 2. Deserialize Transaction
      const { Transaction } = await import('@solana/web3.js');
      const txBuf = Buffer.from(txBase64, 'base64');
      const transaction = Transaction.from(txBuf);

      // 3. Sign and Send
      const signature = await sendTransaction(transaction, connection, {
        skipPreflight: true,
      });

      // 4. Confirm and update database synchronously for instant UI feedback
      const confirmRes = await fetch('/api/secondary-market/buy/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature,
          projectId: listing.projects.id,
          matchedChunks,
        }),
      });

      const confirmData = await confirmRes.json();
      if (!confirmRes.ok) {
        console.warn("[BuyListingModal] Confirm API warning:", confirmData.error);
        // We still show success since tx went through on chain, indexer will catch it
      }

      setTxSig(signature);
      setSuccess(true);
      if (onSuccess) onSuccess();
    } catch (err: any) {
      console.error("[BuyListingModal] Fill order failed:", err);
      setError(err.message || 'Failed to buy tokens.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-[#0A1628] rounded-2xl border-2 border-gold/30 shadow-2xl shadow-gold/20 max-w-lg w-full p-8 overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gold/5 rounded-full blur-3xl -mr-16 -mt-16" />
          
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {success ? (
            <div className="text-center py-8 animate-fade-in">
              <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6 border border-green-500/30">
                <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-2xl font-bold text-white mb-2">Trade Completed successfully!</h3>
              <p className="text-gray-400 mb-6">Tokens have been purchased and transferred to your wallet.</p>
              
              <div className="bg-navy/50 rounded-xl p-4 mb-8 border border-white/10">
                <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Transaction Signature</p>
                <a 
                  href={`https://solscan.io/tx/${txSig}?cluster=devnet`}
                  target="_blank"
                  className="text-gold font-mono text-xs break-all hover:underline"
                >
                  {txSig}
                </a>
              </div>
              
              <button 
                onClick={onClose}
                className="w-full bg-gradient-to-r from-gold to-gold-light text-navy font-bold py-3 rounded-xl"
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="relative z-10 space-y-6">
              <div>
                <span className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-full px-3 py-1 text-gold text-[10px] font-bold uppercase tracking-wider mb-2">
                  Buy from Secondary Listing
                </span>
                <h2 className="text-2xl font-bold text-white">Purchase {listing.projects?.name}</h2>
                <p className="text-xs text-gray-400">Seller: <span className="font-mono text-gold italic">Anonymous Orderbook ({listing.listingCount} orders)</span></p>
              </div>

              <div className="bg-navy/40 border border-gold/10 p-4 rounded-xl space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Listed Price:</span>
                  <span className="text-white font-bold">${pricePerToken.toFixed(2)} USDC / Token</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Available:</span>
                  <span className="text-white font-bold">{maxBuyAmount} {listing.projects.token_symbol}</span>
                </div>
              </div>

              <div className="space-y-4">
                <div className="relative group">
                  <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-2">Token Amount</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={tokenAmountStr}
                      onChange={(e) => handleTokenChange(e.target.value)}
                      className="w-full bg-navy/50 border border-gold/20 rounded-xl py-3 px-4 text-white text-lg font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                      placeholder="0.00"
                      max={maxBuyAmount}
                      step="any"
                      required
                    />
                    <span className="absolute right-16 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                      {listing.projects.token_symbol}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleTokenChange(maxBuyAmount.toString())}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gold hover:text-gold-light text-xs font-bold bg-gold/10 hover:bg-gold/20 px-2 py-1 rounded transition-colors"
                    >
                      MAX
                    </button>
                  </div>
                </div>

                <div className="flex justify-center -my-2 relative z-10">
                  <div className="bg-[#0A1628] border border-gold/20 rounded-full p-1.5 text-gold/50 shadow-sm">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </div>
                </div>

                <div className="relative group">
                  <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-2">USDC Amount</label>
                  <div className="relative">
                    <input
                      type="number"
                      value={usdcAmountStr}
                      onChange={(e) => handleUsdcChange(e.target.value)}
                      className="w-full bg-navy/50 border border-gold/20 rounded-xl py-3 px-4 text-white text-lg font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                      placeholder="0.00"
                      step="any"
                      required
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-bold">
                      USDC
                    </span>
                  </div>
                </div>
              </div>

              {numericBuyAmount > 0 && (
                <div className="bg-navy/50 border border-gold/10 p-4 rounded-xl space-y-3 text-xs">
                  <div className="flex justify-between text-sm font-bold">
                    <span className="text-gold">Total USDC Required:</span>
                    <span className="text-gold">${totalCost.toFixed(2)} USDC</span>
                  </div>
                  <p className="text-gray-500 text-[10px] text-center italic mt-2">
                    * No additional buyer fees. The 1.5% marketplace fee is paid by the seller.
                  </p>
                </div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-200 text-sm flex gap-3 items-center">
                  <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || isValidating || !publicKey || numericBuyAmount <= 0 || numericBuyAmount > maxBuyAmount || isEligible === false}
                className="w-full bg-gradient-to-r from-gold to-gold-light text-navy font-bold py-4 rounded-xl shadow-xl shadow-gold/20 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {isValidating ? (
                  'Verifying Eligibility...'
                ) : isSubmitting ? (
                  'Confirming on Solana...'
                ) : !publicKey ? (
                  'Connect Wallet'
                ) : isEligible === false ? (
                  'Not KYC Eligible'
                ) : (
                  `Buy ${numericBuyAmount ? numericBuyAmount : ''} Tokens`
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
