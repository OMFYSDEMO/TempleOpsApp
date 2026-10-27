-- GST the OTA charges on its commission (18% for Indian OTAs). It comes off the payout with the commission and is
-- booked with it as an input-GST expense, so the expected payout matches the OTA statement.
ALTER TABLE channels ADD COLUMN commission_gst_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN commission_gst_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_items ADD COLUMN commission_gst_paise INTEGER NOT NULL DEFAULT 0;
