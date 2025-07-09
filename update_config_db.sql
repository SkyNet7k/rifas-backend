-- Script SQL para añadir columnas faltantes a la tabla 'configuracion'
-- Ejecuta este script en tu base de datos PostgreSQL.

-- Añadir columna 'pagina_bloqueada'
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS pagina_bloqueada BOOLEAN DEFAULT FALSE;

-- Añadir columna 'tasa_dolar' (tipo JSONB)
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS tasa_dolar JSONB DEFAULT '[]'::jsonb;

-- Añadir columna 'admin_whatsapp_numbers' (tipo JSONB)
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS admin_whatsapp_numbers JSONB DEFAULT '[]'::jsonb;

-- Añadir columna 'admin_email_for_reports' (tipo JSONB)
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS admin_email_for_reports JSONB DEFAULT '[]'::jsonb;

-- Añadir columnas para la configuración de correo
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_host VARCHAR(255) DEFAULT '';

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_port INTEGER DEFAULT 587;

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_secure BOOLEAN DEFAULT FALSE;

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_user VARCHAR(255) DEFAULT '';

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_pass VARCHAR(255) DEFAULT '';

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS mail_config_sender_name VARCHAR(255) DEFAULT '';

-- Añadir columnas para el estado de inicialización de números y notificaciones
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS "raffleNumbersInitialized" BOOLEAN DEFAULT FALSE;

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS "last_sales_notification_count" INTEGER DEFAULT 0;

ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS "sales_notification_threshold" INTEGER DEFAULT 20;

-- Añadir columna para el mensaje de bloqueo de página
ALTER TABLE configuracion
ADD COLUMN IF NOT EXISTS block_reason_message TEXT DEFAULT '';

-- Actualizar la fila existente con valores predeterminados para las nuevas columnas
-- Esto es importante para asegurar que la fila de configuración tenga todos los campos
-- con valores válidos después de añadir las columnas.
UPDATE configuracion
SET
    pagina_bloqueada = COALESCE(pagina_bloqueada, FALSE),
    tasa_dolar = COALESCE(tasa_dolar, '[]'::jsonb),
    admin_whatsapp_numbers = COALESCE(admin_whatsapp_numbers, '[]'::jsonb),
    admin_email_for_reports = COALESCE(admin_email_for_reports, '[]'::jsonb),
    mail_config_host = COALESCE(mail_config_host, ''),
    mail_config_port = COALESCE(mail_config_port, 587),
    mail_config_secure = COALESCE(mail_config_secure, FALSE),
    mail_config_user = COALESCE(mail_config_user, ''),
    mail_config_pass = COALESCE(mail_config_pass, ''),
    mail_config_sender_name = COALESCE(mail_config_sender_name, ''),
    "raffleNumbersInitialized" = COALESCE("raffleNumbersInitialized", FALSE),
    "last_sales_notification_count" = COALESCE("last_sales_notification_count", 0),
    "sales_notification_threshold" = COALESCE("sales_notification_threshold", 20),
    block_reason_message = COALESCE(block_reason_message, '')
WHERE id = 1; -- Asumiendo que tu fila de configuración tiene ID 1
