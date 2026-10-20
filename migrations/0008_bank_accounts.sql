-- More than one bank: each bank is its own ledger with its own statement to reconcile. One bank is the
-- default where OTA payouts, gateway settlements, bank receipts and refunds land unless someone picks another.
ALTER TABLE money_accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE money_accounts ADD COLUMN account_no TEXT;   -- last digits, as the statement shows them
ALTER TABLE money_accounts ADD COLUMN note TEXT;
