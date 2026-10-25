-- A booking-engine / OTA reference belongs to one LIVE stay. A cancelled or no-show booking no longer holds
-- it, so the stay can be re-entered (or the reference moved to the booking the guest actually stayed under).
-- Re-forwarded emails are still caught as duplicates by the inbox, which checks every booking whatever its status.
DROP INDEX IF EXISTS bookings_external;
CREATE UNIQUE INDEX bookings_external ON bookings(property_id, channel_id, external_ref)
  WHERE external_ref IS NOT NULL AND status NOT IN ('cancelled', 'no_show');
