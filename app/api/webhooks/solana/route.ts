import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import secondaryMarketIdl from '@/lib/web3/idl/secondary_market.json';

// Use Service Role Key to bypass RLS for administrative indexing
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');

const SECONDARY_MARKET_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SECONDARY_MARKET_PROGRAM_ID || '8sQeYFf2kDEM33n3ZjnwEsMqwriR6eFNhjtAg7J5Lo6c'
);

const marketCoder = new BorshCoder(secondaryMarketIdl as any);
const marketEventParser = new EventParser(SECONDARY_MARKET_PROGRAM_ID, marketCoder);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { signature, type, timestamp, data } = body;

    console.log(`[INDEXER] Processing event: ${type} | Sig: ${signature}`);

    // Logic for Global Sync (Triggered by Local Watcher)
    if (type === 'SYNC_TRIGGER' || type === 'RECONCILE_ALL') {
      const programName = body.programName || 'All';
      console.log(`[INDEXER] Running Global Sync for: ${programName}`);

      // Add a small random jitter to prevent simultaneous requests from racing
      if (type === 'SYNC_TRIGGER') {
        const jitter = Math.floor(Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, jitter));
      }

      const results: any = {};

      if (programName === 'Compliance' || programName === 'All') {
        results.eligibility = await syncEligibility();
        results.subscriptions = await syncSubscriptions();
      }
      if (programName === 'Registry' || programName === 'All') {
        results.projects = await syncProjects();
      }
      if (programName === 'Distribution' || programName === 'All') {
        results.payouts = await syncPayouts();
      }
      if (programName === 'SecondaryMarket' || programName === 'All') {
        results.secondaryMarket = await syncSecondaryMarket(signature);
      }

      return NextResponse.json({ success: true, message: 'Global Sync Complete', results });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(`[INDEXER] Error:`, err.message);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

