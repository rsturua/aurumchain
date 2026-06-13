/**
 * API Route: Admin investment finalization sync
 * POST /api/admin/investments/finalize
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS.
 * Called by the admin page after a successful finalizeSubscription tx.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { AdminService } from '@/lib/domains/admin/service';

export async function POST(request: NextRequest) {
  try {
    // Verify the caller is an authenticated admin
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Enforce admin role — same check used by the admin layout.
    // Blocks direct API calls (curl, Postman, etc.) from non-admin logged-in users.
    const isAdmin = await AdminService.isAdmin(user.id);
    if (!isAdmin) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const { invDbId, offeringId, mintedTxHash, approvedAt } = body;

    if (!mintedTxHash) {
      return NextResponse.json({ error: 'mintedTxHash is required' }, { status: 400 });
    }
    if (!invDbId && !offeringId) {
      return NextResponse.json({ error: 'invDbId or offeringId is required' }, { status: 400 });
    }

    // Use service role to bypass RLS — admin can update any investor's row
    const adminSupabase = await createAdminClient();

    const updatePayload = {
      status: 'approved',
      minted_tx_hash: mintedTxHash,
      approved_at: approvedAt,
      updated_at: new Date().toISOString(),
    };

    let rowsUpdated = 0;

    // Primary: update by DB UUID
    if (invDbId) {
      const { data, error } = await adminSupabase
        .from('investments')
        .update(updatePayload)
        .eq('id', invDbId)
        .select('id');

      if (!error && data && data.length > 0) {
        rowsUpdated = data.length;
        console.log(`[API/finalize] ✅ Updated by id: ${invDbId} (${rowsUpdated} row)`);
      } else {
        console.warn(`[API/finalize] ⚠️ Update by id matched 0 rows | id: ${invDbId} | error: ${error?.message}`);
      }
    }

    // Fallback: update by offering_id
    if (rowsUpdated === 0 && offeringId) {
      const { data, error } = await adminSupabase
        .from('investments')
        .update(updatePayload)
        .eq('offering_id', String(offeringId))
        .select('id');

      if (!error && data && data.length > 0) {
        rowsUpdated = data.length;
        console.log(`[API/finalize] ✅ Updated by offering_id: ${offeringId} (${rowsUpdated} row)`);
      } else {
        console.error(`[API/finalize] ❌ Both strategies failed | offering: ${offeringId} | error: ${error?.message}`);
      }
    }

    if (rowsUpdated === 0) {
      return NextResponse.json(
        { error: `No investment row found for id=${invDbId} or offering_id=${offeringId}` },
        { status: 404 }
      );
    }

    // NEW: Also update the transactions table so the hash shows up in the Activity feed
    try {
      const txUpdatePayload = {
        blockchain_hash: mintedTxHash,
        status: 'completed',
        completed_at: new Date().toISOString(),
      };

      if (invDbId) {
        await adminSupabase
          .from('transactions')
          .update(txUpdatePayload)
          .eq('investment_id', invDbId);
      } else if (offeringId) {
        // Find the investment ID first if we only have offeringId
        const { data: inv } = await adminSupabase
          .from('investments')
          .select('id')
          .eq('offering_id', String(offeringId))
          .maybeSingle();
        
        if (inv) {
          await adminSupabase
            .from('transactions')
            .update(txUpdatePayload)
            .eq('investment_id', inv.id);
        }
      }
    } catch (txErr) {
      console.warn('[API/finalize] Failed to update transaction record:', txErr);
      // Don't fail the whole request if transaction update fails
    }

    return NextResponse.json({ success: true, rowsUpdated });

  } catch (err: any) {
    console.error('[API/finalize] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
