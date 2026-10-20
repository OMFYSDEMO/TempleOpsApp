-- Pilot property seed: Meadows Varkala. Re-runnable (INSERT OR IGNORE).
INSERT OR IGNORE INTO properties (id, name, legal_name, address, gstin, state_code, invoice_prefix, auto_approve_on_tariff, auto_approve_max_rooms)
VALUES ('prop_meadows', 'Meadows Varkala', 'Meadows Varkala', 'Varkala, Kerala', NULL, '32', 'MV', 1, 4);

INSERT OR IGNORE INTO users (id, property_id, email, name, role) VALUES
 ('usr_shaji',  'prop_meadows', 'shajianandan@gmail.com', 'Shaji', 'owner'),
 ('usr_prachi', 'prop_meadows', 'bookings@meadowsvarkala.com', 'Prachi', 'sales'),
 ('usr_sindhu', 'prop_meadows', 'meadowsvarkala@gmail.com', 'Sindhu', 'property'),
 ('usr_trupti', 'prop_meadows', 'trupti@truvic.co.in', 'Trupti', 'revenue'),
 ('usr_ca',     'prop_meadows', 'shubham.kandalkar@gmail.com', 'Shubham Kandalkar', 'accountant');

INSERT OR IGNORE INTO locations (id, property_id, kind, code, name, sort) VALUES
 ('loc_r1', 'prop_meadows', 'room', 'R1', 'Deluxe', 1),
 ('loc_r2', 'prop_meadows', 'room', 'R2', 'Premium', 2),
 ('loc_r3', 'prop_meadows', 'room', 'R3', 'Superior', 3),
 ('loc_r4', 'prop_meadows', 'room', 'R4', 'Executive', 4),
 ('loc_livg', 'prop_meadows', 'area', 'LIV-G', 'Living Room (Ground)', 10),
 ('loc_liv1', 'prop_meadows', 'area', 'LIV-1', 'Living Room (First Floor)', 11),
 ('loc_din', 'prop_meadows', 'area', 'DINING', 'Dining Room', 12),
 ('loc_toilet', 'prop_meadows', 'area', 'TOILET', 'Common Toilet', 13),
 ('loc_garden', 'prop_meadows', 'area', 'GARDEN', 'Garden Area', 14);

-- Tariff card (ex-GST per night). Peak window priced at ₹7,500 — the GST threshold is inclusive, so still 5%.
INSERT OR IGNORE INTO rate_cards (id, property_id, room_id, name, rate_paise, from_date, to_date, priority) VALUES
 ('rc_r1_std', 'prop_meadows', 'loc_r1', 'Standard', 600000, NULL, NULL, 0),
 ('rc_r2_std', 'prop_meadows', 'loc_r2', 'Standard', 650000, NULL, NULL, 0),
 ('rc_r3_std', 'prop_meadows', 'loc_r3', 'Standard', 550000, NULL, NULL, 0),
 ('rc_r4_std', 'prop_meadows', 'loc_r4', 'Standard', 700000, NULL, NULL, 0),
 ('rc_r1_peak', 'prop_meadows', 'loc_r1', 'Peak', 700000, '2026-12-20', '2027-01-05', 10),
 ('rc_r2_peak', 'prop_meadows', 'loc_r2', 'Peak', 750000, '2026-12-20', '2027-01-05', 10),
 ('rc_r3_peak', 'prop_meadows', 'loc_r3', 'Peak', 650000, '2026-12-20', '2027-01-05', 10),
 ('rc_r4_peak', 'prop_meadows', 'loc_r4', 'Peak', 750000, '2026-12-20', '2027-01-05', 10);

-- Channels: every payout rate lives here. TCS/TDS bp are 0 until the OTA statement shows deductions (set them from the owner admin).
INSERT OR IGNORE INTO channels (id, property_id, code, name, collection_type, commission_bp, commission_base, payment_fee_bp, payment_fee_base, tcs_bp, tds_bp) VALUES
 ('ch_direct',   'prop_meadows', 'direct',      'Direct',      'direct',          0,    'ex_gst', 0,   'gross', 0, 0),
 ('ch_swiftbook','prop_meadows', 'swiftbook',   'SwiftBook',   'direct',          0,    'ex_gst', 0,   'gross', 0, 0),
 ('ch_bcom',     'prop_meadows', 'booking_com', 'Booking.com', 'channel_collect', 2300, 'ex_gst', 199, 'gross', 0, 0),
 ('ch_bcom_hc',  'prop_meadows', 'booking_com_hotel_collect', 'Booking.com (pay at property)', 'hotel_collect', 1500, 'ex_gst', 0, 'gross', 0, 0),
 ('ch_agoda',    'prop_meadows', 'agoda',       'Agoda',       'channel_collect', 2000, 'ex_gst', 0,   'gross', 0, 0),
 ('ch_mmt',      'prop_meadows', 'makemytrip',  'MakeMyTrip',  'channel_collect', 2200, 'ex_gst', 0,   'gross', 0, 0),
 ('ch_goibibo',  'prop_meadows', 'goibibo',     'Goibibo',     'channel_collect', 2083, 'ex_gst', 0,   'gross', 0, 0);

-- Money accounts: the cash ledger. Bank is the owner's; cash and petty cash are the property manager's.
INSERT OR IGNORE INTO money_accounts (id, property_id, kind, name, holder_role, opening_paise, opening_date) VALUES
 ('acc_bank',  'prop_meadows', 'bank',       'Bank (current a/c)', 'owner',    0,      '2026-09-01'),
 ('acc_cash',  'prop_meadows', 'cash',       'Cash in hand',       'property', 0,      '2026-09-01'),
 ('acc_petty', 'prop_meadows', 'petty_cash', 'Petty cash',         'property', 0,      '2026-09-01'),
 ('acc_gw',    'prop_meadows', 'gateway',    'Airpay clearing',    'owner',    0,      '2026-09-01');
