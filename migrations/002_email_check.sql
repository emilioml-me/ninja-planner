-- Add email format constraint to clients.contact_email
ALTER TABLE clients
  ADD CONSTRAINT chk_clients_contact_email
  CHECK (contact_email IS NULL OR contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');
