import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const epochId = searchParams.get('epochId');

  if (!projectId || !epochId) {
    return NextResponse.json({ error: 'Missing projectId or epochId' }, { status: 400 });
  }

  try {
    const supabaseAdmin = createAdminClient();

    // 1. Fetch portfolio positions bypassing RLS
    const { data: positions, error: positionsError } = await supabaseAdmin
      .from('portfolio_positions')
      .select('user_id, total_tokens, locked_tokens')
      .eq('project_id', projectId)
      .gt('total_tokens', 0);
      
    if (positionsError) throw positionsError;

    // 2. Fetch already paid records bypassing RLS
    const { data: paidRecords } = await supabaseAdmin
      .from('payout_records')
      .select('user_id')
      .eq('cycle_id', epochId);

    const paidUserIds = paidRecords?.map((r: any) => r.user_id) || [];

    // 3. Resolve wallets
    const allUserIds = Array.from(new Set(positions?.map((p: any) => p.user_id) || []));
    
    let userIdToWallet: Record<string, string> = {};
    if (allUserIds.length > 0) {
      const [profilesRes, linksRes] = await Promise.all([
        supabaseAdmin.from('profiles').select('id, crypto_wallet_address').in('id', allUserIds),
        supabaseAdmin.from('wallet_links').select('user_id, wallet_address').in('user_id', allUserIds)
      ]);

      profilesRes.data?.forEach((p: any) => {
        if (p.crypto_wallet_address) {
          userIdToWallet[p.id] = p.crypto_wallet_address;
        }
      });
      linksRes.data?.forEach((l: any) => {
        if (!userIdToWallet[l.user_id] && l.wallet_address) {
          userIdToWallet[l.user_id] = l.wallet_address;
        }
      });
    }

    return NextResponse.json({ 
      positions: positions || [], 
      paidUserIds, 
      userIdToWallet 
    });

  } catch (error: any) {
    console.error('Error fetching investors (Admin API):', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