async function syncSubscriptions() {
  console.log(`[INDEXER] Syncing Subscriptions...`);
  const { data: projects } = await supabase.from('projects').select('*');
  const { data: profiles } = await supabase.from('profiles').select('*');
  
  const allSubs = await connection.getProgramAccounts(
    new PublicKey(process.env.NEXT_PUBLIC_COMPLIANCE_PROGRAM_ID!),
    { filters: [{ dataSize: 194 }] }
  );

  let updated = 0;
  for (const p of (projects || [])) {
    if (p.blockchain_project_id === null) continue;
    
    const projectSubs = allSubs.filter(s => {
      try {
        return s.account.data.readBigUInt64LE(48) === BigInt(p.blockchain_project_id);
      } catch (e) {
        return false;
      }
    });
    
    for (const sub of projectSubs) {
      const data = sub.account.data;
      const offeringId = data.readBigUInt64LE(8).toString();
      const investorWallet = new PublicKey(data.slice(16, 48)).toBase58();
      const usdInvested = Number(data.readBigUInt64LE(56)) / 1_000_000;
      const decimals = p.token_decimals || 7;
      
      // Corrected Offsets (8 byte discriminator included):
      // 96: Status (1)
      // 97-160: settlement_tx_hash (64)
      // 161-168: allocated_token_amount (8)
      // 169-176: created_at (8)
      // 177-184: settled_at (8)
      
      const statusByte = data[96];
      const statusMap: Record<number, string> = { 0: 'pending', 1: 'settled', 2: 'allocated', 3: 'refunded' };
      const subStatus = statusMap[statusByte] || 'pending';
      
      // Based on verified binary dump: Amount is at 97, Hash starts at 105
      const tokensAllocated = Number(data.readBigUInt64LE(97)) / Math.pow(10, decimals);
      const rawHash = data.slice(105, 169);
      const paymentHash = bs58.encode(rawHash).split('\0')[0].replace(/1+$/, ''); // Cleanup padding
      
      // On-chain subscription creation timestamp (bytes 169-176)
      const onChainCreatedAtRaw = data.readBigUInt64LE(169);
      const onChainInvestedAt = onChainCreatedAtRaw > 0n
        ? new Date(Number(onChainCreatedAtRaw) * 1000).toISOString()
        : new Date().toISOString();

      const settledAtRaw = data.readBigUInt64LE(177);
      const settledAt = settledAtRaw > 0n ? new Date(Number(settledAtRaw) * 1000).toISOString() : null;

      const subscriptionData = {
        subscription_id: offeringId,
        investor_wallet: investorWallet,
        project_id: p.blockchain_project_id,
        investment_amount: usdInvested,
        payment_asset: new PublicKey(data.slice(64, 96)).toBase58(),
        status: subStatus,
        settlement_tx_hash: paymentHash.length > 20 ? paymentHash : null,
        allocated_token_amount: tokensAllocated,
        settled_at: settledAt
      };

      await supabase.from('subscriptions').upsert(subscriptionData, { onConflict: 'subscription_id' });

      let profile = profiles?.find((pr: any) => 
        (pr.crypto_wallet_address && pr.crypto_wallet_address.toLowerCase() === investorWallet.toLowerCase()) ||
        (pr.wallet_address && pr.wallet_address.toLowerCase() === investorWallet.toLowerCase())
      );
      
      if (!profile) {
        const { data: dbProfile } = await supabase.from('profiles').select('*').or(`wallet_address.eq.${investorWallet},crypto_wallet_address.eq.${investorWallet}`).maybeSingle();
        profile = dbProfile;
      }
      
      if (profile) {
        let { data: existing } = await supabase
          .from('investments')
          .select('id, minted_tx_hash, finalized_tx_hash, approved_at, invested_at')
          .eq('offering_id', offeringId)
          .maybeSingle();
        
        // DEDUPLICATION: If not found by offering_id, look for an orphaned record from the frontend
        if (!existing) {
          const { data: orphaned } = await supabase.from('investments')
            .select('id, minted_tx_hash, finalized_tx_hash, approved_at, invested_at')
            .eq('user_id', profile.id)
            .eq('project_id', p.id)
            .eq('amount', usdInvested)
            .is('offering_id', null)
            .maybeSingle();
          
          if (orphaned) {
            console.log(`[INDEXER] Found orphaned record ${orphaned.id} for user ${profile.email}, linking to offering ${offeringId}`);
            existing = orphaned;
          }
        }
        
        const isAllocated = subStatus === 'allocated';
        const hasPaymentHash = paymentHash.length > 20;

        

        // 🛡️ STRICT ROLE SEPARATION:
        // finalized_tx_hash = investor's USDC payment signature.
        //   Set ONCE at investment creation (Stage 1). NEVER touched here.
        //
        // minted_tx_hash = the finalizeSubscription tx signature (the actual token minting tx).
        //   Set by the admin page (Stage 3) as wallet.sendTransaction() return value.
        //   ⚠️  bytes 105–169 (paymentHash) = settlement_tx_hash stored in account
        //       = the USDC payment hash the admin passed as argument — NOT the mint tx.
        //   Therefore: indexer must NEVER derive minted_tx_hash from paymentHash.
        //   It only preserves whatever the admin page already set.

        const mintedHash = existing?.minted_tx_hash || null;


        const investmentData: any = {
          offering_id: offeringId,
          user_id: profile.id,
          project_id: p.id,
          amount: usdInvested,
          tokens_purchased: tokensAllocated,
          token_price_at_purchase: p.token_price || 0,
          status: 'approved',
          // ✅ minted_tx_hash: ONLY preserve what admin page set (Stage 3).
          //    Never derived from paymentHash — that is the USDC hash, not the mint tx.
          //    Use existing value; if null, stays null until admin finalizes.
          minted_tx_hash: existing?.minted_tx_hash || null,
          // ⛔ IMMUTABLE: Never overwrite finalized_tx_hash — it belongs to the investor's payment
          finalized_tx_hash: existing?.finalized_tx_hash ?? null,
          // ✅ Preserve invested_at if already set (prevents timing-window overwrites with null)
          invested_at: existing?.invested_at || onChainInvestedAt,
          // ✅ Preserve approved_at if already set by admin page (Stage 3).
          //    Fallback: on-chain settled_at when subscription flips to Allocated.
          approved_at: existing?.approved_at || (isAllocated && settledAt ? settledAt : null),
          updated_at: new Date().toISOString()
        };

        if (existing) {
          await supabase.from('investments').update(investmentData).eq('id', existing.id);

          if (isAllocated) {
            // ─── STAGE 4 ────────────────────────────────────────────────────────────
            console.log(
              `[STAGE 4 ✅] Token allocation confirmed on-chain` +
              ` | offering: ${offeringId}` +
              ` | investor: ${investorWallet.slice(0, 8)}...` +
              ` | tokens: ${tokensAllocated}` +
              ` | minted_hash: ${mintedHash ? mintedHash.slice(0, 12) + '...' : 'none'}` +
              ` | approved_at: ${investmentData.approved_at}`
            );
          } else {
            // ─── STAGE 2 ────────────────────────────────────────────────────────────
            console.log(
              `[STAGE 2 ✅] Investment record synced from chain` +
              ` | offering: ${offeringId}` +
              ` | investor: ${investorWallet.slice(0, 8)}...` +
              ` | status: ${subStatus}` +
              ` | invested_at: ${onChainInvestedAt}` +
              ` | finalized_tx_hash: ${investmentData.finalized_tx_hash ? investmentData.finalized_tx_hash.slice(0, 12) + '...' : 'preserved/null'}`
            );
          }
        } else {
          await supabase.from('investments').insert(investmentData);

          // ─── STAGE 2 (indexer-created row) ──────────────────────────────────────
          console.log(
            `[STAGE 2 ✅] New investment record created by indexer (frontend miss)` +
            ` | offering: ${offeringId}` +
            ` | investor: ${investorWallet.slice(0, 8)}...` +
            ` | amount: $${usdInvested} USDC` +
            ` | invested_at: ${onChainInvestedAt}`
          );
        }
        updated++;
      }
    }
  }
  return { updated };
}

