'use client';

import { useState, useMemo, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { SecondaryMarketService } from '@/lib/web3/services/secondaryMarketService';

interface ListTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
  position: {
    total_tokens: number;
    project_id: string;
    projects?: {
      id: string;
      name: string;
      location: string;
      country: string;
      token_symbol: string;
      token_decimals: number;
      blockchain_project_id?: number;
      blockchain_mint_address?: string;
      mint_address?: string;
    };
  } | null;
  onSuccess?: () => void;
}

export function ListTokenModal({ isOpen, onClose, position, onSuccess }: ListTokenModalProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [listAmount, setListAmount] = useState('');
  const [pricePerToken, setPricePerToken] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isEligible, setIsEligible] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && position) {
      setSuccess(false);
      setTxSig(null);
      setListAmount('');
      setPricePerToken('');
      setError(null);
      checkEligibility();
    }
  }, [isOpen, publicKey, position]);

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
      console.error("[ListTokenModal] Eligibility check failed:", err);
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

  if (!isOpen || !position || !position.projects) return null;

  const project = position.projects;
  const maxAmount = position.total_tokens;
  const numericAmount = parseFloat(listAmount) || 0;
  const numericPrice = parseFloat(pricePerToken) || 0;
  const totalProceeds = numericAmount * numericPrice;

  const projectMintStr = project.blockchain_mint_address || project.mint_address;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!publicKey) {
      setError('Please connect your wallet first.');
      return;
    }

    if (isEligible === false) {
      setError('You are not KYC eligible to trade on-chain.');
      return;
    }

    if (numericAmount <= 0 || numericAmount > maxAmount) {
      setError(`Please list a valid amount between 0 and ${maxAmount}`);
      return;
    }

    if (numericPrice <= 0) {
      setError('Price per token must be greater than 0.');
      return;
    }

    if (!projectMintStr) {
      setError('Project token mint address is missing.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      console.log(`[ListTokenModal] Creating P2P sell order via API...`);
      const res = await fetch('/api/secondary-market/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          amount: numericAmount,
          pricePerToken: numericPrice,
          walletAddress: publicKey.toBase58(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate transaction.');
      }

      const { transaction: txBase64, sellOrderPda } = data;

      // 2. Deserialize Transaction
      const { Transaction } = await import('@solana/web3.js');
      const txBuf = Buffer.from(txBase64, 'base64');
      const transaction = Transaction.from(txBuf);

      // 3. Sign and Send
      const signature = await sendTransaction(transaction, connection, {
        skipPreflight: true,
      });

      console.log(`[ListTokenModal] Listing success! Tx: ${signature}`);
      setTxSig(signature);

      // 4. Confirm on our backend instantly
      try {
        await fetch('/api/secondary-market/orders/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signature,
            sellOrderPda,
          }),
        });
      } catch (confirmErr) {
        console.warn("[ListTokenModal] Confirm API warning:", confirmErr);
      }

      setSuccess(true);
      if (onSuccess) onSuccess();

      setTimeout(() => {
        onClose();
      }, 4000);
    } catch (err: any) {
      console.error("[ListTokenModal] Create sell order failed:", err);
      setError(err.message || 'Failed to list tokens on-chain.');
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
              <h3 className="text-2xl font-bold text-white mb-2">Listing Created successfully!</h3>
              <p className="text-gray-400 mb-6">Your sell order has been published on-chain.</p>
              
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
                  List Token for Sale
                </span>
                <h2 className="text-2xl font-bold text-white">Sell {project.name}</h2>
                <p className="text-xs text-gray-400">Project Mint: <span className="font-mono text-gold-light">{projectMintStr ? `${projectMintStr.slice(0, 8)}...${projectMintStr.slice(-8)}` : 'N/A'}</span></p>
              </div>

              <div className="bg-navy/40 border border-gold/10 p-4 rounded-xl space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Tokens Owned:</span>
                  <span className="text-white font-bold">{maxAmount} {project.token_symbol}</span>
                </div>
              </div>

              {/* Amount to Sell */}
              <div className="relative group">
                <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-3">Amount to List</label>
                <input
                  type="number"
                  value={listAmount}
                  onChange={(e) => setListAmount(e.target.value)}
                  className="w-full bg-navy/50 border-2 border-gold/20 rounded-xl py-4 px-6 text-white text-xl font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                  placeholder="0.00"
                  max={maxAmount}
                  step="any"
                  required
                />
                <button
                  type="button"
                  onClick={() => setListAmount(maxAmount.toString())}
                  className="absolute right-4 top-[70%] -translate-y-1/2 text-gold hover:text-gold-light text-xs font-bold"
                >
                  MAX
                </button>
              </div>

              {/* Price per Token */}
              <div className="relative group">
                <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-3">Price per Token (USDC)</label>
                <span className="absolute left-4 top-[70%] -translate-y-1/2 text-gold font-bold">$</span>
                <input
                  type="number"
                  value={pricePerToken}
                  onChange={(e) => setPricePerToken(e.target.value)}
                  className="w-full bg-navy/50 border-2 border-gold/20 rounded-xl py-4 px-10 text-white text-xl font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                  placeholder="0.00"
                  step="any"
                  required
                />
                <div className="absolute right-4 top-[70%] -translate-y-1/2 text-gray-500 font-bold text-xs">USDC</div>
              </div>

              {numericAmount > 0 && numericPrice > 0 && (
                <div className="bg-navy/50 border border-gold/10 p-4 rounded-xl space-y-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Gross Proceeds:</span>
                    <span className="text-white font-bold">${totalProceeds.toFixed(2)} USDC</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Market Fee (1.5% on sale):</span>
                    <span className="text-red-400">-${(totalProceeds * 0.015).toFixed(2)} USDC</span>
                  </div>
                  <div className="h-[1px] bg-gold/10 my-1" />
                  <div className="flex justify-between text-sm font-bold">
                    <span className="text-gold">Expected Net Earnings:</span>
                    <span className="text-gold">${(totalProceeds * 0.985).toFixed(2)} USDC</span>
                  </div>
                  <p className="text-gray-500 text-[10px] text-center italic mt-2">
                    * The 1.5% fee is automatically deducted from your earnings when a buyer fills this order.
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
                disabled={isSubmitting || isValidating || !publicKey || numericAmount <= 0 || numericAmount > maxAmount || numericPrice <= 0 || isEligible === false}
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
                  `Create Sell Order`
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
