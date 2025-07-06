// migrate_db.js
// Este script se encarga de crear las tablas y añadir columnas si no existen.

const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function runMigrations() {
    const client = await pool.connect();
    try {
        console.log('Iniciando migraciones de base de datos...');

        // 1. Crear tabla 'configuracion'
        await client.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                pagina_bloqueada BOOLEAN DEFAULT FALSE,
                fecha_sorteo VARCHAR(255),
                precio_ticket NUMERIC(10, 2),
                numero_sorteo_correlativo INTEGER,
                ultimo_numero_ticket INTEGER,
                ultima_fecha_resultados_zulia VARCHAR(255),
                tasa_dolar JSONB DEFAULT '[]'::jsonb,
                admin_whatsapp_numbers JSONB DEFAULT '[]'::jsonb,
                admin_email_for_reports JSONB DEFAULT '[]'::jsonb,
                mail_config_host TEXT DEFAULT '',
                mail_config_port INTEGER DEFAULT 587,
                mail_config_secure BOOLEAN DEFAULT FALSE,
                mail_config_user TEXT DEFAULT '',
                mail_config_pass TEXT DEFAULT '',
                mail_config_sender_name TEXT DEFAULT '',
                raffleNumbersInitialized BOOLEAN DEFAULT FALSE,
                last_sales_notification_count INTEGER DEFAULT 0,
                sales_notification_threshold INTEGER DEFAULT 20,
                block_reason_message TEXT DEFAULT ''
            );
        `);
        console.log('Tabla "configuracion" asegurada.');

        // 2. Añadir columnas a 'configuracion' si no existen (para actualizaciones)
        // Usamos ALTER TABLE IF NOT EXISTS para ser idempotentes
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS raffleNumbersInitialized BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS last_sales_notification_count INTEGER DEFAULT 0;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS sales_notification_threshold INTEGER DEFAULT 20;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS block_reason_message TEXT DEFAULT '';`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_host TEXT DEFAULT '';`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_port INTEGER DEFAULT 587;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_secure BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_user TEXT DEFAULT '';`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_pass TEXT DEFAULT '';`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS mail_config_sender_name TEXT DEFAULT '';`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS tasa_dolar JSONB DEFAULT '[]'::jsonb;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS admin_whatsapp_numbers JSONB DEFAULT '[]'::jsonb;`);
        await client.query(`ALTER TABLE configuracion ADD COLUMN IF NOT EXISTS admin_email_for_reports JSONB DEFAULT '[]'::jsonb;`);
        console.log('Columnas de "configuracion" aseguradas.');

        // 3. Crear tabla 'numeros'
        await client.query(`
            CREATE TABLE IF NOT EXISTS numeros (
                id SERIAL PRIMARY KEY,
                numero VARCHAR(3) UNIQUE NOT NULL,
                comprado BOOLEAN DEFAULT FALSE,
                originalDrawNumber INTEGER
            );
        `);
        console.log('Tabla "numeros" asegurada.');

        // 4. Crear tabla 'ventas'
        await client.query(`
            CREATE TABLE IF NOT EXISTS ventas (
                id BIGINT PRIMARY KEY,
                purchaseDate TEXT,
                drawDate TEXT,
                drawTime TEXT,
                drawNumber INTEGER,
                ticketNumber TEXT,
                buyerName TEXT,
                buyerPhone TEXT,
                numbers JSONB,
                valueUSD NUMERIC(10, 2),
                valueBs NUMERIC(10, 2),
                paymentMethod TEXT,
                paymentReference TEXT,
                voucherURL TEXT,
                validationStatus TEXT,
                voidedReason TEXT,
                voidedAt TEXT,
                closedReason TEXT,
                closedAt TEXT
            );
        `);
        console.log('Tabla "ventas" asegurada.');

        // 5. Crear tabla 'horarios_zulia'
        await client.query(`
            CREATE TABLE IF NOT EXISTS horarios_zulia (
                id SERIAL PRIMARY KEY,
                hora VARCHAR(10) UNIQUE NOT NULL
            );
        `);
        console.log('Tabla "horarios_zulia" asegurada.');

        // 6. Crear tabla 'resultados_zulia'
        await client.query(`
            CREATE TABLE IF NOT EXISTS resultados_zulia (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL,
                UNIQUE ((data->>'fecha'), (data->>'tipoLoteria'))
            );
        `);
        console.log('Tabla "resultados_zulia" asegurada.');

        // 7. Crear tabla 'premios'
        await client.query(`
            CREATE TABLE IF NOT EXISTS premios (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL,
                UNIQUE ((data->>'fechaSorteo'))
            );
        `);
        console.log('Tabla "premios" asegurada.');

        // 8. Crear tabla 'ganadores'
        await client.query(`
            CREATE TABLE IF NOT EXISTS ganadores (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL,
                UNIQUE ((data->>'drawDate'), (data->>'drawNumber'), (data->>'lotteryType'))
            );
        `);
        console.log('Tabla "ganadores" asegurada.');

        // 9. Crear tabla 'comprobantes'
        await client.query(`
            CREATE TABLE IF NOT EXISTS comprobantes (
                id BIGINT PRIMARY KEY,
                ventaId BIGINT,
                comprador TEXT,
                telefono TEXT,
                comprobante_nombre TEXT,
                comprobante_tipo TEXT,
                fecha_compra TEXT,
                url_comprobante TEXT
            );
        `);
        console.log('Tabla "comprobantes" asegurada.');

        console.log('Todas las migraciones de base de datos completadas exitosamente.');

    } catch (err) {
        console.error('Error durante la migración de la base de datos:', err);
        process.exit(1); // Salir con error si la migración falla
    } finally {
        client.release();
        await pool.end(); // Cerrar el pool de conexiones después de las migraciones
    }
}

runMigrations();
