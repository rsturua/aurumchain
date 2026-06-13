import { useState, useEffect, useCallback, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { createClient } from "@/lib/supabase/client";
import { TokenMath } from "@/lib/utils/tokenMath";
import { BN } from "@coral-xyz/anchor";
import { getComplianceProgram } from "@/lib/web3/utils/programDiscoverer";
import bs58 from "bs58";

export interface DashboardData {
  user: {
    name: string;
    email: string;
    investorTier: string;
    isKycVerified: boolean;
    kycStatus: string;
    isOnChainVerified: boolean;
  };
  stats: {
    totalInvested: number;
    totalReturns: number;
    portfolioValue: number;
    goldTokens: number;
    usdBalance: number;
    activeProjectsCount: number;
  };
  investments: any[];
  transactions: any[];
  portfolioPositions: any[];
  projects: any[];
  secondaryListings: any[];
  loading: boolean;
  error: string | null;
}

export function useDashboardData() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [data, setData] = useState<DashboardData>({
    user: { name: "", email: "", investorTier: "browser", isKycVerified: false, kycStatus: "not_started", isOnChainVerified: true },
    stats: {
      totalInvested: 0,
      totalReturns: 0,
      portfolioValue: 0,
      goldTokens: 0,
      usdBalance: 0,
      activeProjectsCount: 0,
    },
    investments: [],
    transactions: [],
    portfolioPositions: [],
    projects: [],
    secondaryListings: [],
    loading: true,
    error: null,
  });

  const isFetching = useRef(false);

  const fetchAllData = useCallback(async () => {
    if (isFetching.current) return;
    try {
      isFetching.current = true;
      let blockchainVerified = false;
      let onChainGoldTokens = 0;
      setData((prev) => ({ ...prev, loading: true, error: null }));
      
      const supabase = createClient();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      
      if (!authUser) {
        setData(prev => ({ ...prev, loading: false }));
        return;
      }

      // Force-Sync wallet to profile if connected (Unifying all columns)
      if (wallet.publicKey) {
        const walletAddr = wallet.publicKey.toBase58();
        const { data: currentProfile } = await supabase.from('profiles').select('crypto_wallet_address, wallet_address').eq('id', authUser.id).single();
        
        if (currentProfile && (currentProfile.crypto_wallet_address !== walletAddr || currentProfile.wallet_address !== walletAddr)) {
          console.log(`[useDashboardData] Unifying wallet ${walletAddr} across all columns...`);
          
          await supabase.from('profiles').update({ 
            crypto_wallet_address: walletAddr,
            wallet_address: walletAddr 
          }).eq('id', authUser.id);
        }
      }

      // --- CRITICAL: BLOCKCHAIN CHECK (Unified Seed: eligibility) ---
      if (wallet.publicKey && connection) {
        try {
          const { getComplianceProgram } = await import("@/lib/web3/clients/anchorClients");
          const { ComplianceRepository } = await import("@/lib/web3/repositories/complianceRepository");
          
          const program = getComplianceProgram(connection);
          const repository = new ComplianceRepository(program);
          
          // Use repository's fetch method which has manual decoding fallbacks
          const acc = await repository.fetchEligibilityAccount(wallet.publicKey);
          
          if (acc) {
            blockchainVerified = 
              acc.kycStatus?.approved !== undefined || 
              acc.kycStatus === 1 || 
              Object.keys(acc.kycStatus || {})[0]?.toLowerCase() === 'approved';
            
            console.log("[useDashboardData] On-chain eligibility found. Verified:", blockchainVerified);
          } else {
            console.log("[useDashboardData] No on-chain eligibility account found.");
          }
        } catch (e) {
          console.warn("[useDashboardData] Blockchain eligibility check failed:", e);
        }
      }

      // 1. Fetch Supabase Data
      const profilePromise = supabase.from("profiles").select("id, first_name, last_name, email, investor_tier, crypto_wallet_address, wallet_address, kyc_verified, gold_tokens, balance").eq("id", authUser.id).maybeSingle();
      const investmentsPromise = supabase.from("investments").select("*, projects(*)").eq("user_id", authUser.id).order("invested_at", { ascending: false });
      
      const transactionsPromise = supabase.from("transactions")
        .select(`*, projects(id, name, slug)`)
        .eq("user_id", authUser.id)
        .order("created_at", { ascending: false });

      const payoutsPromise = supabase.from("payout_records")
        .select(`*, projects(id, name, slug)`)
        .eq("user_id", authUser.id)
        .order("created_at", { ascending: false });

      const secondaryTradesPromise = supabase.from("secondary_trades")
        .select(`*, projects(id, name, slug)`)
        .or(`buyer_id.eq.${authUser.id},seller_id.eq.${authUser.id}`)
        .order("created_at", { ascending: false });

      const secondaryListingsPromise = supabase.from("secondary_listings")
        .select(`*`)
        .eq("investor_id", authUser.id)
        .eq("status", "active");

      const projectsPromise = fetch("/api/projects").then((res) => res.json()).catch(() => []);
      const kycPromise = supabase.from("kyc_profiles").select("status").eq("user_id", authUser.id).maybeSingle();
      const eligibilityPromise = supabase.from("eligibility_states").select("status, can_invest").eq("user_id", authUser.id).maybeSingle();

      const [
        profileRes,
        investmentsRes,
        transactionsRes,
        payoutsRes,
        secondaryTradesRes,
        secondaryListingsRes,
        projectsRes,
        kycRes,
        eligibilityRes,
      ] = await Promise.all([
        profilePromise,
        investmentsPromise,
        transactionsPromise,
        payoutsPromise,
        secondaryTradesPromise,
        secondaryListingsPromise,
        projectsPromise,
        kycPromise,
        eligibilityPromise
      ]);

      let profile = profileRes.data;
      
      // AUTO-REPAIR
      if (!profile && authUser) {
        try {
          const repairRes = await fetch("/api/profile/repair", { method: "POST" });
          const repairData = await repairRes.json();
          if (repairData.success) profile = repairData.profile;
        } catch (err) { console.error("[useDashboardData] Repair failed:", err); }
      }

      const dbWallet = profile;
      const dbInvestments = investmentsRes.data || [];
      const dbTransactions = transactionsRes.data || [];
      const dbPayouts = payoutsRes.data || [];
      const dbSecondaryListings = secondaryListingsRes.data || [];
      const projects = Array.isArray(projectsRes) ? projectsRes : [];
      const currentKycStatus = (kycRes.data as any)?.status || (kycRes.data as any)?.kyc_status || (profile?.kyc_verified ? 'approved' : 'not_started');
      
      // FINAL SYNC: If DB says 'investment_eligible' but blockchain check failed, 
      // we trust the DB for UI purposes to prevent "Verify KYC" flash if on-chain sync is just slow.
      const isDbEligible = (eligibilityRes.data as any)?.status === 'investment_eligible';
      const hasInvestmentPermission = (eligibilityRes.data as any)?.can_invest === true || (eligibilityRes.data as any)?.canInvest === true;
      
      if (!blockchainVerified && isDbEligible && hasInvestmentPermission) {
        blockchainVerified = true; 
      }

      // 3. AGGREGATE ACTIVITY FEED (Merging multiple sources)
      const allInvestments: any[] = dbInvestments.map(inv => ({
        ...inv,
        is_on_chain: false
      }));
      
      // Start with DB transactions as baseline
      const transactionMap = new Map();

      // 1. Add records from transactions table
      dbTransactions.forEach(tx => {
        const id = tx.blockchain_hash || tx.id;
        transactionMap.set(id, {
          ...tx,
          id,
          date: tx.created_at || tx.initiated_at
        });
      });

      // 2. Add records from investments table (if not already present)
      dbInvestments.forEach(inv => {
        const id = inv.minted_tx_hash || inv.finalized_tx_hash || inv.id;
        if (!transactionMap.has(id)) {
          transactionMap.set(id, {
            id,
            type: 'investment',
            amount: inv.amount,
            status: inv.status === 'approved' ? 'completed' : 'pending',
            created_at: inv.invested_at || inv.created_at,
            projects: inv.projects,
            description: `Investment in ${inv.projects?.name || 'Project'}`,
            date: inv.invested_at || inv.created_at
          });
        }
      });

      // 3. Add records from payout_records table
      dbPayouts.forEach(payout => {
        const id = payout.tx_hash || payout.id;
        if (!transactionMap.has(id)) {
          transactionMap.set(id, {
            id,
            type: 'dividend',
            amount: payout.amount_due,
            status: payout.status === 'completed' ? 'completed' : 'pending',
            created_at: payout.paid_at || payout.created_at,
            projects: payout.projects,
            description: `Dividend from ${payout.projects?.name || 'Project'}`,
            date: payout.paid_at || payout.created_at
          });
        }
      });

      const dbSecondaryTrades = secondaryTradesRes.data || [];
      // 4. Add records from secondary_trades table
      dbSecondaryTrades.forEach(trade => {
        const id = trade.trade_tx || trade.id;
        const isBuyer = trade.buyer_id === authUser.id;
        const isSeller = trade.seller_id === authUser.id;
        
        // Add to transactions
        if (!transactionMap.has(id)) {
          transactionMap.set(id, {
            id,
            type: isBuyer ? 'secondary_purchase' : 'secondary_sale',
            amount: isBuyer ? trade.paid_amount : (trade.paid_amount * 0.985), // Seller pays 1.5% fee
            status: 'completed',
            created_at: trade.created_at,
            projects: trade.projects,
            description: isBuyer ? `Secondary Market Purchase of ${trade.projects?.name || 'Project'}` : `Secondary Market Sale of ${trade.projects?.name || 'Project'}`,
            date: trade.created_at
          });
        }

        // Add to investments (only for buyer)
        if (isBuyer) {
          allInvestments.push({
            id: `sec_trade_${trade.id}`,
            project_id: trade.project_id,
            amount: trade.paid_amount,
            tokens_purchased: trade.token_amount,
            status: 'completed',
            invested_at: trade.created_at,
            projects: trade.projects,
            is_secondary: true,
            minted_tx_hash: trade.trade_tx
          });
        }
        
        // Add negative investment for seller to reduce total token count
        if (isSeller) {
          // Find their original investment to estimate cost basis
          const originalInvestment = dbInvestments.find(inv => inv.project_id === trade.project_id);
          const avgCost = originalInvestment && originalInvestment.tokens_purchased > 0 
            ? originalInvestment.amount / originalInvestment.tokens_purchased 
            : 0;
            
          allInvestments.push({
            id: `sec_trade_sell_${trade.id}`,
            project_id: trade.project_id,
            amount: -(trade.token_amount * avgCost),
            tokens_purchased: -trade.token_amount,
            status: 'completed',
            invested_at: trade.created_at,
            projects: trade.projects,
            is_secondary: true,
            minted_tx_hash: trade.trade_tx
          });
        }
      });

      const allTransactions = Array.from(transactionMap.values());

      if (wallet.publicKey) {
        try {
          const program = getComplianceProgram(connection, wallet);
          let userSubs: any[] = [];
          try {
             userSubs = await program.account.investmentSubscriptionAccount.all([
              {
                memcmp: {
                  offset: 16, // investor is at offset 16 (8 disc + 8 subId)
                  bytes: wallet.publicKey.toBase58()
                }
              }
            ]);
          } catch (rpcErr: any) {
            console.warn("[useDashboardData] On-chain subscription fetch failed:", rpcErr.message);
          }
          
          userSubs.forEach((sub: any) => {
            const acc = sub.account;
            const subId = acc.subscriptionId.toString();
            const blockchainId = acc.projectId.toString();
            const project = projects.find((p: any) => p.blockchain_project_id?.toString() === blockchainId);
            
            const dbMatch = dbInvestments.find(inv => inv.offering_id === subId);
            let realHash = dbMatch?.minted_tx_hash || dbMatch?.finalized_tx_hash || (acc.settlementTxHash ? bs58.encode(acc.settlementTxHash) : null);
            
            const amount = Number(acc.investmentAmount.toString()) / 1_000_000;
            const currentPrice = Number(project?.token_price || 0.18);
            const rawTokens = Number(acc.allocatedTokenAmount.toString()) / 1_000_000; 
            const expectedTokens = amount / currentPrice;
            const tokenQty = (Math.abs(rawTokens - expectedTokens) / expectedTokens > 0.1) ? expectedTokens : rawTokens;
            const priceAtPurchase = tokenQty > 0 ? (amount / tokenQty) : currentPrice;

            const invData = {
              id: realHash || subId,
              subId: subId,
              project_id: project?.id || blockchainId,
              amount: amount,
              tokens_purchased: tokenQty,
              token_price_at_purchase: priceAtPurchase,
              status: Object.keys(acc.status)[0].toLowerCase(),
              invested_at: new Date(acc.createdAt.toNumber() * 1000).toISOString(),
              projects: project || { name: `Project #${blockchainId}` },
              is_on_chain: true,
              minted_tx_hash: dbMatch?.minted_tx_hash || null,
              finalized_tx_hash: dbMatch?.finalized_tx_hash || (acc.settlementTxHash ? bs58.encode(acc.settlementTxHash) : null),
            };
            
            const existingIndex = allInvestments.findIndex(inv => inv.subId === subId || inv.offering_id === subId);
            if (existingIndex >= 0) {
              allInvestments[existingIndex] = { ...allInvestments[existingIndex], ...invData };
            } else {
              allInvestments.push(invData);
              
              // Only push to transactions if it's a NEW blockchain-only record
              const txExists = allTransactions.some(tx => 
                (tx.subId && tx.subId === subId) || 
                (tx.blockchain_hash && invData.finalized_tx_hash && tx.blockchain_hash === invData.finalized_tx_hash)
              );

              if (!txExists) {
                allTransactions.push({
                  id: invData.finalized_tx_hash || `sub_${subId}`,
                  subId: subId,
                  type: 'investment',
                  amount: invData.amount,
                  status: (invData.status === 'settled' || invData.status === 'allocated') ? 'completed' : 'pending',
                  created_at: invData.invested_at,
                  projects: invData.projects,
                  description: `Blockchain Subscription #${subId}`
                });
              }
            }
          });

          // SIGNATURE FINDER REMOVED to prevent 429 errors.
          // The background indexer handles syncing these hashes to the database.
          
          // Also fetch project token balances for "Gold Tokens" stat

          // Also fetch project token balances for "Gold Tokens" stat
          // 3. Combined Token Balances Check
          const projectMints = projects
            .filter((p: any) => p.onChain && p.onChain.mint)
            .map((p: any) => p.onChain.mint);
            
          // 3. Combined Token Balances Check
          const tokenMints = [
            process.env.NEXT_PUBLIC_USDC_MINT,
            process.env.NEXT_PUBLIC_USDT_MINT
          ].filter(Boolean) as string[];

          const allMints = [...new Set([...projectMints, ...tokenMints])];
          
          const balancePromises = allMints.map(async (mint: string) => {
            try {
              const mintPubkey = new PublicKey(mint);
              const ata = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey!);
              const balanceRes = await connection.getTokenAccountBalance(ata);
              return balanceRes.value.uiAmount || 0;
            } catch (e) { return 0; }
          });
          
          const tokenBalances = await Promise.all(balancePromises);
          onChainGoldTokens = tokenBalances.reduce((sum, b) => sum + b, 0);

        } catch (e) {
          console.error("[useDashboardData] On-chain fetch failed:", e);
        }
      }

      // 3. Final Reconciliation
      let totalInvested = 0;
      let totalReturns = 0;
      let portfolioValue = 0;
      let activeProjectsCount = 0;

      try {
        const summaryRes = await fetch("/api/portfolio/summary");
        if (summaryRes.ok) {
          const summary = await summaryRes.json();
          totalInvested = summary.totalInvested;
          totalReturns = summary.totalReturn;
          portfolioValue = summary.totalValue;
          activeProjectsCount = summary.activePositions;
        } else {
          // Fallback to local calculation if API fails
          totalInvested = allInvestments.reduce((sum, inv) => sum + Number(inv.amount), 0);
          portfolioValue = totalInvested;
          activeProjectsCount = allInvestments.filter((inv) => inv.projects?.status === "active").length;
        }
      } catch (apiErr) {
        console.error("[useDashboardData] Failed to fetch portfolio summary API:", apiErr);
        totalInvested = allInvestments.reduce((sum, inv) => sum + Number(inv.amount), 0);
        portfolioValue = totalInvested;
        activeProjectsCount = allInvestments.filter((inv) => inv.projects?.status === "active").length;
      }

      const usdBalance = Number(dbWallet?.balance || 0);

      allTransactions.sort((a, b) => {
        const dateA = new Date(a.date || a.created_at || a.initiated_at || a.paid_at || 0).getTime();
        const dateB = new Date(b.date || b.created_at || b.initiated_at || b.paid_at || 0).getTime();
        return dateB - dateA;
      });

      // Determine final verification status by combining DB and Blockchain
      const isDbVerified = (eligibilityRes.data?.status === 'investment_eligible' && (eligibilityRes.data?.can_invest === true || (eligibilityRes.data as any)?.canInvest === true));
      const kycStatus = kycRes.data?.status || (profile?.kyc_verified ? 'approved' : 'not_started');

      // Use the unified statuses calculated earlier
      setData({
        user: {
          name: `${profile?.first_name || authUser.user_metadata?.first_name || ""} ${profile?.last_name || authUser.user_metadata?.last_name || ""}`.trim() || authUser.user_metadata?.full_name || "User",
          email: profile?.email || authUser.email || "",
          investorTier: profile?.investor_tier || "browser",
          isKycVerified: currentKycStatus === 'approved' || currentKycStatus === 'verified' || currentKycStatus === 'investment_eligible' || currentKycStatus === 'kyc_approved',
          kycStatus: currentKycStatus,
          isOnChainVerified: blockchainVerified,
        },
        stats: {
          totalInvested,
          totalReturns,
          portfolioValue,
          goldTokens: onChainGoldTokens || Number(dbWallet?.gold_tokens || 0),
          usdBalance,
          activeProjectsCount: allInvestments.filter((inv) => inv.projects?.status === "active").length,
        },
        investments: allInvestments,
        transactions: allTransactions,
        portfolioPositions: allInvestments,
        projects,
        secondaryListings: dbSecondaryListings,
        loading: false,
        error: null,
      });
    } catch (err: any) {
      // 1. Silent Guard: Completely ignore AbortErrors to prevent Next.js overlay
      if (err.name === 'AbortError' || err.message?.includes('aborted') || err.code === 20) {
        return; 
      }
      
      console.error("Dashboard Data Fetch Error:", err);
      setData((prev) => ({ 
        ...prev, 
        loading: false, 
        error: err.message || "Failed to load data" 
      }));
    } finally {
      isFetching.current = false;
    }
  }, [wallet.publicKey, connection]);

  useEffect(() => {
    // Add a small delay to allow wallet state to stabilize
    const timer = setTimeout(() => {
      fetchAllData();
    }, 100);
    return () => clearTimeout(timer);
  }, [fetchAllData]);

  return { ...data, refresh: fetchAllData };
}
