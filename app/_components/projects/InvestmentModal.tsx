'use client';

import { useState, useMemo, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { InvestmentService } from '@/lib/web3/services/investmentService';
import { COMPLIANCE_PROGRAM_ID } from '@/lib/web3/config/programs';

interface InvestmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: {
    id: string;
    name: string;
    location: string;
    country: string;
    blockchain_project_id: number | null;
    token_price?: number;
    onChain?: {
      minInvestmentUsdc: number;
      maxInvestmentUsdc: number;
      tokenPriceUsdc?: number; // Added
      acceptedStablecoin: string;
      supplyCap: number;
    } | null;
  };
}

export function InvestmentModal({ isOpen, onClose, project }: InvestmentModalProps) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  
  const [amount, setAmount] = useState(''); // This is now total USDC
  const [tokenQuantity, setTokenQuantity] = useState(''); // This is number of tokens
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isEligible, setIsEligible] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  
  // Reset state and check eligibility when modal is opened
  useEffect(() => {
    if (isOpen) {
      setSuccess(false);
      setTxSig(null);
      setAmount('');
      setTokenQuantity('');
      setError(null);
      checkEligibility();
    }
  }, [isOpen, publicKey]);

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
        setError("Your on-chain eligibility account is not initialized. Please ensure your KYC is approved and synced.");
      } else {
        const isApproved = acc.kycStatus?.approved !== undefined || 
                          acc.kycStatus === 1 || 
                          Object.keys(acc.kycStatus || {})[0]?.toLowerCase() === 'approved';
        
        if (!isApproved) {
          setIsEligible(false);
          setError("Your on-chain status is not 'Approved'. Please contact support.");
        } else {
          setIsEligible(true);
        }
      }
    } catch (err) {
      console.error("[InvestmentModal] Eligibility check failed:", err);
      // Fallback: don't block if check fails, but let the tx fail if needed
      setIsEligible(true); 
    } finally {
      setIsValidating(false);
    }
  }

  const investmentService = useMemo(() => {
    if (!connection) return null;
    // We pass a mock wallet that uses the adapter's sendTransaction
    const mockWallet = {
      publicKey,
      sendTransaction: (tx: any, conn: any, opts: any) => sendTransaction(tx, conn, opts),
    };
    return new InvestmentService(connection, mockWallet);
  }, [connection, publicKey, sendTransaction]);

  const onChain = project.onChain;
  
  // ── Price Calculation ──
  const tokenPrice = useMemo(() => {
    // 1. Prefer on-chain price (it's already humanized in /api/projects)
    if (onChain?.tokenPriceUsdc && onChain.tokenPriceUsdc > 0) return onChain.tokenPriceUsdc;
    // 2. Fallback to DB price
    if (project.token_price && project.token_price > 0) return project.token_price;
    // 3. Last resort calculation (Legacy)
    if (onChain && onChain.supplyCap > 0 && onChain.maxInvestmentUsdc > 0) {
      return onChain.maxInvestmentUsdc / onChain.supplyCap;
    }
    return 1; // Absolute fallback
  }, [onChain, project.token_price]);

  const investmentAmount = parseFloat(amount) || 0;
  
  // Update tokens when USDC amount changes
  const handleUsdcChange = (val: string) => {
    setAmount(val);
    const numericVal = parseFloat(val) || 0;
    setTokenQuantity((numericVal / tokenPrice).toFixed(4));
  };

  // Update USDC when token quantity changes
  const handleTokenChange = (val: string) => {
    setTokenQuantity(val);
    const numericVal = parseFloat(val) || 0;
    setAmount((numericVal * tokenPrice).toFixed(2));
  };

  if (!isOpen) return null;

  const tokensToReceive = investmentAmount / tokenPrice;
  const minInvestment = onChain ? onChain.minInvestmentUsdc : 100;
  const maxInvestment = onChain ? onChain.maxInvestmentUsdc : 10000;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!publicKey) {
      setError('Please connect your wallet first.');
      return;
    }

    if (isEligible === false) {
      setError('You are not eligible to invest on-chain. Please complete KYC.');
      return;
    }

    if (project.blockchain_project_id === null) {
      setError('This project is not yet initialized on-chain.');
      return;
    }

    if (investmentAmount < minInvestment) {
      setError(`Minimum investment is $${minInvestment.toLocaleString()}`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (!investmentService) throw new Error("Investment service not initialized");

      console.log(`[InvestmentModal] Initiating on-chain subscription for project ${project.blockchain_project_id}...`);
      
      const { signature, subscriptionId } = await investmentService.subscribe({
        projectId: project.blockchain_project_id,
        amount: investmentAmount,
        paymentAsset: new PublicKey(onChain?.acceptedStablecoin || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // Default USDC
      });

      console.log(`[InvestmentModal] Success! Tx: ${signature}`);
      setTxSig(signature);

      const tokensPurchased = tokensToReceive;

      // Sync with backend
      await fetch('/api/investments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          amount: investmentAmount,
          tokensPurchased: tokensPurchased,
          blockchainSignature: signature,
          blockchainSubscriptionId: subscriptionId,
          investorWallet: publicKey.toBase58(),
        }),
      });

      setSuccess(true);
      setTimeout(() => {
        onClose();
        // window.location.href = '/dashboard/investments';
      }, 5000);
    } catch (err: any) {
      console.error("[InvestmentModal] Error:", err);
      setError(err.message || 'Failed to process investment on-chain.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-[#0A1628] rounded-2xl border-2 border-gold/30 shadow-2xl shadow-gold/20 max-w-lg w-full p-8 overflow-hidden">
          {/* Decorative background */}
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
              <h3 className="text-2xl font-bold text-white mb-2">Investment Recorded On-Chain!</h3>
              <p className="text-gray-400 mb-6">Your subscription intent has been immutably stored.</p>
              
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
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="relative z-10">
              <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-full px-3 py-1 mb-4">
                <span className="text-gold text-[10px] font-bold uppercase tracking-wider">On-Chain Subscription</span>
              </div>
              
              <h2 className="text-3xl font-bold text-white mb-1">Invest in {project.name}</h2>
              <p className="text-gray-400 text-sm mb-8">{project.location}, {project.country}</p>

              <div className="space-y-6 mb-8">
                {/* Tokens Input */}
                <div className="relative group">
                  <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-3 text-gold">How many tokens?</label>
                  <input
                    type="number"
                    value={tokenQuantity}
                    onChange={(e) => handleTokenChange(e.target.value)}
                    className="w-full bg-navy/50 border-2 border-gold/20 rounded-xl py-4 px-6 text-white text-xl font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                    placeholder="0.00"
                    required
                  />
                  <div className="absolute right-4 top-[70%] -translate-y-1/2 text-gray-500 font-bold text-xs">TOKENS</div>
                </div>

                <div className="flex items-center justify-center">
                  <div className="h-[1px] w-full bg-gold/20"></div>
                  <div className="px-4 text-gold/40">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </div>
                  <div className="h-[1px] w-full bg-gold/20"></div>
                </div>

                {/* USDC Input */}
                <div className="relative group">
                  <label className="block text-gray-400 text-xs font-bold uppercase tracking-widest mb-3">Total Cost (USDC)</label>
                  <span className="absolute left-4 top-[70%] -translate-y-1/2 text-gold font-bold">$</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => handleUsdcChange(e.target.value)}
                    className="w-full bg-navy/50 border-2 border-gold/20 rounded-xl py-4 px-10 text-white text-xl font-bold focus:border-gold focus:outline-none transition-all group-hover:border-gold/40"
                    placeholder="0.00"
                    min={minInvestment}
                    required
                  />
                  <div className="absolute right-4 top-[70%] -translate-y-1/2 text-gray-500 font-bold text-xs">USDC</div>
                </div>
                
                {/* Math Recap */}
                {investmentAmount > 0 && (
                  <div className="p-4 rounded-xl bg-gold/5 border border-gold/20 animate-fade-in flex justify-between items-center text-xs">
                    <div className="text-gray-400">
                      Calculation: <span className="text-white font-mono">{tokenQuantity || '0'}</span> tokens × <span className="text-white font-mono">${tokenPrice.toFixed(2)}</span>
                    </div>
                    <div className="text-gold font-bold">
                      = ${investmentAmount.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 animate-shake">
                  <div className="flex gap-3">
                    <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-red-200 text-sm font-medium">{error}</p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || isValidating || !publicKey || !amount || isEligible === false}
                className="w-full bg-gradient-to-r from-gold to-gold-light hover:from-gold-light hover:to-gold text-navy font-bold py-4 rounded-xl transition-all duration-300 shadow-xl shadow-gold/20 hover:shadow-gold/40 disabled:opacity-30 disabled:cursor-not-allowed group"
              >
                {isValidating ? (
                  <span className="flex items-center justify-center gap-3">
                    <svg className="animate-spin h-5 w-5 text-navy" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Verifying Eligibility...
                  </span>
                ) : isSubmitting ? (
                  <span className="flex items-center justify-center gap-3">
                    <svg className="animate-spin h-5 w-5 text-navy" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Confirming on Solana...
                  </span>
                ) : !publicKey ? (
                  'Connect Wallet to Invest'
                ) : isEligible === false ? (
                  'Not Eligible to Invest'
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    Confirm Investment
                    <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                  </span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
