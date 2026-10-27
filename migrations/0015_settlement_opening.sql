-- A payout received before a bank's opening balance was taken is already inside that balance. Closing it against
-- the opening moves the amount out of the opening and into the payout record, so the bank balance is unchanged;
-- these columns let Undo put it back.
ALTER TABLE settlements ADD COLUMN opening_adjusted_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN opening_account_id TEXT;
