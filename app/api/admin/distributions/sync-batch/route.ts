import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const { recordsToInsert } = await req.json();

    if (!recordsToInsert || recordsToInsert.length === 0) {
      return NextResponse.json({ error: 'No records provided' }, { status: 400 });
    }

    const supabase = createAdminClient();
    
    // Perform bulk upsert/insert safely bypassing RLS
    const { data, error } = await supabase.from('payout_records').insert(recordsToInsert);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    console.error('Batch sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