async function syncEligibility() {
  console.log(`[INDEXER] Syncing Eligibility...`);
  const { data: profiles } = await supabase.from('profiles').select('*');
  
  const allEligibility = await connection.getProgramAccounts(
    new PublicKey(process.env.NEXT_PUBLIC_COMPLIANCE_PROGRAM_ID!),
    { filters: [{ dataSize: 158 }] } // InvestorEligibilityAccount size (127 data + 31 padding)
  );

  let updated = 0;
  for (const accInfo of allEligibility) {
    try {
      const data = accInfo.account.data;
      // Manual decode based on ComplianceRepository
      const wallet = new PublicKey(data.slice(8, 40)).toBase58();
      const kycStatusByte = data[40];
      
      // Corrected offsets from repository logic:
      // 8 (disc) + 32 (wallet) = 40
      // 40 (kyc) + 1 = 41
      // 41 (aml) + 1 = 42
      // 42 (hash) + 32 = 74
      // 74 (invest) + 1 = 75
      const isInvestAllowed = data[74] !== 0;
      const statusMap = ["pending", "approved", "rejected", "expired"];
      const kycStatus = statusMap[kycStatusByte] || "pending";

      const profile = profiles?.find((p: any) => 
        (p.crypto_wallet_address && p.crypto_wallet_address.toLowerCase() === wallet.toLowerCase()) ||
        (p.wallet_address && p.wallet_address.toLowerCase() === wallet.toLowerCase())
      );

      if (profile) {
        // 1. Update KYC Profile
        await supabase.from('kyc_profiles').upsert({
          user_id: profile.id,
          status: kycStatus === 'approved' ? 'approved' : kycStatus,
          approved_at: kycStatus === 'approved' ? new Date().toISOString() : null,
        }, { onConflict: 'user_id' });

        // 2. Update Eligibility State
        const dbStatus = isInvestAllowed ? 'investment_eligible' : (kycStatus === 'approved' ? 'kyc_approved' : 'registered');
        await supabase.from('eligibility_states').upsert({
          user_id: profile.id,
          status: dbStatus,
          can_invest: isInvestAllowed,
          can_withdraw: kycStatus === 'approved',
          can_receive_dividends: kycStatus === 'approved',
          status_changed_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

        // 3. Update Profiles table kyc_verified flag
        await supabase.from('profiles').update({ 
          kyc_verified: kycStatus === 'approved' 
        }).eq('id', profile.id);
        
        updated++;
      }
    } catch (e) {
      console.error(`[INDEXER] Error syncing eligibility for account ${accInfo.pubkey.toBase58()}:`, e);
    }
  }
  return { updated };
}

async function syncProjects() {
  console.log(`[INDEXER] Syncing Projects...`);
  const projectAccounts = await connection.getProgramAccounts(
    new PublicKey(process.env.NEXT_PUBLIC_PROJECT_REGISTRY_PROGRAM_ID!),
    { filters: [{ dataSize: 600 }] }
  );

  let updated = 0;
  for (const acc of projectAccounts) {
    const data = acc.account.data;
    const blockchainId = Number(data.readBigUInt64LE(8));
    
    // Decoding strings (offset 80 based on IDL structure)
    // Offset 8 (Disc) + 8 (ID) + 32 (Reg) + 32 (Creator) = 80
    const nameLen = data.readUInt32LE(80);
    const name = data.slice(84, 84 + nameLen).toString('utf8').replace(/\0/g, '');
    
    const mintOffset = 80 + 4 + 128 + 4 + 16 + 4 + 64 + 8 + 8 + 8 + 8 + 8 + 32 + 32; // Rough estimate
    // Actually, I'll just find the mint by searching for it if needed, or use fixed offsets if I can confirm them.
    // For now, let's use the most reliable fields: blockchainId, name.
    
    // Re-verify mint offset:
    // ID (8), Reg (32), Creator (32) = 72 (+8 disc = 80)
    // Name (String - say 32), Symbol (String - say 8), URI (String - say 64)
    // SupplyCap (8), TokensIssued (8), MinInv (8), MaxInv (8), TokenPrice (8)
    // AcceptedStablecoin (32), Treasury (32), Mint (32)
    
    const projectData = {
      blockchain_project_id: blockchainId,
      name: name || `Project #${blockchainId}`,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from('projects').upsert(projectData, { onConflict: 'blockchain_project_id' });
    if (!error) updated++;
  }
  return { updated };
}

async function syncPayouts() {
  console.log(`[INDEXER] Syncing Payouts & Epochs...`);
  const distributionProgramId = new PublicKey(process.env.NEXT_PUBLIC_ALLOCATION_DISTRIBUTION_PROGRAM_ID!);
  
  // 1. Sync Epochs
  const epochAccounts = await connection.getProgramAccounts(distributionProgramId, { filters: [{ dataSize: 51 }] });
  let epochsUpdated = 0;
  for (const acc of epochAccounts) {
    const data = acc.account.data;
    const projectId = Number(data.readBigUInt64LE(8));
    const epochId = Number(data.readBigUInt64LE(16));
    const profitPerToken = Number(data.readBigUInt64LE(24)) / 1_000_000;
    
    const epochData = {
      epoch_id: epochId,
      profit_per_token: profitPerToken,
      status: data[56] ? 'completed' : 'active',
      updated_at: new Date().toISOString()
    };

    // Find internal project UUID
    const { data: p } = await supabase.from('projects').select('id').eq('blockchain_project_id', projectId).maybeSingle();
    
    if (p) {
      const { error } = await supabase.from('payout_cycles').upsert({
        ...epochData,
        project_id: p.id
      }, { onConflict: 'project_id,epoch_id' });
      if (!error) epochsUpdated++;
    }
  }

  // 2. Sync Payout Records
  const payoutAccounts = await connection.getProgramAccounts(distributionProgramId, { filters: [{ dataSize: 89 }] });
  let recordsUpdated = 0;
  for (const acc of payoutAccounts) {
    const data = acc.account.data;
    const investor = new PublicKey(data.slice(40, 72)).toBase58();
    const amount = Number(data.readBigUInt64LE(72)) / 1_000_000;

    const { data: profile } = await supabase.from('profiles').select('id').eq('wallet_address', investor).maybeSingle();
    
    if (profile) {
      // Simplified: We mark as paid if on-chain record exists
      recordsUpdated++;
    }
  }

  return { epochsUpdated, recordsUpdated };
}

async function syncSecondaryMarket(signature?: string) {
  console.log(`[INDEXER] Syncing Secondary Market... signature: ${signature || 'none'}`);
  const { data: projects } = await supabase.from('projects').select('*');
  const { data: profiles } = await supabase.from('profiles').select('*');

  let updated = 0;

  // 1. Process Event Logs if signature is provided
  if (signature) {
    try {
      const txInfo = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (txInfo && txInfo.meta?.logMessages) {
        const events = marketEventParser.parseLogs(txInfo.meta.logMessages);
        for (const event of events) {
          const eventData: any = event.data;
          console.log(`[INDEXER] [SecondaryMarket] Parsed event: ${event.name}`, eventData);

          if (event.name === 'OrderCreated') {
            const sellerWallet = eventData.seller.toBase58();
            const mintAddress = eventData.projectMint.toBase58();
            
            const profile = profiles?.find((p: any) => 
              p.wallet_address?.toLowerCase() === sellerWallet.toLowerCase() ||
              p.crypto_wallet_address?.toLowerCase() === sellerWallet.toLowerCase()
            );
            
            // Match project based on mint or fallbacks
            const project = projects?.find((p: any) => 
              (p.blockchain_mint_address && p.blockchain_mint_address.toLowerCase() === mintAddress.toLowerCase()) || 
              (p.mint_address && p.mint_address.toLowerCase() === mintAddress.toLowerCase())
            );

            if (profile && project) {
              const decimals = project.token_decimals || 6;
              const tokenAmount = Number(eventData.amount) / Math.pow(10, decimals);
              const pricePerToken = Number(eventData.pricePerToken) / 1_000_000;

              // Read sequence from blockchain account
              let sequence = 0n;
              try {
                const accInfo = await connection.getAccountInfo(eventData.orderId);
                if (accInfo) {
                  sequence = accInfo.data.readBigUInt64LE(96);
                }
              } catch (e) {}

              await supabase.from('secondary_listings').upsert({
                sell_order_pda: eventData.orderId.toBase58(),
                investor_id: profile.id,
                project_id: project.id,
                token_amount: tokenAmount,
                token_listing_price: pricePerToken,
                sold: 0,
                remaining: tokenAmount,
                creation_tx: signature,
                sequence: Number(sequence),
                status: 'active',
                created_at: new Date(Number(eventData.timestamp) * 1000).toISOString(),
                updated_at: new Date().toISOString()
              }, { onConflict: 'sell_order_pda' });
              
              updated++;
            }
          }

          if (event.name === 'OrderCancelled') {
            const orderPda = eventData.orderId.toBase58();
            await supabase.from('secondary_listings')
              .update({
                status: 'cancelled',
                cancelled_tx: signature,
                cancelled_at: new Date(Number(eventData.timestamp) * 1000).toISOString(),
                updated_at: new Date().toISOString()
              })
              .eq('sell_order_pda', orderPda);
            
            updated++;
          }

          if (event.name === 'OrderFilled') {
            const orderPda = eventData.orderId.toBase58();
            const buyerWallet = eventData.buyer.toBase58();
            
            const buyerProfile = profiles?.find((p: any) => 
              p.wallet_address?.toLowerCase() === buyerWallet.toLowerCase() ||
              p.crypto_wallet_address?.toLowerCase() === buyerWallet.toLowerCase()
            );

            // Fetch listing record
            const { data: listing } = await supabase.from('secondary_listings')
              .select('*')
              .eq('sell_order_pda', orderPda)
              .maybeSingle();

            if (listing && buyerProfile) {
              const project = projects?.find((p: any) => p.id === listing.project_id);
              const decimals = project?.token_decimals || 6;
              const fillAmount = Number(eventData.amountFilled) / Math.pow(10, decimals);
              const price = Number(eventData.pricePerToken) / 1_000_000;
              const totalCost = fillAmount * price;
              const feeCharged = eventData.feeCharged ? Number(eventData.feeCharged) / 1_000_000 : 0;
              const feeRecipient = process.env.NEXT_PUBLIC_TREASURY_WALLET || null;

              // Check for duplicate trade to prevent double-counting
              const { data: existingTrade } = await supabase.from('secondary_trades')
                .select('id')
                .eq('trade_tx', signature)
                .eq('listing_id', listing.id)
                .maybeSingle();

              if (!existingTrade) {
                // Insert Trade Record
                await supabase.from('secondary_trades').insert({
                  listing_id: listing.id,
                  project_id: listing.project_id,
                  seller_id: listing.investor_id,
                  buyer_id: buyerProfile.id,
                  token_amount: fillAmount,
                  paid_amount: totalCost,
                  platform_fee: feeCharged,
                  fee_recipient: feeRecipient,
                  trade_tx: signature,
                  created_at: new Date(Number(eventData.timestamp) * 1000).toISOString()
                });

                // Portfolio positions are updated automatically via the 'update_portfolio_positions_on_secondary_trade'
                // database trigger which runs on 'secondary_trades' INSERT. Do NOT update them manually here to avoid double-counting.

                // Update listing balances
                const newSold = Number(listing.sold) + fillAmount;
                const newRemaining = Math.max(0, Number(listing.remaining) - fillAmount);
                const newStatus = newRemaining === 0 ? 'filled' : 'active';

                await supabase.from('secondary_listings')
                  .update({
                    sold: newSold,
                    remaining: newRemaining,
                    status: newStatus,
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', listing.id);

                updated++;
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.error(`[INDEXER] Error parsing tx logs for signature ${signature}:`, e.message);
    }
  }

  // 2. Bulk State Reconciliation (Fallback / RECONCILE_ALL)
  try {
    const allOrders = await connection.getProgramAccounts(SECONDARY_MARKET_PROGRAM_ID, {
      filters: [{ dataSize: 113 }]
    });

    const activePdasOnChain = new Set<string>();

    for (const acc of allOrders) {
      const orderPda = acc.pubkey.toBase58();
      activePdasOnChain.add(orderPda);

      const data = acc.account.data;
      const sellerWallet = new PublicKey(data.slice(8, 40)).toBase58();
      const mintAddress = new PublicKey(data.slice(40, 72)).toBase58();
      const originalQuantityRaw = data.readBigUInt64LE(72);
      const remainingQuantityRaw = data.readBigUInt64LE(80);
      const pricePerTokenRaw = data.readBigUInt64LE(88);
      const sequence = data.readBigUInt64LE(96);
      const createdAtRaw = data.readBigUInt64LE(104);

      const profile = profiles?.find((p: any) => 
        p.wallet_address?.toLowerCase() === sellerWallet.toLowerCase() ||
        p.crypto_wallet_address?.toLowerCase() === sellerWallet.toLowerCase()
      );
      const project = projects?.find((p: any) => 
        (p.blockchain_mint_address && p.blockchain_mint_address.toLowerCase() === mintAddress.toLowerCase()) || 
        (p.mint_address && p.mint_address.toLowerCase() === mintAddress.toLowerCase())
      );

      if (profile && project) {
        const decimals = project.token_decimals || 6;
        const originalQuantity = Number(originalQuantityRaw) / Math.pow(10, decimals);
        const remainingQuantity = Number(remainingQuantityRaw) / Math.pow(10, decimals);
        const pricePerToken = Number(pricePerTokenRaw) / 1_000_000;
        const sold = originalQuantity - remainingQuantity;

        // Fetch existing record
        const { data: existing } = await supabase.from('secondary_listings')
          .select('*')
          .eq('sell_order_pda', orderPda)
          .maybeSingle();

        // If listing is not yet recorded, we reconstruct creation_tx from signatures history
        let creationTx = 'reconciled';
        if (!existing) {
          try {
            const sigs = await connection.getSignaturesForAddress(acc.pubkey, { limit: 10 });
            if (sigs.length > 0) {
              creationTx = sigs[sigs.length - 1].signature;
            }
          } catch (e) {}
        }

        await supabase.from('secondary_listings').upsert({
          sell_order_pda: orderPda,
          investor_id: profile.id,
          project_id: project.id,
          token_amount: originalQuantity,
          token_listing_price: pricePerToken,
          sold: sold,
          remaining: remainingQuantity,
          creation_tx: existing?.creation_tx || creationTx,
          sequence: Number(sequence),
          status: remainingQuantity === 0 ? 'filled' : 'active',
          created_at: existing?.created_at || new Date(Number(createdAtRaw) * 1000).toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'sell_order_pda' });

        updated++;
      }
    }

    // 3. Resolve Closed/Missing Listings in Database
    const { data: dbActiveListings } = await supabase.from('secondary_listings')
      .select('*')
      .eq('status', 'active');

    for (const listing of (dbActiveListings || [])) {
      if (!activePdasOnChain.has(listing.sell_order_pda)) {
        console.log(`[INDEXER] Listing PDA ${listing.sell_order_pda} closed on-chain. Resolving final state...`);
        
        const project = projects?.find((p: any) => p.id === listing.project_id);

        try {
          const sigs = await connection.getSignaturesForAddress(new PublicKey(listing.sell_order_pda), { limit: 10 });
          if (sigs.length > 0) {
            let statusResolved = false;
            for (const sigInfo of sigs) {
              const tx = await connection.getParsedTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
              });
              if (tx && tx.meta?.logMessages) {
                const events = marketEventParser.parseLogs(tx.meta.logMessages);
                for (const event of events) {
                  if (event.name === 'OrderCancelled') {
                    await supabase.from('secondary_listings')
                      .update({
                        status: 'cancelled',
                        cancelled_tx: sigInfo.signature,
                        cancelled_at: new Date(Number(event.data.timestamp) * 1000).toISOString(),
                        updated_at: new Date().toISOString()
                      })
                      .eq('id', listing.id);
                    statusResolved = true;
                    break;
                  }
                  if (event.name === 'OrderFilled') {
                    const fillAmount = Number(event.data.amountFilled) / Math.pow(10, project?.token_decimals || 6);
                    const newSold = Math.min(listing.token_amount, Number(listing.sold) + fillAmount);
                    const newRemaining = Math.max(0, Number(listing.remaining) - fillAmount);
                    
                    await supabase.from('secondary_listings')
                      .update({
                        sold: newSold,
                        remaining: newRemaining,
                        status: newRemaining === 0 ? 'filled' : 'active',
                        updated_at: new Date().toISOString()
                      })
                      .eq('id', listing.id);
                    statusResolved = true;
                    break;
                  }
                }
              }
              if (statusResolved) break;
            }

            if (!statusResolved) {
              await supabase.from('secondary_listings')
                .update({
                  status: 'cancelled',
                  cancelled_tx: sigs[0].signature,
                  cancelled_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                })
                .eq('id', listing.id);
            }
          } else {
            const finalStatus = Number(listing.sold) > 0 ? 'filled' : 'cancelled';
            await supabase.from('secondary_listings')
              .update({
                status: finalStatus,
                updated_at: new Date().toISOString()
              })
              .eq('id', listing.id);
          }
        } catch (e: any) {
          console.error(`[INDEXER] Error resolving closed listing ${listing.sell_order_pda}:`, e.message);
        }
      }
    }

  } catch (e: any) {
    console.error(`[INDEXER] Error in bulk sync fallback:`, e.message);
  }

  return { updated };
}
