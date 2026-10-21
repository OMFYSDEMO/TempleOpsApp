-- Bank transaction alerts (IDFC FIRST "Your A/C ... has been credited with INR ... New balance is INR ...")
-- feed Smart Reconcile as statement lines and carry the balance the bank itself reports.
ALTER TABLE money_accounts ADD COLUMN reported_balance_paise INTEGER;
ALTER TABLE money_accounts ADD COLUMN reported_at TEXT;
