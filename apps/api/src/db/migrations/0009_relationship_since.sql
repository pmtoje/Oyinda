-- Banking relationship start date from the core banking system (drives tenure-based eligibility rules)
ALTER TABLE customer ADD COLUMN bank_relationship_since date;
