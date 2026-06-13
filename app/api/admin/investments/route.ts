import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: "Missing Supabase configuration" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: dbInvestments, error } = await supabase.from('investments')
      .select('id, amount, status, tokens_purchased, invested_at, minted_tx_hash, finalized_tx_hash, offering_id, project_id, user_id, projects!inner(id, blockchain_project_id, name, images, token_symbol, token_price)')
      .order('invested_at', { ascending: false });

    if (error) throw error;

    let dbInvWithProfiles = dbInvestments || [];
    const userIds = [...new Set(dbInvWithProfiles.map((i: any) => i.user_id).filter(Boolean))];
    
    let profilesMap: Record<string, any> = {};
    if (userIds.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, crypto_wallet_address, first_name, last_name').in('id', userIds);
      if (profs) profs.forEach((p: any) => { profilesMap[p.id] = p; });
    }

    dbInvWithProfiles.forEach((inv: any) => {
      inv.profiles = profilesMap[inv.user_id] || null;
      // For Admin UI: If it hasn't been minted yet, it is still "Pending Action"
      if (!inv.minted_tx_hash) {
        inv.status = 'pending';
      }
    });

    return NextResponse.json({ data: dbInvWithProfiles });
  } catch (err: any) {
    console.error("Admin API Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
