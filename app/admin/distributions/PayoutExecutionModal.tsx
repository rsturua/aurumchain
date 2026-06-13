"use client";

import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { BN, Program } from '@coral-xyz/anchor';
import { createClient } from '@/lib/supabase/client';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

interface InvestorData {
  wallet: string;
  tokensInvested: number;
  currentBalance: number;
  payoutAmount: number;
  alreadyPaid: boolean;
  profileId: string;
  lockedTokens: number;
}

interface PayoutExecutionModalProps {
  epoch: any;
  projects: any[];
  program: Program<any> | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PayoutExecutionModal({ epoch, projects, program, onClose, onSuccess }: PayoutExecutionModalProps) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [loading, setLoading] = useState(true);
  const [investors, setInvestors] = useState<InvestorData[]>([]);
  const [selectedWallets, setSelectedWallets] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info', msg: string } | null>(null);

  const profitPerTokenHuman = parseFloat(epoch.profit_per_token);
  const project = projects.find(p => p.id === epoch.project_id);

  useEffect(() => {
    fetchInvestors();
  }, [epoch.id]);

  const fetchInvestors = async () => {
    try {
      setLoading(true);
      const supabase = createClient();
      
      const blockchainProjectId = new BN(project.blockchain_project_id);
      console.log("🔗 Fetching on-chain investors for Project ID:", blockchainProjectId.toString());

      // 1. Initialize Compliance Program
      const { getComplianceProgram } = await import('@/lib/web3/utils/programDiscoverer');
      const complianceProgram = getComplianceProgram(connection, wallet as any);

      // 2. Fetch Mint Decimals (Source of Truth)
      let decimals = project.token_decimals || 6;
      try {
        const mintInfo = await connection.getParsedAccountInfo(new PublicKey(project.mint_address || project.mint));
        decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? decimals;
        console.log(`🎯 Detected Mint Decimals: ${decimals}`);
      } catch (e) {
        console.warn("Could not fetch mint decimals, falling back to 6.");
      }

      // 3. Fetch all portfolio positions for this project via Admin API (bypasses RLS)
      const res = await fetch(`/api/admin/distributions/investors?projectId=${project.id}&epochId=${epoch.id}`, { cache: 'no-store' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to fetch investors");
      }
      const data = await res.json();
      const positions = data.positions;
      const paidUserIds = new Set(data.paidUserIds);
      const userIdToWallet = new Map<string, string>(Object.entries(data.userIdToWallet));

      console.log(`📊 Found ${positions?.length || 0} DB portfolio records.`);

      // 6. Group by wallet and calculate totals
      const investorMap = new Map<string, InvestorData>();
      
      positions?.forEach((pos: any) => {
        const walletAddr = userIdToWallet.get(pos.user_id);
        if (!walletAddr) return; // Skip if no wallet linked
        
        const profileId = pos.user_id;
        const tokens = pos.total_tokens;
        const locked = pos.locked_tokens || 0;

        if (investorMap.has(walletAddr)) {
          const existing = investorMap.get(walletAddr)!;
          existing.tokensInvested += tokens;
          existing.lockedTokens += locked;
          existing.payoutAmount = existing.tokensInvested * profitPerTokenHuman;
        } else {
          investorMap.set(walletAddr, {
            wallet: walletAddr,
            tokensInvested: tokens,
            lockedTokens: locked,
            currentBalance: 0,
            payoutAmount: tokens * profitPerTokenHuman,
            alreadyPaid: paidUserIds.has(profileId),
            profileId: profileId
          });
        }
      });

      const list = Array.from(investorMap.values());
      console.log(`✅ On-chain data grouped into ${list.length} unique investors.`);
      setInvestors(list);
      
      // Auto-select unpaid
      const unpaid = new Set(list.filter(i => !i.alreadyPaid).map(i => i.wallet));
      setSelectedWallets(unpaid);

    } catch (err: any) {
      console.error("On-Chain Fetch Error:", err);
      setStatus({ type: 'error', msg: "Failed to load on-chain investor data." });
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (wallet: string) => {
    const next = new Set(selectedWallets);
    if (next.has(wallet)) next.delete(wallet);
    else next.add(wallet);
    setSelectedWallets(next);
  };

  const toggleSelectAll = () => {
    const eligible = investors.filter(i => !i.alreadyPaid);
    if (selectedWallets.size === eligible.length) {
      setSelectedWallets(new Set());
    } else {
      setSelectedWallets(new Set(eligible.map(i => i.wallet)));
    }
  };

  const selectedList = investors.filter(i => selectedWallets.has(i.wallet));
  const totalTokens = selectedList.reduce((sum, i) => sum + i.tokensInvested, 0);
  const totalPayout = selectedList.reduce((sum, i) => sum + i.payoutAmount, 0);

  const executeBatchPayout = async () => {
    if (!program || !wallet.publicKey || selectedWallets.size === 0 || !project) return;

    try {
      setExecuting(true);
      setStatus({ type: 'info', msg: "Initializing batch execution..." });

      const blockchainProjectId = new BN(project.blockchain_project_id);
      
      // Fetch on-chain project configuration
      const { ProjectRegistryService } = await import('@/lib/web3/services/projectRegistryService');
      const registryService = new ProjectRegistryService(connection, wallet as any);
      const onChainProject = await registryService.fetchProject(blockchainProjectId.toNumber());
      if (!onChainProject) throw new Error("Could not find project on blockchain");

      const mint = onChainProject.mint;
      const usdcMint = onChainProject.acceptedStablecoin;
      
      // Enforce Token-2022 for project mint, Detect for USDC
      const tokenProgramId = TOKEN_2022_PROGRAM_ID;
      
      const usdcMintInfo = await connection.getParsedAccountInfo(usdcMint);
      const usdcTokenProgramId = usdcMintInfo.value?.owner || TOKEN_PROGRAM_ID;

      const treasuryWallet = onChainProject.treasuryWallet;
      const treasuryVault = await getAssociatedTokenAddress(
        usdcMint, 
        treasuryWallet, 
        true,
        usdcTokenProgramId
      );
      const registryProgramId = new PublicKey(process.env.NEXT_PUBLIC_PROJECT_REGISTRY_PROGRAM_ID || "DZBcioGMWiriWXejSRYo3kjVJtS9VLe5RvwdUhr5HxJN");

      // PDAs
      const [projectAccountPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("project"), blockchainProjectId.toArrayLike(Buffer, "le", 8)],
        registryProgramId
      );
      const [epochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch"), blockchainProjectId.toArrayLike(Buffer, "le", 8), new BN(epoch.epoch_id).toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      const [controlPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("distribution_control")],
        program.programId
      );

      const walletsToProcess = Array.from(selectedWallets);
      
      // Pre-validation: Double check on-chain balances to prevent transaction failures
      setStatus({ type: 'info', msg: "Validating true on-chain balances..." });
      for (const investorWalletStr of walletsToProcess) {
        const investor = investors.find(inv => inv.wallet === investorWalletStr)!;
        try {
          const investorTokenAccount = await getAssociatedTokenAddress(mint, new PublicKey(investorWalletStr), false, tokenProgramId);
          const accountInfo = await connection.getParsedAccountInfo(investorTokenAccount);
          let actualBalance = 0;
          if (accountInfo.value && 'parsed' in accountInfo.value.data) {
             actualBalance = accountInfo.value.data.parsed.info.tokenAmount.uiAmount;
          }
          
          const expectedOnChainBalance = investor.tokensInvested - investor.lockedTokens;
          if (actualBalance < expectedOnChainBalance) {
             throw new Error(`Database out of sync! Wallet ${investorWalletStr.slice(0,6)}... has ${actualBalance} tokens in their personal wallet and ${investor.lockedTokens} in escrow, but the payout expects ${investor.tokensInvested} total.`);
          }
        } catch (e: any) {
           throw new Error(e.message || "Failed to validate on-chain balance.");
        }
      }

      // Batching Logic (5-8 instructions per transaction is safe for Solana)
      const BATCH_SIZE = 5;
      setProgress({ current: 0, total: walletsToProcess.length });

      for (let i = 0; i < walletsToProcess.length; i += BATCH_SIZE) {
        const chunk = walletsToProcess.slice(i, i + BATCH_SIZE);
        const transaction = new Transaction();
        
        // Add Compute Budget instructions
        transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
        transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

        const chunkRecords: any[] = [];

        for (const investorWalletStr of chunk) {
          const investorPublicKey = new PublicKey(investorWalletStr);
          const investor = investors.find(inv => inv.wallet === investorWalletStr)!;
          
          const investorTokenAccount = await getAssociatedTokenAddress(
            mint, 
            investorPublicKey,
            false,
            tokenProgramId
          );
          const investorPaymentAccount = await getAssociatedTokenAddress(
            usdcMint, 
            investorPublicKey,
            false,
            usdcTokenProgramId
          );

          // 1. ATA Creation (Idempotent)
          transaction.add(createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            investorPaymentAccount,
            investorPublicKey,
            usdcMint,
            usdcTokenProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          ));

          const [payoutRecordPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("payout"), epochPda.toBuffer(), investorPublicKey.toBuffer()],
            program.programId
          );

          // 2. Execute Payout Instruction
          let decimals = project.token_decimals || 6;
          // Scale back to raw token amount since the smart contract expects it in lowest denomination
          const snapshotBalance = new BN(Math.round(investor.tokensInvested * Math.pow(10, decimals)));
          
          const ix = await program.methods
            .executePayout(snapshotBalance)
            .accounts({
              epoch: epochPda,
              payoutRecord: payoutRecordPda,
              projectAccount: projectAccountPda,
              projectRegistryProgram: registryProgramId,
              investorTokenAccount: investorTokenAccount,
              investorPaymentAccount: investorPaymentAccount,
              treasuryVault: treasuryVault,
              control: controlPda,
              admin: wallet.publicKey,
              investor: investorPublicKey,
              payer: wallet.publicKey,
              paymentMint: usdcMint,
              tokenProgram: usdcTokenProgramId,
              systemProgram: SystemProgram.programId,
            } as any)
            .instruction();
          
          transaction.add(ix);
          
          chunkRecords.push({
            user_id: investor.profileId,
            project_id: epoch.project_id,
            cycle_id: epoch.id,
            tokens_held: investor.tokensInvested,
            amount_due: investor.payoutAmount,
            status: 'completed',
            paid_at: new Date().toISOString(),
            calculated_at: new Date().toISOString(),
          });
        }

        setStatus({ type: 'info', msg: `Executing Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(walletsToProcess.length / BATCH_SIZE)}...` });
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = wallet.publicKey;

        const tx = await wallet.sendTransaction(transaction, connection, { skipPreflight: true });
        
        // Confirm Batch
        let confirmed = false;
        for (let j = 0; j < 15; j++) {
          await new Promise(r => setTimeout(r, 2000));
          const statusResult = await connection.getSignatureStatus(tx);
          if (statusResult.value?.confirmationStatus === 'confirmed' || statusResult.value?.confirmationStatus === 'finalized') {
            if (statusResult.value.err) throw new Error("Transaction failed on-chain.");
            confirmed = true; break;
          }
        }
        
        if (!confirmed) console.warn("Confirmation polling timed out, but proceeding to database sync.");

        // Sync local DB records
        const supabase = createClient();
        
        // SAFETY: Only sync records where we have a valid UUID for the user
        // (Wallet addresses as user_id will cause a DB constraint failure)
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const recordsToInsert = chunkRecords
          .filter(r => uuidRegex.test(r.user_id))
          .map(r => ({ ...r, tx_hash: tx }));

        if (recordsToInsert.length > 0) {
          const syncRes = await fetch('/api/admin/distributions/sync-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordsToInsert })
          });
          
          if (!syncRes.ok) {
            const err = await syncRes.json();
            console.error("Database Sync Error Details:", err);
            setStatus({ type: 'error', msg: `Batch succeeded on-chain, but DB sync failed: ${err.error}` });
          } else {
            // Audit Log for successful batch
            await fetch('/api/admin/audit-logs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                eventType: 'payout_completed',
                description: `Executed batch payout for Epoch ${epoch.name}: ${recordsToInsert.length} investors.`,
                metadata: {
                  epochId: epoch.id,
                  projectId: epoch.project_id,
                  txHash: tx,
                  investorCount: recordsToInsert.length,
                  totalAmount: recordsToInsert.reduce((sum, r) => sum + r.amount_due, 0)
                }
              })
            }).catch(e => console.warn("Audit Log Failed:", e));
          }
        } else {
          console.warn("⚠️ No valid profile IDs found for this batch. Payouts executed on-chain but no database receipts created.");
        }

        setProgress(prev => ({ ...prev, current: Math.min(prev.current + BATCH_SIZE, prev.total) }));
      }

      setStatus({ type: 'success', msg: "Payouts successfully executed for all selected investors!" });
      onSuccess();
      setTimeout(onClose, 2500);

    } catch (err: any) {
      console.error("Batch Payout Error:", err);
      setStatus({ type: 'error', msg: err.message || "Failed to complete batch payout." });
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/90 backdrop-blur-md">
      <div className="bg-[#0D1B2D] border border-white/10 rounded-3xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.5)] overflow-hidden animate-in fade-in zoom-in duration-300">
        
        {/* Header */}
        <div className="p-8 border-b border-white/10 flex justify-between items-center bg-navy/30">
          <div>
            <h2 className="text-3xl font-black text-white mb-2 tracking-tight">Batch Payouts</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs px-2 py-1 bg-gold/20 text-gold rounded uppercase font-bold tracking-widest">{epoch.name}</span>
              <span className="text-gray-500 text-sm">•</span>
              <p className="text-sm text-gray-400">
                Rate: <span className="text-gold font-mono font-bold">${profitPerTokenHuman.toFixed(4)}</span> / token
              </p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-3 hover:bg-white/5 rounded-2xl transition-all text-gray-400 hover:text-white hover:rotate-90"
          >
            ✕
          </button>
        </div>

        {/* Status Messaging */}
        {status && (
          <div className={`mx-8 mt-6 p-4 rounded-2xl border flex items-center gap-4 animate-in slide-in-from-top-4 duration-500 ${
            status.type === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
            status.type === 'success' ? 'bg-green-500/10 text-green-400 border-green-500/30' :
            'bg-gold/10 text-gold border-gold/30'
          }`}>
            <span className="text-2xl">{status.type === 'error' ? '⚠️' : status.type === 'success' ? '✨' : '⚙️'}</span>
            <p className="text-sm font-bold uppercase tracking-wide">{status.msg}</p>
          </div>
        )}

        {/* Investor List Table */}
        <div className="flex-1 overflow-y-auto px-8 py-6">
          {loading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-20 bg-white/5 animate-pulse rounded-2xl"></div>
              ))}
            </div>
          ) : investors.length === 0 ? (
            <div className="text-center py-20">
              <div className="text-5xl mb-4 opacity-20">📭</div>
              <p className="text-gray-500 font-medium">No approved investments found for this project.</p>
            </div>
          ) : (
            <table className="w-full text-left border-separate border-spacing-y-3">
              <thead>
                <tr className="text-gray-500 text-[10px] uppercase tracking-[0.2em] font-black">
                  <th className="px-6 pb-2">
                    <input 
                      type="checkbox" 
                      checked={selectedWallets.size === investors.filter(i => !i.alreadyPaid).length && selectedWallets.size > 0}
                      onChange={toggleSelectAll}
                      className="accent-gold w-5 h-5 rounded-md cursor-pointer transition-transform active:scale-90"
                    />
                  </th>
                  <th className="px-6 pb-2">Investor Wallet</th>
                  <th className="px-6 pb-2 text-right">Holdings</th>
                  <th className="px-6 pb-2 text-right">Amount Due</th>
                  <th className="px-6 pb-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {investors.map((investor) => (
                  <tr key={investor.wallet} className={`bg-navy/40 border border-white/5 hover:bg-white/5 transition-all group ${investor.alreadyPaid ? 'opacity-40 grayscale-[0.5]' : ''}`}>
                    <td className="px-6 py-4 rounded-l-2xl border-y border-l border-white/5">
                      <input 
                        type="checkbox" 
                        disabled={investor.alreadyPaid || executing}
                        checked={selectedWallets.has(investor.wallet)}
                        onChange={() => toggleSelect(investor.wallet)}
                        className="accent-gold w-5 h-5 rounded-md cursor-pointer disabled:opacity-30 transition-transform active:scale-90"
                      />
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-gray-400 border-y border-white/5">
                      {investor.wallet}
                    </td>
                    <td className="px-6 py-4 text-right text-white font-bold border-y border-white/5">
                      {investor.tokensInvested.toLocaleString()} <span className="text-[10px] text-gray-500 font-medium ml-1">TOKENS</span>
                    </td>
                    <td className="px-6 py-4 text-right text-gold font-black text-lg border-y border-white/5">
                      ${investor.payoutAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 rounded-r-2xl text-center border-y border-r border-white/5">
                      {investor.alreadyPaid ? (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 text-green-400 rounded-lg text-[10px] font-black uppercase tracking-widest border border-green-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
                          Complete
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gold/10 text-gold rounded-lg text-[10px] font-black uppercase tracking-widest border border-gold/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse"></span>
                          Pending
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Summary Sticky Footer */}
        <div className="p-8 border-t border-white/10 bg-navy/60 backdrop-blur-xl">
          <div className="flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="flex gap-12">
              <div className="flex flex-col">
                <span className="text-[10px] text-gray-500 font-black uppercase tracking-[0.2em] mb-2">Recipients</span>
                <span className="text-3xl font-black text-white leading-none">{selectedWallets.size}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-gray-500 font-black uppercase tracking-[0.2em] mb-2">Total Tokens</span>
                <span className="text-3xl font-black text-white leading-none">{totalTokens.toLocaleString()}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] text-gold font-black uppercase tracking-[0.2em] mb-2">Payout Total</span>
                <span className="text-3xl font-black text-gold leading-none">${totalPayout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>

            <div className="w-full md:w-auto">
              {executing ? (
                <div className="w-72">
                  <div className="flex justify-between items-end mb-3">
                    <span className="text-[10px] text-gold font-black uppercase tracking-widest animate-pulse">Distributing USDC...</span>
                    <span className="text-sm font-mono text-white font-bold">{progress.current} / {progress.total}</span>
                  </div>
                  <div className="h-2.5 bg-white/5 rounded-full overflow-hidden border border-white/5 p-0.5">
                    <div 
                      className="h-full bg-gradient-to-r from-gold to-yellow-200 rounded-full shadow-[0_0_15px_rgba(212,175,55,0.5)] transition-all duration-700 ease-out" 
                      style={{ width: `${(progress.current / progress.total) * 100}%` }}
                    ></div>
                  </div>
                </div>
              ) : (
                <button
                  disabled={selectedWallets.size === 0 || loading}
                  onClick={executeBatchPayout}
                  className="w-full md:w-auto group relative px-12 py-5 bg-gold text-navy font-black uppercase tracking-[0.15em] rounded-2xl hover:bg-white hover:scale-105 active:scale-95 transition-all disabled:opacity-40 disabled:scale-100 disabled:cursor-not-allowed shadow-[0_10px_30px_rgba(212,175,55,0.3)]"
                >
                  Confirm & Execute Batch
                </button>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
