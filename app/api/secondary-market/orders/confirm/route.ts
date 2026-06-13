import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import { isRateLimited } from '@/lib/api/rateLimit';
import { createDefaultConnection } from '@/lib/web3/config/rpc';

const confirmOrderSchema = z.object({
  signature: z.string().min(1),
  sellOrderPda: z.string().min(1),
  projectId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    if (isRateLimited(ip)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const body = await request.json();
    const validationResult = confirmOrderSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({ error: 'Invalid request parameters' }, { status: 400 });
    }
    const { signature, sellOrderPda, projectId } = validationResult.data;

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const connection = createDefaultConnection();

    // Verify transaction exists on chain
    try {
      const { value, context } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (value?.err) {
        return NextResponse.json({ error: 'Transaction failed on the blockchain.' }, { status: 400 });
      }
      
      if (!value || (value.confirmationStatus !== 'confirmed' && value.confirmationStatus !== 'finalized')) {
        // We wait a few seconds if it's not confirmed yet
        await connection.confirmTransaction(signature, 'confirmed');
      }
    } catch (e) {
      console.error('[API/orders/confirm] Error confirming tx:', e);
      return NextResponse.json({ error: 'Could not confirm transaction on the blockchain.' }, { status: 400 });
    }

    // Update listing status to 'active'
    const { data, error: updateError } = await supabase.from('secondary_listings').update({
      status: 'active',
      creation_tx: signature,
      updated_at: new Date().toISOString()
    })
    .eq('sell_order_pda', sellOrderPda)
    .eq('investor_id', user.id)
    .select();

    if (updateError || !data || data.length === 0) {
      return NextResponse.json({ error: 'Listing not found or not owned by you.' }, { status: 404 });
    }

    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('[API/orders/confirm] Error:', error);
    return NextResponse.json(
      { error: error.message || 'An internal server error occurred.' },
      { status: 500 }
    );
  }
}
