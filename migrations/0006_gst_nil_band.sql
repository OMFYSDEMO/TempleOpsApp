-- GST on accommodation has three bands per room-night on the declared tariff:
-- up to ₹1,000 nil, up to ₹7,500 5% (no ITC), above 18% (with ITC). Adds the nil band.
ALTER TABLE properties ADD COLUMN gst_nil_upto_paise INTEGER NOT NULL DEFAULT 100000;
