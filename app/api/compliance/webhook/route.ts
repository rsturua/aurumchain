/**
 * API Route: Sumsub webhook handler
 * POST /api/compliance/webhook
 *
 * Receives KYC status updates from Sumsub.
 * Every request is verified against the HMAC-SHA256 signature that Sumsub
 * attaches in the X-Payload-Digest header, signed with SUMSUB_SECRET_KEY.
 * Requests that fail verification are rejected with 401 before any processing.
 *
 * Sumsub docs: https://developers.sumsub.com/api-reference/#webhook-security
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { ComplianceService } from '@/lib/domains/compliance/service';
import { sumsubWebhookPayloadSchema } from '@/lib/domains/compliance/models';

/**
 * Verifies the HMAC-SHA256 signature Sumsub attaches to every webhook.
 *
 * Sumsub computes:  HMAC-SHA256(rawBody, SUMSUB_SECRET_KEY)
 * and sends the hex digest in the X-Payload-Digest header.
 *
 * We recompute the digest from the raw body and compare with a
 * timing-safe comparison to prevent timing-based attacks.
 */
function verifyWebhookSignature(
  rawBody: string,
  receivedDigest: string | null,
  secretKey: string
): boolean {
  if (!receivedDigest) return false;

  const expectedDigest = crypto
    .createHmac('sha256', secretKey)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual requires equal-length Buffers
  try {
    const a = Buffer.from(expectedDigest, 'hex');
    const b = Buffer.from(receivedDigest, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const secretKey = process.env.SUMSUB_SECRET_KEY;

    // If the secret key is not configured, fail closed (safe default).
    if (!secretKey) {
      console.error('[Sumsub Webhook] SUMSUB_SECRET_KEY is not set. Rejecting request.');
      return NextResponse.json({ error: 'Webhook verification not configured' }, { status: 503 });
    }

    // Read the raw body text FIRST — we need the exact bytes for signature verification.
    // (Calling request.json() first would consume the stream and make rawText unavailable.)
    const rawBody = await request.text();

    // Sumsub sends the digest in the X-Payload-Digest header.
    const receivedDigest = request.headers.get('x-payload-digest');

    if (!verifyWebhookSignature(rawBody, receivedDigest, secretKey)) {
      console.warn('[Sumsub Webhook] ❌ Signature verification FAILED. Rejecting request.');
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    // Signature is valid — now safely parse the body.
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Validate payload shape
    const validationResult = sumsubWebhookPayloadSchema.safeParse(body);
    if (!validationResult.success) {
      console.error('[Sumsub Webhook] Invalid payload schema:', validationResult.error);
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    // Process the verified webhook
    await ComplianceService.handleSumsubWebhook(validationResult.data);

    console.log(`[Sumsub Webhook] ✅ Processed event for applicant: ${validationResult.data.applicantId}`);
    return NextResponse.json({ success: true });

  } catch (error: any) {
    console.error('[Sumsub Webhook] Processing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

