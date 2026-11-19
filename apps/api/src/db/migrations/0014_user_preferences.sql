-- Display preferences that follow the user between devices (e.g. light / dark / system theme).
ALTER TABLE app_user ADD COLUMN ui_theme text NOT NULL DEFAULT 'system' CHECK (ui_theme IN ('light','dark','system'));
ALTER TABLE customer_user ADD COLUMN ui_theme text NOT NULL DEFAULT 'system' CHECK (ui_theme IN ('light','dark','system'));
