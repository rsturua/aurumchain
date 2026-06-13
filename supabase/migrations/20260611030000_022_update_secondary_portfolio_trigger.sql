-- Migration: Update Secondary Portfolio Trigger to Deduct Locked Tokens
-- This migration updates the secondary market trigger to accurately deduct locked_tokens
-- during a secondary trade since the webhook is no longer handling it manually.

CREATE OR REPLACE FUNCTION update_portfolio_positions_on_secondary_trade()
RETURNS TRIGGER AS $$
DECLARE
  seller_average_price DECIMAL(15, 2);
  buyer_position_exists BOOLEAN;
  v_project_id UUID;
  v_seller_id UUID;
BEGIN
  -- Retrieve project_id and seller_id from the listing
  SELECT project_id, investor_id INTO v_project_id, v_seller_id
  FROM public.secondary_listings
  WHERE id = NEW.listing_id;

  -- Fetch seller's average token price from portfolio_positions
  SELECT average_token_price INTO seller_average_price
  FROM public.portfolio_positions
  WHERE user_id = v_seller_id AND project_id = v_project_id;

  -- Fallback if no average price exists
  IF seller_average_price IS NULL THEN
    seller_average_price := NEW.paid_amount / NEW.token_amount;
  END IF;

  -- 1. Update Seller Position
  UPDATE public.portfolio_positions
  SET
    total_tokens = GREATEST(0, total_tokens - NEW.token_amount),
    locked_tokens = GREATEST(0, locked_tokens - NEW.token_amount),
    total_invested = GREATEST(0, total_invested - (NEW.token_amount * seller_average_price)),
    is_active = (total_tokens - NEW.token_amount > 0),
    closed_at = CASE WHEN total_tokens - NEW.token_amount <= 0 THEN NOW() ELSE NULL END,
    updated_at = NOW()
  WHERE user_id = v_seller_id AND project_id = v_project_id;

  -- 2. Check and Update/Insert Buyer Position
  SELECT EXISTS(
    SELECT 1 FROM public.portfolio_positions
    WHERE user_id = NEW.buyer_id AND project_id = v_project_id
  ) INTO buyer_position_exists;

  IF buyer_position_exists THEN
    UPDATE public.portfolio_positions
    SET
      total_tokens = total_tokens + NEW.token_amount,
      total_invested = total_invested + NEW.paid_amount,
      average_token_price = (total_invested + NEW.paid_amount) / (total_tokens + NEW.token_amount),
      is_active = TRUE,
      closed_at = NULL,
      updated_at = NOW()
    WHERE user_id = NEW.buyer_id AND project_id = v_project_id;
  ELSE
    INSERT INTO public.portfolio_positions (
      user_id,
      project_id,
      total_tokens,
      total_invested,
      average_token_price,
      is_active
    ) VALUES (
      NEW.buyer_id,
      v_project_id,
      NEW.token_amount,
      NEW.paid_amount,
      NEW.paid_amount / NEW.token_amount,
      TRUE
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
