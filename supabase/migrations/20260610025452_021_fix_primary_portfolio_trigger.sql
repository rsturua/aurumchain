-- Migration: Fix Primary Portfolio Trigger
-- Ensures tokens are only added to portfolio_positions when they are MINTED

CREATE OR REPLACE FUNCTION update_portfolio_position_on_investment()
RETURNS TRIGGER AS $$
DECLARE
  position_exists BOOLEAN;
BEGIN
  -- Only process investments that have been fully MINTED on-chain
  IF TG_OP = 'INSERT' THEN
    IF NEW.minted_tx_hash IS NOT NULL THEN
      -- Check if position exists
      SELECT EXISTS(
        SELECT 1 FROM public.portfolio_positions
        WHERE user_id = NEW.user_id AND project_id = NEW.project_id
      ) INTO position_exists;

      IF position_exists THEN
        UPDATE public.portfolio_positions
        SET
          total_tokens = total_tokens + NEW.tokens_purchased,
          total_invested = total_invested + NEW.amount,
          average_token_price = (total_invested + NEW.amount) / (total_tokens + NEW.tokens_purchased),
          updated_at = NOW()
        WHERE user_id = NEW.user_id AND project_id = NEW.project_id;
      ELSE
        INSERT INTO public.portfolio_positions (
          user_id, project_id, total_tokens, total_invested, average_token_price
        ) VALUES (
          NEW.user_id, NEW.project_id, NEW.tokens_purchased, NEW.amount, NEW.token_price_at_purchase
        );
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.minted_tx_hash IS NOT NULL) AND (OLD.minted_tx_hash IS NULL) THEN
      -- Check if position exists
      SELECT EXISTS(
        SELECT 1 FROM public.portfolio_positions
        WHERE user_id = NEW.user_id AND project_id = NEW.project_id
      ) INTO position_exists;

      IF position_exists THEN
        UPDATE public.portfolio_positions
        SET
          total_tokens = total_tokens + NEW.tokens_purchased,
          total_invested = total_invested + NEW.amount,
          average_token_price = (total_invested + NEW.amount) / (total_tokens + NEW.tokens_purchased),
          updated_at = NOW()
        WHERE user_id = NEW.user_id AND project_id = NEW.project_id;
      ELSE
        INSERT INTO public.portfolio_positions (
          user_id, project_id, total_tokens, total_invested, average_token_price
        ) VALUES (
          NEW.user_id, NEW.project_id, NEW.tokens_purchased, NEW.amount, NEW.token_price_at_purchase
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
