-- Campaign tagging: a lead remembers which campaign and ad brought it (UTM on the website form, campaign
-- and ad names from Meta lead ads, or typed by sales); a marketing expense carries the campaign it paid for.
-- The marketing scorecard joins the two: spend against leads, bookings and revenue, by source and by campaign.
ALTER TABLE leads ADD COLUMN campaign TEXT;
ALTER TABLE leads ADD COLUMN utm_source TEXT;
ALTER TABLE leads ADD COLUMN utm_medium TEXT;
ALTER TABLE leads ADD COLUMN ad_name TEXT;
ALTER TABLE expenses ADD COLUMN campaign TEXT;
