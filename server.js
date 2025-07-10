// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid'); // Para generar IDs únicos
const crypto = require('crypto'); // Para generar IDs únicos si es necesario
const { Pool } = require('pg'); // Importar la librería pg para PostgreSQL
const fs = require('fs').promises; // Necesario para operaciones de archivos locales (uploads, reports)

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware para parsear JSON y archivos
app.use(express.json());
app.use(fileUpload());

// Configuración del pool de conexiones a la base de datos PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Importante para conexiones SSL en Render
    }
});

// Constantes y configuraciones
const CARACAS_TIMEZONE = 'America/Caracas';
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// Rutas a tus directorios locales (para uploads y reports, no para JSONs)
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // Para comprobantes
const REPORTS_DIR = path.join(__dirname, 'reports'); // Para reportes Excel
const COMPROBANTES_DIR = path.join(UPLOADS_DIR, 'comprobantes'); // Asegurarse de que esta ruta esté definida

const SALES_THRESHOLD_PERCENTAGE = 80;
const DRAW_SUSPENSION_HOUR = 12;
const DRAW_SUSPENSION_MINUTE = 15;
const TOTAL_RAFFLE_NUMBERS = 1000;

// --- Funciones Auxiliares para Operaciones con la Base de Datos ---

/**
 * Obtiene la configuración de la base de datos.
 * @returns {Promise<object>} El objeto de configuración.
 */
async function getConfiguracionFromDB() {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT * FROM configuracion LIMIT 1');
        if (res.rows.length > 0) {
            const config = res.rows[0];
            // El driver pg automáticamente parsear JSONB, pero esta verificación es robusta
            // en caso de que los datos se hayan insertado como strings antes de la migración.
            if (typeof config.tasa_dolar === 'string') config.tasa_dolar = JSON.parse(config.tasa_dolar);
            if (typeof config.admin_whatsapp_numbers === 'string') config.admin_whatsapp_numbers = JSON.parse(config.admin_whatsapp_numbers);
            if (typeof config.admin_email_for_reports === 'string') config.admin_email_for_reports = JSON.parse(config.admin_email_for_reports);
            return config;
        }
        return {}; // Retorna un objeto vacío si no hay configuración
    } finally {
        client.release();
    }
}

/**
 * Actualiza la configuración en la base de datos.
 * @param {object} configData - Los datos de configuración a actualizar.
 */
async function updateConfiguracionInDB(configData) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE configuracion SET
                pagina_bloqueada = $1, fecha_sorteo = $2, precio_ticket = $3,
                numero_sorteo_correlativo = $4, ultimo_numero_ticket = $5,
                ultima_fecha_resultados_zulia = $6, tasa_dolar = $7,
                admin_whatsapp_numbers = $8, admin_email_for_reports = $9,
                mail_config_host = $10, mail_config_port = $11, mail_config_secure = $12,
                mail_config_user = $13, mail_config_pass = $14, mail_config_sender_name = $15,
                raffleNumbersInitialized = $16, last_sales_notification_count = $17,
                sales_notification_threshold = $18, block_reason_message = $19
            WHERE id = $20
        `;
        const values = [
            configData.pagina_bloqueada, configData.fecha_sorteo, configData.precio_ticket,
            configData.numero_sorteo_correlativo, configData.ultimo_numero_ticket,
            configData.ultima_fecha_resultados_zulia,
            // Convertir arrays/objetos a strings JSON válidos para columnas JSONB
            JSON.stringify(configData.tasa_dolar),
            JSON.stringify(configData.admin_whatsapp_numbers),
            JSON.stringify(configData.admin_email_for_reports),
            configData.mail_config_host, configData.mail_config_port, configData.mail_config_secure,
            configData.mail_config_user, configData.mail_config_pass, configData.mail_config_sender_name,
            configData.raffleNumbersInitialized, configData.last_sales_notification_count,
            configData.sales_notification_threshold, configData.block_reason_message,
            configData.id // Asumiendo que el ID de la configuración es 1 o el ID existente
        ];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

/**
 * Obtiene los números de rifa desde la base de datos.
 * @returns {Promise<Array>} Array de objetos de números.
 */
async function getNumerosFromDB() {
    const client = await pool.connect();
    try {
        // Log the query before execution
        console.log('DEBUG_DB: Ejecutando SELECT en tabla numeros: SELECT numero, comprado, "originalDrawNumber" FROM numeros ORDER BY numero::INTEGER');
        // FIX: Changed 'originaldrawnumber' to '"originalDrawNumber"' to match case-sensitive column name
        const res = await client.query('SELECT numero, comprado, "originalDrawNumber" FROM numeros ORDER BY numero::INTEGER');
        console.log(`DEBUG_DB: Consulta SELECT en numeros exitosa. Filas encontradas: ${res.rows.length}`);
        return res.rows;
    } catch (dbError) { // Catch the specific DB error
        console.error('ERROR_DB_GET_NUMEROS: Fallo al ejecutar la consulta SELECT en la tabla numeros. Mensaje:', dbError.message);
        console.error('ERROR_DB_GET_NUMEROS: Código SQL:', dbError.code); // PostgreSQL error code
        console.error('ERROR_DB_GET_NUMEROS: Detalle:', dbError.detail); // More specific detail
        console.error('ERROR_DB_GET_NUMEROS: Stack trace:', dbError.stack);
        throw new Error('Error al cargar números desde la base de datos: ' + dbError.message); // Re-throw with original message
    } finally {
        client.release();
    }
}

/**
 * Actualiza un número de rifa en la base de datos.
 * @param {string} numero - El número a actualizar.
 * @param {boolean} comprado - Estado de comprado.
 * @param {number|null} originalDrawNumber - Número de sorteo original.
 */
async function updateNumeroInDB(numero, comprado, originalDrawNumber) {
    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE numeros SET comprado = $1, "originalDrawNumber" = $2 WHERE numero = $3', // Added quotes for consistency
            [comprado, originalDrawNumber, numero]
        );
    } finally {
        client.release();
    }
}

/**
 * Inserta o actualiza múltiples números de rifa en una transacción.
 * @param {Array<Object>} numerosArray - Array de objetos de números { numero, comprado, originalDrawNumber }.
 */
async function upsertNumerosInDB(numerosArray) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Iniciar transacción
        for (const item of numerosArray) {
            await client.query(
                `INSERT INTO numeros (numero, comprado, "originalDrawNumber")
                 VALUES ($1, $2, $3)
                 ON CONFLICT (numero) DO UPDATE SET
                    comprado = EXCLUDED.comprado,
                    "originalDrawNumber" = EXCLUDED."originalDrawNumber"`, // Added quotes for consistency
                [item.numero, item.comprado, item.originalDrawNumber]
            );
        }
        await client.query('COMMIT'); // Confirmar transacción
    } catch (e) {
        await client.query('ROLLBACK'); // Revertir en caso de error
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Obtiene las ventas desde la base de datos.
 * @returns {Promise<Array>} Array de objetos de ventas.
 */
async function getVentasFromDB() {
    const client = await pool.connect();
    try {
        // INICIO DE MODIFICACIÓN: Incluir campos de vendedor en la consulta
        const res = await client.query('SELECT *, "sellerId", "sellerName", "sellerAgency" FROM ventas');
        // FIN DE MODIFICACIÓN: Incluir campos de vendedor en la consulta
        // Asegurarse de que el campo 'numbers' (JSONB) sea un array de JS
        return res.rows.map(row => ({
            ...row,
            numbers: typeof row.numbers === 'string' ? JSON.parse(row.numbers) : row.numbers
        }));
    } finally {
        client.release();
    }
}

/**
 * Inserta una nueva venta en la base de datos.
 * @param {object} ventaData - Los datos de la venta a insertar.
 */
async function insertVentaInDB(ventaData) {
    const client = await pool.connect();
    try {
        // INICIO DE MODIFICACIÓN: Añadir campos de vendedor a la inserción
        const query = `
            INSERT INTO ventas (
                id, "purchaseDate", "drawDate", "drawTime", "drawNumber", "ticketNumber",
                "buyerName", "buyerPhone", numbers, "valueUSD", "valueBs", "paymentMethod",
                "paymentReference", "voucherURL", "validationStatus", "sellerId", "sellerName", "sellerAgency"
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `;
        const values = [
            ventaData.id, ventaData.purchaseDate, ventaData.drawDate, ventaData.drawTime, ventaData.drawNumber, ventaData.ticketNumber,
            ventaData.buyerName, ventaData.buyerPhone, JSON.stringify(ventaData.numbers), ventaData.valueUSD, ventaData.valueBs, ventaData.paymentMethod,
            ventaData.paymentReference, ventaData.voucherURL, ventaData.validationStatus,
            ventaData.sellerId, ventaData.sellerName, ventaData.sellerAgency // NUEVOS CAMPOS
        ];
        // FIN DE MODIFICACIÓN: Añadir campos de vendedor a la inserción
        await client.query(query, values);
    } finally {
        client.release();
    }
}

/**
 * Actualiza el estado de validación de una venta en la base de datos.
 * @param {number} ventaId - ID de la venta.
 * @param {string} validationStatus - Nuevo estado de validación.
 * @param {string|null} voidedReason - Razón de anulación (si aplica).
 * @param {string|null} voidedAt - Timestamp de anulación (si aplica).
 * @param {string|null} closedReason - Razón de cierre (si aplica).
 * @param {string|null} closedAt - Timestamp de cierre (si aplica).
 * @returns {Promise<object|null>} La venta actualizada o null si no se encontró.
 */
async function updateVentaStatusInDB(ventaId, validationStatus, voidedReason = null, voidedAt = null, closedReason = null, closedAt = null) {
    const client = await pool.connect();
    try {
        const query = `
            UPDATE ventas SET
                "validationStatus" = $1,
                "voidedReason" = $2,
                "voidedAt" = $3,
                "closedReason" = $4,
                "closedAt" = $5
            WHERE id = $6
            RETURNING *;
        `;
        const res = await client.query(query, [validationStatus, voidedReason, voidedAt, closedReason, closedAt, ventaId]);
        return res.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Actualiza la URL del comprobante en una venta específica.
 * @param {number} ventaId - ID de la venta.
 * @param {string} voucherURL - La nueva URL del comprobante.
 */
async function updateVentaVoucherURLInDB(ventaId, voucherURL) {
    const client = await pool.connect();
    try {
        await client.query('UPDATE ventas SET "voucherURL" = $1 WHERE id = $2', [voucherURL, ventaId]);
    } finally {
        client.release();
    }
}

/**
 * Inserta un nuevo comprobante en la base de datos.
 * @param {object} comprobanteData - Los datos del comprobante a insertar.
 */
async function insertComprobanteInDB(comprobanteData) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO comprobantes (
                id, "ventaId", comprador, telefono, comprobante_nombre, comprobante_tipo, fecha_compra, url_comprobante
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `;
        const values = [
            comprobanteData.id, comprobanteData.ventaId, comprobanteData.comprador, comprobanteData.telefono,
            comprobanteData.comprobante_nombre, comprobanteData.comprobante_tipo, comprobanteData.fecha_compra,
            comprobanteData.url_comprobante
        ];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

/**
 * Obtiene los horarios de Zulia desde la base de datos.
 * @returns {Promise<object>} Objeto con horarios de zulia y chance.
 */
async function getHorariosZuliaFromDB() {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT hora FROM horarios_zulia');
        // Asumiendo que solo hay una columna 'hora' y que los tipos 'zulia' y 'chance' se manejan en el frontend
        // o si hay una columna 'tipo' en la DB, se debería filtrar por ella.
        // Por la estructura original, asumimos que 'horarios_zulia' solo almacena las horas de Zulia.
        return { zulia: res.rows.map(row => row.hora), chance: [] }; // Adaptar al formato esperado por el frontend
    } finally {
        client.release();
    }
}

/**
 * Actualiza los horarios de Zulia en la base de datos.
 * @param {string} tipo - Tipo de lotería ('zulia' o 'chance').
 * @param {Array<string>} horarios - Array de strings de horarios.
 */
async function updateHorariosInDB(tipo, horarios) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Si la tabla horarios_zulia solo tiene 'hora', asumimos que 'tipo' no se almacena en la DB.
        // Si 'tipo' fuera una columna, la lógica sería diferente.
        // Para este caso, truncamos y reinsertamos si es 'zulia'.
        if (tipo === 'zulia') {
            await client.query('TRUNCATE TABLE horarios_zulia RESTART IDENTITY;');
            for (const hora of horarios) {
                await client.query('INSERT INTO horarios_zulia (hora) VALUES ($1)', [hora]);
            }
        }
        // Si tuvieras una tabla 'horarios_chance' o una columna 'tipo' en 'horarios_zulia',
        // la lógica para 'chance' iría aquí.
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK'); // Revertir en caso de error
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Obtiene los resultados de Zulia desde la base de datos.
 * @param {string} fecha - Fecha de los resultados.
 * @param {string} tipoLoteria - Tipo de lotería.
 * @returns {Promise<Array>} Array de objetos de resultados.
 */
async function getResultadosZuliaFromDB(fecha, tipoLoteria) {
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT data FROM resultados_zulia WHERE (data->>\'fecha\')::text = $1 AND (data->>\'tipoLoteria\')::text = $2',
            [fecha, tipoLoteria]
        );
        return res.rows.map(row => row.data); // 'data' es JSONB, así que ya viene parseado por el driver
    } finally {
        client.release();
    }
}

/**
 * Inserta o actualiza resultados de sorteo en la base de datos.
 * @param {object} resultData - Los datos del resultado a insertar/actualizar.
 */
async function upsertResultadosZuliaInDB(resultData) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO resultados_zulia (data)
            VALUES ($1)
            ON CONFLICT ((data->>'fecha'), (data->>'tipoLoteria')) DO UPDATE SET
                data = EXCLUDED.data;
        `;
        const values = [JSON.stringify(resultData)]; // Stringify the whole object for JSONB
        await client.query(query, values);
    } finally {
        client.release();
    }
}

/**
 * Obtiene los premios desde la base de datos para una fecha específica.
 * @param {string} fecha - Fecha de los premios.
 * @returns {Promise<object>} Objeto con los premios para la fecha.
 */
async function getPremiosFromDB(fecha) {
    const client = await pool.connect();
    try {
        // Asumiendo que la tabla 'premios' almacena un objeto JSONB completo por fecha
        const res = await client.query('SELECT data FROM premios WHERE (data->>\'fechaSorteo\')::text = $1 LIMIT 1', [fecha]);
        if (res.rows.length > 0) {
            return res.rows[0].data; // 'data' es JSONB, ya viene parseado
        }
        return null;
    } finally {
        client.release();
    }
}

/**
 * Inserta o actualiza premios en la base de datos.
 * @param {object} premiosData - Los datos de los premios a insertar/actualizar.
 */
async function upsertPremiosInDB(premiosData) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO premios (data)
            VALUES ($1)
            ON CONFLICT ((data->>'fechaSorteo')) DO UPDATE SET
                data = EXCLUDED.data;
        `;
        // Asumiendo que premiosData tiene una propiedad 'fechaSorteo' para el ON CONFLICT
        const values = [JSON.stringify(premiosData)]; // Stringify the whole object for JSONB
        await client.query(query, values);
    } finally {
        client.release();
    }
}

/**
 * Obtiene los ganadores desde la base de datos.
 * @param {string} fecha - Fecha del sorteo.
 * @param {number} numeroSorteo - Número de sorteo.
 * @param {string} tipoLoteria - Tipo de lotería.
 * @returns {Promise<Array>} Array de objetos de ganadores.
 */
async function getGanadoresFromDB(fecha, numeroSorteo, tipoLoteria) {
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT data FROM ganadores WHERE (data->>\'drawDate\')::text = $1 AND (data->>\'drawNumber\')::int = $2 AND (data->>\'lotteryType\')::text = $3 LIMIT 1',
            [fecha, numeroSorteo, tipoLoteria]
        );
        if (res.rows.length > 0 && res.rows[0].data && res.rows[0].data.winners) {
            return res.rows[0].data.winners;
        }
        return [];
    } finally {
        client.release();
    }
}

/**
 * Inserta o actualiza ganadores en la base de datos.
 * @param {object} ganadoresEntry - La entrada de ganadores a insertar/actualizar.
 */
async function upsertGanadoresInDB(ganadoresEntry) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO ganadores (data)
            VALUES ($1)
            ON CONFLICT ((data->>'drawDate'), (data->>'drawNumber'), (data->>'lotteryType')) DO UPDATE SET
                data = EXCLUDED.data;
        `;
        const values = [JSON.stringify(ganadoresEntry)]; // Stringify the whole object for JSONB
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// INICIO DE NUEVA LÓGICA: FUNCIONES AUXILIARES PARA VENDEDORES
/**
 * Obtiene un vendedor por su ID desde la base de datos.
 * @param {string} sellerId - ID del vendedor.
 * @returns {Promise<object|null>} El objeto vendedor o null si no se encuentra.
 */
async function getSellerByIdFromDB(sellerId) {
    const client = await pool.connect();
    try {
        // Incluir las nuevas columnas de comisión en la selección
        const res = await client.query('SELECT seller_id, full_name, id_card, agency_name, commission_percentage, commission_draw_date, commission_value_usd, commission_value_bs FROM sellers WHERE seller_id = $1', [sellerId]);
        return res.rows[0] || null;
    } finally {
        client.release();
    }
}

/**
 * Inserta o actualiza un vendedor en la base de datos.
 * @param {object} sellerData - Los datos del vendedor a insertar/actualizar.
 * @returns {Promise<object>} El objeto vendedor insertado/actualizado.
 */
async function upsertSellerInDB(sellerData) {
    const client = await pool.connect();
    try {
        const query = `
            INSERT INTO sellers (seller_id, full_name, id_card, agency_name, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT (seller_id) DO UPDATE SET
                full_name = EXCLUDED.full_name,
                id_card = EXCLUDED.id_card,
                agency_name = EXCLUDED.agency_name,
                updated_at = NOW()
            RETURNING *;
        `;
        const res = await client.query(query, [sellerData.seller_id, sellerData.full_name, sellerData.id_card, sellerData.agency_name]);
        return res.rows[0];
    } finally {
        client.release();
    }
}

/**
 * Obtiene todos los vendedores desde la base de datos.
 * @returns {Promise<Array>} Array de objetos de vendedores.
 */
async function getAllSellersFromDB() {
    const client = await pool.connect();
    try {
        // Incluir las nuevas columnas de comisión en la selección
        const res = await client.query('SELECT seller_id, full_name, id_card, agency_name, commission_percentage, commission_draw_date, commission_value_usd, commission_value_bs FROM sellers ORDER BY created_at DESC');
        return res.rows;
    } finally {
        client.release();
    }
}

/**
 * Elimina un vendedor de la base de datos.
 * @param {string} sellerId - ID del vendedor a eliminar.
 * @returns {Promise<object|null>} El objeto vendedor eliminado o null si no se encontró.
 */
async function deleteSellerFromDB(sellerId) {
    const client = await pool.connect();
    try {
        const res = await client.query('DELETE FROM sellers WHERE seller_id = $1 RETURNING *', [sellerId]);
        return res.rows[0] || null;
    } finally {
        client.release();
    }
}
// FIN DE NUEVA LÓGICA: FUNCIONES AUXILIARES PARA VENDEDORES


// Función para asegurar que las tablas existan
async function ensureTablesExist() {
    const client = await pool.connect();
    try {
        // Tabla de configuración (configuracion)
        await client.query(`
            CREATE TABLE IF NOT EXISTS configuracion (
                id SERIAL PRIMARY KEY,
                pagina_bloqueada BOOLEAN DEFAULT FALSE,
                fecha_sorteo DATE DEFAULT CURRENT_DATE,
                precio_ticket NUMERIC(10, 2) DEFAULT 0.50,
                numero_sorteo_correlativo INTEGER DEFAULT 1,
                ultimo_numero_ticket INTEGER DEFAULT 0,
                ultima_fecha_resultados_zulia DATE,
                tasa_dolar JSONB DEFAULT '[36.50]'::jsonb,
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
        console.log('DB: Tabla "configuracion" verificada/creada.');

        // Tabla de números (numeros)
        await client.query(`
            CREATE TABLE IF NOT EXISTS numeros (
                id SERIAL PRIMARY KEY,
                numero VARCHAR(3) UNIQUE NOT NULL,
                comprado BOOLEAN DEFAULT FALSE,
                "originalDrawNumber" INTEGER -- Usar comillas para camelCase
            );
        `);
        console.log('DB: Tabla "numeros" verificada/creada.');

        // Tabla de ventas (ventas)
        await client.query(`
            CREATE TABLE IF NOT EXISTS ventas (
                id BIGINT PRIMARY KEY,
                "purchaseDate" TIMESTAMP WITH TIME ZONE NOT NULL,
                "drawDate" DATE NOT NULL,
                "drawTime" VARCHAR(50) NOT NULL,
                "drawNumber" INTEGER NOT NULL,
                "ticketNumber" VARCHAR(255) UNIQUE NOT NULL,
                "buyerName" VARCHAR(255) NOT NULL,
                "buyerPhone" VARCHAR(255) NOT NULL,
                numbers JSONB NOT NULL,
                "valueUSD" NUMERIC(10, 2) NOT NULL,
                "valueBs" NUMERIC(10, 2) NOT NULL,
                "paymentMethod" VARCHAR(255) NOT NULL,
                "paymentReference" VARCHAR(255),
                "voucherURL" TEXT,
                "validationStatus" VARCHAR(50) DEFAULT 'Pendiente',
                "voidedReason" TEXT,
                "voidedAt" TIMESTAMP WITH TIME ZONE,
                "closedReason" TEXT,
                "closedAt" TIMESTAMP WITH TIME ZONE,
                -- INICIO DE NUEVA LÓGICA: CAMPOS PARA EL VENDEDOR
                "sellerId" VARCHAR(255),
                "sellerName" VARCHAR(255),
                "sellerAgency" VARCHAR(255)
                -- FIN DE NUEVA LÓGICA: CAMPOS PARA EL VENDEDOR
            );
        `);
        console.log('DB: Tabla "ventas" verificada/creada.');

        // AÑADIDO: ALTER TABLE para añadir las columnas de vendedor si no existen
        await client.query(`
            ALTER TABLE ventas
            ADD COLUMN IF NOT EXISTS "sellerId" VARCHAR(255),
            ADD COLUMN IF NOT EXISTS "sellerName" VARCHAR(255),
            ADD COLUMN IF NOT EXISTS "sellerAgency" VARCHAR(255);
        `);
        console.log('DB: Columnas de vendedor en tabla "ventas" verificadas/añadidas.');


        // Tabla de comprobantes (comprobantes)
        await client.query(`
            CREATE TABLE IF NOT EXISTS comprobantes (
                id BIGINT PRIMARY KEY,
                "ventaId" BIGINT REFERENCES ventas(id),
                comprador VARCHAR(255),
                telefono VARCHAR(255),
                comprobante_nombre VARCHAR(255),
                comprobante_tipo VARCHAR(100),
                fecha_compra DATE,
                url_comprobante TEXT
            );
        `);
        console.log('DB: Tabla "comprobantes" verificada/creada.');

        // Tabla de horarios_zulia (horarios_zulia)
        await client.query(`
            CREATE TABLE IF NOT EXISTS horarios_zulia (
                id SERIAL PRIMARY KEY,
                hora VARCHAR(50) NOT NULL UNIQUE
            );
        `);
        console.log('DB: Tabla "horarios_zulia" verificada/creada.');

        // Tabla de resultados_zulia (resultados_zulia)
        await client.query(`
            CREATE TABLE IF NOT EXISTS resultados_zulia (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL
                -- REMOVIDO: UNIQUE ((data->>'fecha'), (data->>'tipoLoteria'))
            );
        `);
        // NUEVO: Crear índice UNIQUE sobre la expresión para 'resultados_zulia' por separado
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS unique_resultados_zulia_fecha_tipoloteria
            ON resultados_zulia ((data->>'fecha'), (data->>'tipoLoteria'));
        `).catch(e => console.warn(`Advertencia: El índice unique_resultados_zulia_fecha_tipoloteria ya existe o hubo un error al añadirlo: ${e.message}`));
        console.log('DB: Tabla "resultados_zulia" verificada/creada (y su índice).');


        // Tabla de premios (premios)
        await client.query(`
            CREATE TABLE IF NOT EXISTS premios (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL
                -- REMOVIDO: UNIQUE ((data->>'fechaSorteo'))
            );
        `);
        // NUEVO: Crear índice UNIQUE sobre la expresión para 'premios' por separado
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS unique_premios_fechasorteo
            ON premios ((data->>'fechaSorteo'));
        `).catch(e => console.warn(`Advertencia: El índice unique_premios_fechasorteo ya existe o hubo un error al añadirlo: ${e.message}`));
        console.log('DB: Tabla "premios" verificada/creada (y su índice).');

        // Tabla de ganadores (ganadores)
        await client.query(`
            CREATE TABLE IF NOT EXISTS ganadores (
                id SERIAL PRIMARY KEY,
                data JSONB NOT NULL
                -- REMOVIDO: UNIQUE ((data->>'drawDate'), (data->>'drawNumber'), (data->>'lotteryType'))
            );
        `);
        // NUEVO: Crear índice UNIQUE sobre la expresión para 'ganadores' por separado
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS unique_ganadores_drawdata
            ON ganadores ((data->>'drawDate'), (data->>'drawNumber'), (data->>'lotteryType'));
        `).catch(e => console.warn(`Advertencia: El índice unique_ganadores_drawdata ya existe o hubo un error al añadirlo: ${e.message}`));
        console.log('DB: Tabla "ganadores" verificada/creada (y su índice).');

        // INICIO DE NUEVA LÓGICA: CREACIÓN DE LA TABLA 'sellers'
        await client.query(`
            CREATE TABLE IF NOT EXISTS sellers (
                seller_id VARCHAR(255) PRIMARY KEY,
                full_name VARCHAR(255) NOT NULL,
                id_card VARCHAR(255) NOT NULL,
                agency_name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('DB: Tabla "sellers" verificada/creada.');

        // NUEVO: Añadir columnas de comisión a la tabla 'sellers' si no existen
        const commissionColumns = [
            { name: 'commission_percentage', type: 'NUMERIC(5,2)', default: '0.00' },
            { name: 'commission_draw_date', type: 'VARCHAR(10)', default: "''" },
            { name: 'commission_value_usd', type: 'NUMERIC(10,2)', default: '0.00' },
            { name: 'commission_value_bs', type: 'NUMERIC(10,2)', default: '0.00' }
        ];

        for (const col of commissionColumns) {
            const checkColumn = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'sellers' AND column_name = '${col.name}';
            `);
            if (checkColumn.rows.length === 0) {
                await client.query(`ALTER TABLE sellers ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.default};`);
                console.log(`DEBUG: Columna "${col.name}" añadida a la tabla "sellers".`);
            }
        }
        // FIN DE NUEVA LÓGICA: CREACIÓN DE LA TABLA 'sellers'

    } catch (error) {
        console.error('ERROR_DB_INIT: Error al asegurar que las tablas existan:', error.message);
        throw error; // Re-lanzar para detener la inicialización si la DB no está lista
    } finally {
        client.release();
    }
}


// Función para asegurar que los directorios existan (solo para archivos locales como comprobantes y reportes)
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.mkdir(REPORTS_DIR, { recursive: true });
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true }); // Asegurarse de crear el subdirectorio
        console.log('Directorios locales asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios locales:', error);
    }
}

// Carga inicial de datos desde la base de datos o inicialización con valores por defecto
async function loadInitialData() {
    console.log('DEBUG_INIT: Iniciando carga inicial de datos desde la base de datos...');
    let client;
    try {
        client = await pool.connect();

        // --- Cargar/Inicializar Configuración ---
        let configuracion = await getConfiguracionFromDB();
        let configId = null; // To store the ID of the config row


        if (Object.keys(configuracion).length === 0) {
            console.warn('DEBUG_INIT: No se encontró configuración en la DB. Insertando valores por defecto.');
            const default_config = {
                pagina_bloqueada: false,
                fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
                precio_ticket: 3.00,
                numero_sorteo_correlativo: 1,
                ultimo_numero_ticket: 0,
                ultima_fecha_resultados_zulia: null,
                tasa_dolar: [36.50],
                admin_whatsapp_numbers: [],
                mail_config_host: "", mail_config_port: 587, mail_config_secure: false,
                mail_config_user: "", mail_config_pass: "", mail_config_sender_name: "",
                admin_email_for_reports: [],
                raffleNumbersInitialized: false,
                last_sales_notification_count: 0,
                sales_notification_threshold: 20,
                block_reason_message: ""
            };
            const insertQuery = `
                INSERT INTO configuracion (
                    pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo,
                    ultimo_numero_ticket, ultima_fecha_resultados_zulia, tasa_dolar,
                    admin_whatsapp_numbers, admin_email_for_reports,
                    mail_config_host, mail_config_port, mail_config_secure,
                    mail_config_user, mail_config_pass, mail_config_sender_name,
                    raffleNumbersInitialized, last_sales_notification_count, sales_notification_threshold, block_reason_message
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id;
            `;
            const insertValues = [
                default_config.pagina_bloqueada, default_config.fecha_sorteo, default_config.precio_ticket,
                default_config.numero_sorteo_correlativo, default_config.ultimo_numero_ticket,
                default_config.ultima_fecha_resultados_zulia,
                JSON.stringify(default_config.tasa_dolar),
                JSON.stringify(default_config.admin_whatsapp_numbers),
                JSON.stringify(default_config.admin_email_for_reports),
                default_config.mail_config_host, default_config.mail_config_port, default_config.mail_config_secure,
                default_config.mail_config_user, default_config.mail_config_pass, default_config.mail_config_sender_name,
                default_config.raffleNumbersInitialized, default_config.last_sales_notification_count,
                default_config.sales_notification_threshold, default_config.block_reason_message
            ];
            const res = await client.query(insertQuery, insertValues);
            configuracion = { id: res.rows[0].id, ...default_config };
            configId = res.rows[0].id;
            console.log('DEBUG_INIT: Configuración por defecto insertada en la DB.');
        } else {
            configId = configuracion.id; // Get existing ID
            console.log('DEBUG_INIT: Configuración existente encontrada en la DB. Verificando propiedades...');
            // Ensure all expected properties exist, setting defaults if missing
            configuracion.raffleNumbersInitialized = configuracion.raffleNumbersInitialized !== undefined ? configuracion.raffleNumbersInitialized : false;
            configuracion.last_sales_notification_count = configuracion.last_sales_notification_count !== undefined ? configuracion.last_sales_notification_count : 0;
            configuracion.sales_notification_threshold = configuracion.sales_notification_threshold !== undefined ? configuracion.sales_notification_threshold : 20;
            configuracion.block_reason_message = configuracion.block_reason_message !== undefined ? configuracion.block_reason_message : "";
            configuracion.mail_config_host = configuracion.mail_config_host !== undefined ? configuracion.mail_config_host : "";
            configuracion.mail_config_port = configuracion.mail_config_port !== undefined ? configuracion.mail_config_port : 587;
            configuracion.mail_config_secure = configuracion.mail_config_secure !== undefined ? configuracion.mail_config_secure : false;
            configuracion.mail_config_user = configuracion.mail_config_user !== undefined ? configuracion.mail_config_user : "";
            configuracion.mail_config_pass = configuracion.mail_config_pass !== undefined ? configuracion.mail_config_pass : "";
            configuracion.mail_config_sender_name = configuracion.mail_config_sender_name !== undefined ? configuracion.mail_config_sender_name : "";
            // Also ensure JSONB fields are arrays if they somehow became null or undefined
            configuracion.tasa_dolar = Array.isArray(configuracion.tasa_dolar) ? configuracion.tasa_dolar : [36.50];
            configuracion.admin_whatsapp_numbers = Array.isArray(configuracion.admin_whatsapp_numbers) ? configuracion.admin_whatsapp_numbers : [];
            configuracion.admin_email_for_reports = Array.isArray(configuracion.admin_email_for_reports) ? configuracion.admin_email_for_reports : [];
            console.log('DEBUG_INIT: Configuración después de asegurar propiedades:', JSON.stringify(configuracion, null, 2));
        }

        // --- Inicializar Números de Rifa si no están (o si hay menos de 1000) ---
        let numerosCountRes = await client.query('SELECT COUNT(*) FROM numeros');
        const currentNumbersCount = parseInt(numerosCountRes.rows[0].count, 10);
        console.log(`DEBUG_LOAD_INITIAL: currentNumbersCount en la tabla numeros: ${currentNumbersCount}`);


        if (currentNumbersCount < TOTAL_RAFFLE_NUMBERS) {
            console.warn(`DEBUG_LOAD_INITIAL: Se encontraron ${currentNumbersCount} números. Inicializando/completando hasta ${TOTAL_RAFFLE_NUMBERS}.`);
            const existingNumbers = (await client.query('SELECT numero FROM numeros')).rows.map(row => row.numero);
            console.log(`DEBUG_LOAD_INITIAL: Números existentes antes de upsert: ${existingNumbers.length}`);
            const initialNumbersToInsert = [];
            for (let i = 0; i < TOTAL_RAFFLE_NUMBERS; i++) {
                const numStr = i.toString().padStart(3, '0');
                if (!existingNumbers.includes(numStr)) {
                    initialNumbersToInsert.push({ numero: numStr, comprado: false, originalDrawNumber: null });
                }
            }
            if (initialNumbersToInsert.length > 0) {
                console.log(`DEBUG_LOAD_INITIAL: Preparando para insertar/actualizar ${initialNumbersToInsert.length} números.`);
                await upsertNumerosInDB(initialNumbersToInsert);
                console.log(`DEBUG_LOAD_INITIAL: Insertados/actualizados ${initialNumbersToInsert.length} números iniciales.`);
            } else {
                console.log('DEBUG_LOAD_INITIAL: No se necesitan insertar números adicionales. La tabla ya tiene todos los números esperados.');
            }
            if (!configuracion.raffleNumbersInitialized) { // Check again after potential initial insert
                configuracion.raffleNumbersInitialized = true;
                // Use the configId to update the specific row
                await updateConfiguracionInDB({ ...configuracion, id: configId });
                console.log('DEBUG_LOAD_INITIAL: raffleNumbersInitialized actualizado a true en configuración.');
            }
        } else if (!configuracion.raffleNumbersInitialized) {
            configuracion.raffleNumbersInitialized = true;
            // Use the configId to update the specific row
            await updateConfiguracionInDB({ ...configuracion, id: configId });
            console.log('DEBUG_LOAD_INITIAL: raffleNumbersInitialized actualizado a true en configuración (ya tenía 1000 números).');
        } else {
            console.log('DEBUG_LOAD_INITIAL: La tabla numeros ya tiene 1000 números y raffleNumbersInitialized es true.');
        }

        console.log('DEBUG_INIT: Datos iniciales cargados o asegurados en la base de datos.');
    } catch (err) {
        console.error('ERROR_CRITICO_INIT: Error CRÍTICO al cargar o inicializar datos en la base de datos:', err);
        process.exit(1);
    } finally {
        if (client) {
            client.release();
        }
    }
}


// Configuración de Nodemailer
let transporter;
async function configureMailer() {
    const configuracion = await getConfiguracionFromDB(); // Obtener la configuración más reciente
    const emailUser = process.env.EMAIL_USER || configuracion.mail_config_user;
    const emailPass = process.env.EMAIL_PASS || configuracion.mail_config_pass;

    if (configuracion.mail_config_host && emailUser && emailPass) {
        transporter = nodemailer.createTransport({
            host: configuracion.mail_config_host,
            port: configuracion.mail_config_port,
            secure: configuracion.mail_config_secure,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });
        console.log('DEBUG_MAILER: Nodemailer configurado.');
    } else {
        console.warn(`DEBUG_MAILER: Configuración de correo incompleta. El envío de correos no funcionará. Host: '${configuracion.mail_config_host}', User: '${emailUser ? 'OK' : 'VACÍO'}', Pass: '${emailPass ? 'OK' : 'VACÍO'}'`);
        transporter = null;
    }
}

/**
 * Envía un correo electrónico utilizando el transporter configurado.
 * Ahora 'to' puede ser una cadena de texto (un solo correo) o un array de cadenas (múltiples correos).
 * @param {string|string[]} to - Dirección(es) de correo del destinatario(s).
 * @param {string} subject - Asunto del correo.
 * @param {string} html - Contenido HTML del correo.
 * @param {Array} attachments - Array de adjuntos para el correo (opcional).
 * @returns {Promise<boolean>} True si el correo se envió con éxito, false en caso contrario.
 */
async function sendEmail(to, subject, html, attachments = []) {
    if (!transporter) {
        console.error('ERROR_MAILER: Transporter no configurado. No se pudo enviar el correo.');
        return false;
    }
    const configuracion = await getConfiguracionFromDB(); // Obtener la configuración más reciente
    try {
        const recipients = Array.isArray(to) ? to.join(',') : to;
        const mailOptions = {
            from: `${configuracion.mail_config_sender_name || 'Sistema de Rifas'} <${configuracion.mail_config_user}>`,
            to: recipients,
            subject,
            html,
            attachments
        };
        console.log(`DEBUG_MAILER: Intentando enviar correo a: ${recipients}, Asunto: ${subject}`);
        await transporter.sendMail(mailOptions);
        console.log('DEBUG_MAILER: Correo enviado exitosamente.');
        return true;
    }  catch (error) {
        console.error(`ERROR_MAILER: Fallo al enviar correo a ${to}, Asunto: ${subject}. Mensaje:`, error.message);
        return false;
    }
}

/**
 * Envía una notificación de resumen de ventas o mensajes personalizados por WhatsApp a los números de administrador configurados.
 * Esto genera una URL de wa.me y la imprime en consola, ya que el envío directo de WhatsApp requiere integración con una API externa.
 * @param {string} messageText - El texto del mensaje a enviar.
 */
async function sendWhatsappNotification(messageText) {
    try {
        const encodedMessage = encodeURIComponent(messageText);
        const configuracion = await getConfiguracionFromDB(); // Obtener la configuración más reciente

        if (configuracion.admin_whatsapp_numbers && configuracion.admin_whatsapp_numbers.length > 0) {
            console.log(`\n--- Notificación de WhatsApp para Administradores ---`);
            configuracion.admin_whatsapp_numbers.forEach(adminNumber => {
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminNumber}&text=${encodedMessage}`;
                console.log(`[WhatsApp Link for ${adminNumber}]: ${whatsappUrl}`);
            });
            console.log('--- Fin Notificación de WhatsApp ---\n');
            console.log('NOTA: Los enlaces de WhatsApp se han generado y mostrado en la consola. Para el envío automático real, se requiere una integración con un proveedor de WhatsApp API (ej. Twilio, Vonage, WhatsApp Business API).');
        } else {
            console.warn('DEBUG_WHATSAPP: No hay números de WhatsApp de administrador configurados para enviar notificaciones.');
        }

    } catch (error) {
        console.error('ERROR_WHATSAPP: Error al enviar notificación por WhatsApp:', error.message);
    }
}

// Función auxiliar para enviar notificación de resumen de ventas (WhatsApp y Email)
async function sendSalesSummaryNotifications() {
    console.log('[sendSalesSummaryNotifications] Iniciando notificación de resumen de ventas.');
    let configuracion = await getConfiguracionFromDB(); // Obtener la configuración más reciente
    let ventas = await getVentasFromDB(); // Obtener las ventas más recientes

    const now = moment().tz(CARACAS_TIMEZONE);

    const ventasParaFechaSorteo = ventas.filter(venta =>
        venta.drawDate === configuracion.fecha_sorteo &&
        (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
    );

    const totalVentas = ventasParaFechaSorteo.length;
    const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
    const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

    const whatsappMessageText = `*Actualización de Ventas Lotería:*\n\n` +
                                `Fecha Sorteo: *${configuracion.fecha_sorteo}*\n` +
                                `Sorteo Nro: *${configuracion.numero_sorteo_correlativo}*\n` +
                                `Total de Ventas Actuales (Confirmadas/Pendientes): *${totalVentas}* tickets vendidos.\n\n` +
                                `Porcentaje de Ventas: *${soldPercentage.toFixed(2)}%*\n\n` +
                                `Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}`;
    await sendWhatsappNotification(whatsappMessageText);

    try {
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            console.log('[sendSalesSummaryNotifications] Generando reporte Excel para correo...');
            const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
                ventasParaFechaSorteo,
                configuracion,
                'Reporte de Ventas Periódico',
                'Reporte_Ventas_Periodico'
            );
            console.log(`[sendSalesSummaryNotifications] Reporte Excel generado: ${excelFileName}. Intentando enviar correo.`);

            const emailSubject = `Reporte de Ventas Periódico - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Se ha generado un reporte de ventas periódico para el sorteo del día <strong>${configuracion.fecha_sorteo}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${ventasParaFechaSorteo.reduce((sum, venta) => sum + (parseFloat(venta.valueUSD) || 0), 0).toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${ventasParaFechaSorteo.reduce((sum, venta) => sum + (parseFloat(venta.valueBs) || 0), 0).toFixed(2)}</p>
                <p><b>Porcentaje de Tickets Vendidos:</b> ${soldPercentage.toFixed(2)}%</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
                <p>Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('ERROR_SALES_SUMMARY: Fallo al enviar el correo de reporte de ventas periódico.');
            } else {
                console.log('DEBUG_SALES_SUMMARY: Correo de reporte de ventas periódico enviado con éxito.');
            }
        } else {
            console.warn('DEBUG_SALES_SUMMARY: No hay correos de administrador configurados para enviar el reporte de ventas periódico.');
        }
    } catch (emailError) {
        console.error('ERROR_SALES_SUMMARY: Error al generar o enviar el reporte de ventas periódico por correo:', emailError.message);
    }
}


// ===============================================
// === ENDPOINTS DE LA API =======================
// ===============================================

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Servidor de la API de Loterías activo. Accede a las rutas /api/ para interactuar.' });
});

// Configuración de CORS explícita y exclusiva para múltiples orígenes
const allowedOrigins = ['https://paneladmin01.netlify.app', 'https://tuoportunidadeshoy.netlify.app', 'https://seller01.netlify.app']; // Añadido el dominio del panel del vendedor

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Handle preflight requests (OPTIONS) - sometimes explicit handling is needed
app.options('*', cors()); // Enable pre-flight across all routes


// Obtener configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        const configuracion = await getConfiguracionFromDB();
        const configToSend = { ...configuracion };
        delete configToSend.mail_config_pass; // No enviar credenciales sensibles
        res.json(configToSend);
    } catch (error) {
        console.error('Error al obtener configuración:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Actualizar configuración (Cambiado de POST a PUT)
app.put('/api/configuracion', async (req, res) => {
    const newConfig = req.body;
    try {
        let currentConfig = await getConfiguracionFromDB();

        // Actualizar solo los campos que vienen en newConfig y que existen en currentConfig
        // Excluir campos de mail_config si se manejan por separado o no se deben actualizar directamente aquí
        Object.keys(newConfig).forEach(key => {
            // Mapear campos de mail_config si vienen anidados
            if (key === 'mail_config' && typeof newConfig.mail_config === 'object') {
                currentConfig.mail_config_host = newConfig.mail_config.host;
                currentConfig.mail_config_port = newConfig.mail_config.port;
                currentConfig.mail_config_secure = newConfig.mail_config.secure;
                currentConfig.mail_config_user = newConfig.mail_config.user;
                currentConfig.mail_config_pass = newConfig.mail_config.pass;
                currentConfig.mail_config_sender_name = newConfig.mail_config.senderName;
            } else if (currentConfig.hasOwnProperty(key)) {
                currentConfig[key] = newConfig[key];
            }
        });

        // Asegurar que los arrays JSONB se manejen correctamente
        if (newConfig.admin_email_for_reports !== undefined) {
            currentConfig.admin_email_for_reports = Array.isArray(newConfig.admin_email_for_reports)
                                                      ? newConfig.admin_email_for_reports
                                                      : [newConfig.admin_email_for_reports].filter(Boolean);
        }
        if (newConfig.admin_whatsapp_numbers !== undefined) {
            currentConfig.admin_whatsapp_numbers = Array.isArray(newConfig.admin_whatsapp_numbers)
                                                    ? newConfig.admin_whatsapp_numbers
                                                    : [newConfig.admin_whatsapp_numbers].filter(Boolean);
        }
        if (newConfig.last_sales_notification_count !== undefined) {
            currentConfig.last_sales_notification_count = parseInt(newConfig.last_sales_notification_count, 10);
        }
        if (newConfig.sales_notification_threshold !== undefined) {
            currentConfig.sales_notification_threshold = parseInt(newConfig.sales_notification_threshold, 10);
        }
        if (newConfig.block_reason_message !== undefined) {
            currentConfig.block_reason_message = newConfig.block_reason_message;
        }

        await updateConfiguracionInDB(currentConfig);

        res.json({ message: 'Configuración actualizada con éxito', configuracion: currentConfig });
    } catch (error) {
        console.error('Error al actualizar configuración:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Obtener estado de los números
app.get('/api/numeros', async (req, res) => {
    try {
        const numeros = await getNumerosFromDB();
        console.log('DEBUG_BACKEND: Recibida solicitud GET /api/numeros. Enviando estado actual de numeros desde DB.');
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números desde DB (API endpoint):', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.', error: error.message });
    }
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    const updatedNumbers = req.body; // Array de objetos de números
    try {
        await upsertNumerosInDB(updatedNumbers); // Usar upsert para actualizar o insertar
        console.log('DEBUG_BACKEND: Números actualizados en DB.');
        res.json({ message: 'Números actualizados con éxito.' });
    }
    catch (error) {
        console.error('Error al actualizar números en DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas
app.get('/api/ventas', async (req, res) => {
    try {
        const ventas = await getVentasFromDB();
        console.log('Enviando ventas al frontend desde DB:', ventas.length, 'ventas.');
        res.status(200).json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas desde DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.', error: error.message });
    }
});


// Manejar solicitudes GET inesperadas a /api/compra
app.get('/api/compra', (req, res) => {
    res.status(404).json({
        message: 'Esta ruta no soporta solicitudes GET. Para realizar una una compra, utiliza el método POST en /api/comprar.',
        hint: 'Si estás intentando obtener información de ventas, usa la ruta GET /api/ventas.'
    });
});


// Ruta para la compra de tickets
app.post('/api/comprar', async (req, res) => {
    console.log('DEBUG_BACKEND: Recibida solicitud POST /api/comprar.');
    const {
        numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago,
        comprador, telefono, horaSorteo,
        // INICIO DE NUEVA LÓGICA: CAMPOS DEL VENDEDOR EN LA COMPRA
        sellerId, sellerName, sellerAgency
        // FIN DE NUEVA LÓGICA: CAMPOS DEL VENDEDOR EN LA COMPRA
    } = req.body;

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !horaSorteo) {
        console.error('DEBUG_BACKEND: Faltan datos requeridos para la compra.');
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra (números, valor, método de pago, comprador, teléfono, hora del sorteo).' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Iniciar transacción

        let configuracion = await getConfiguracionFromDB();
        let numeros = await getNumerosFromDB();
        let ventas = await getVentasFromDB();

        if (configuracion.pagina_bloqueada) {
            console.warn('DEBUG_BACKEND: Página bloqueada, denegando compra.');
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
        }

        const conflictos = numerosSeleccionados.filter(n =>
            numeros.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            console.warn(`DEBUG_BACKEND: Conflicto de números: ${conflictos.join(', ')} ya comprados.`);
            await client.query('ROLLBACK');
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        for (const numSel of numerosSeleccionados) {
            const numObjInDB = numeros.find(n => n.numero === numSel);
            if (numObjInDB) {
                await client.query(
                    'UPDATE numeros SET comprado = TRUE, "originalDrawNumber" = $1 WHERE numero = $2', // Added quotes for consistency
                    [configuracion.numero_sorteo_correlativo, numSel]
                );
            } else {
                // Esto no debería pasar si los números se inicializan correctamente
                await client.query(
                    'INSERT INTO numeros (numero, comprado, "originalDrawNumber") VALUES ($1, TRUE, $2)', // Added quotes for consistency
                    [numSel, configuracion.numero_sorteo_correlativo]
                );
            }
        }
        console.log('DEBUG_BACKEND: Números actualizados en DB.');

        const now = moment().tz("America/Caracas");
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = configuracion.ultimo_numero_ticket.toString().padStart(5, '0');

        const nuevaVenta = {
            id: Date.now(), // Usar timestamp como ID único
            purchaseDate: now.toISOString(),
            drawDate: configuracion.fecha_sorteo,
            drawTime: horaSorteo,
            drawNumber: configuracion.numero_sorteo_correlativo,
            ticketNumber: numeroTicket,
            buyerName: comprador,
            buyerPhone: telefono,
            numbers: numerosSeleccionados,
            valueUSD: parseFloat(valorUsd),
            valueBs: parseFloat(valorBs),
            paymentMethod: metodoPago,
            paymentReference: referenciaPago,
            voucherURL: null,
            validationStatus: 'Pendiente',
            // INICIO DE NUEVA LÓGICA: CAMPOS DEL VENDEDOR EN LA NUEVA VENTA
            sellerId: sellerId,
            sellerName: sellerName,
            sellerAgency: sellerAgency
            // FIN DE NUEVA LÓGICA: CAMPOS DEL VENDEDOR EN LA NUEVA VENTA
        };

        await insertVentaInDB(nuevaVenta);
        console.log('DEBUG_BACKEND: Venta guardada en DB.');

        await updateConfiguracionInDB({
            ...configuracion,
            ultimo_numero_ticket: configuracion.ultimo_numero_ticket
        });
        console.log('DEBUG_BACKEND: Configuración (ultimo_numero_ticket) actualizada en DB.');

        await client.query('COMMIT'); // Confirmar transacción

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });
        console.log('DEBUG_BACKEND: Respuesta de compra enviada al frontend.');

        const whatsappMessageIndividual = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;
        await sendWhatsappNotification(whatsappMessageIndividual);
        console.log('DEBUG_BACKEND: Proceso de compra en backend finalizado.');

        // Lógica de notificación por umbral de ventas
        configuracion = await getConfiguracionFromDB(); // Recargar la más reciente
        ventas = await getVentasFromDB(); // Recargar la más reciente

        const currentTotalSales = ventas.filter(sale =>
            sale.drawDate === configuracion.fecha_sorteo &&
            (sale.validationStatus === 'Confirmado' || sale.validationStatus === 'Pendiente')
        ).length;

        const prevNotifiedCount = configuracion.last_sales_notification_count || 0;
        const notificationThreshold = configuracion.sales_notification_threshold || 20;

        const currentMultiple = Math.floor(currentTotalSales / notificationThreshold);
        const prevMultiple = Math.floor(prevNotifiedCount / notificationThreshold);

        if (currentMultiple > prevMultiple) {
            console.log(`[WhatsApp Notificación Resumen] Ventas actuales (${currentTotalSales}) han cruzado un nuevo múltiplo (${currentMultiple * notificationThreshold}) del umbral (${notificationThreshold}). Enviando notificación de resumen.`);
            await sendSalesSummaryNotifications();

            configuracion.last_sales_notification_count = currentMultiple * notificationThreshold;
            await updateConfiguracionInDB(configuracion);
            console.log(`[WhatsApp Notificación Resumen] Contador 'last_sales_notification_count' actualizado a ${currentMultiple * notificationThreshold} en DB.`);
        } else {
            console.log(`[WhatsApp Notificación Resumen Check] Ventas actuales (${currentTotalSales}) no han cruzado un nuevo múltiplo del umbral (${notificationThreshold}). Último contador notificado: ${prevNotifiedCount}. No se envió notificación de resumen.`);
        }

    } catch (error) {
        if (client) await client.query('ROLLBACK'); // Revertir en caso de error
        console.error('ERROR_BACKEND: Error al procesar la compra:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// Subir comprobante de pago
app.post('/api/upload-comprobante/:ventaId', async (req, res) => {
    const ventaId = parseInt(req.params.ventaId);
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(comprobanteFile.mimetype)) {
        return res.status(400).json({ message: 'Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, GIF) y PDF.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Iniciar transacción

        const ventasRes = await client.query('SELECT * FROM ventas WHERE id = $1', [ventaId]);
        if (ventasRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        let ventaData = ventasRes.rows[0];
        // Asegurarse de que ventaData.numbers sea un array para el email
        ventaData.numbers = typeof ventaData.numbers === 'string' ? JSON.parse(ventaData.numbers) : ventaData.numbers;


        const now = moment().tz("America/Caracas");
        const timestamp = now.format('YYYYMMDD_HHmmss');
        const originalExtension = path.extname(comprobanteFile.name);
        const fileName = `comprobante_${ventaId}_${timestamp}${originalExtension}`;
        const filePath = path.join(COMPROBANTES_DIR, fileName); // Usar COMPROBANTES_DIR

        await comprobanteFile.mv(filePath);

        // Actualizar la URL del comprobante en la venta
        await updateVentaVoucherURLInDB(ventaId, `/uploads/comprobantes/${fileName}`); // Ajustar URL para el subdirectorio
        console.log(`Voucher URL actualizado en DB para venta ${ventaId}.`);

        // Registrar en comprobantes (metadata)
        await insertComprobanteInDB({
            id: Date.now(), // Nuevo ID para el registro de comprobante
            ventaId: ventaId,
            comprador: ventaData.buyerName,
            telefono: ventaData.buyerPhone,
            comprobante_nombre: fileName,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_compra: moment(ventaData.purchaseDate).format('YYYY-MM-DD'),
            url_comprobante: `/uploads/comprobantes/${fileName}` // Ajustar URL para el subdirectorio
        });
        console.log(`Comprobante registrado en DB.`);

        await client.query('COMMIT'); // Confirmar transacción

        const configuracion = await getConfiguracionFromDB(); // Obtener la configuración más reciente
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Nuevo Comprobante de Pago para Venta #${ventaData.ticketNumber}`;
            const htmlContent = `
                <p>Se ha subido un nuevo comprobante de pago para la venta con Ticket Nro. <strong>${ventaData.ticketNumber}</strong>.</p>
                <p><b>Comprador:</b> ${ventaData.buyerName}</p>
                <p><b>Teléfono:</b> ${ventaData.buyerPhone}</p>
                <p><b>Números:</b> ${ventaData.numbers.join(', ')}</p>
                <p><b>Monto USD:</b> $${(parseFloat(ventaData.valueUSD) || 0).toFixed(2)}</p>
                <p><b>Monto Bs:</b> Bs ${(parseFloat(ventaData.valueBs) || 0).toFixed(2)}</p>
                <p><b>Método de Pago:</b> ${ventaData.paymentMethod}</p>
                <p><b>Referencia:</b> ${ventaData.paymentReference}</p>
                <p>Haz clic <a href="${API_BASE_URL}/uploads/comprobantes/${fileName}" target="_blank">aquí</a> para ver el comprobante.</p>
                <p>También puedes verlo en el panel de administración.</p>
            `;
            const attachments = [
                {
                    filename: fileName,
                    path: filePath,
                    contentType: comprobanteFile.mimetype
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo con el comprobante.');
            }
        }

        res.status(200).json({ message: 'Comprobante subido y asociado con éxito.', url: `/uploads/comprobantes/${fileName}` });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('Error al subir el comprobante:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// Servir archivos subidos estáticamente
app.use('/uploads', express.static(UPLOADS_DIR));


// Endpoint para obtener horarios de Zulia (y Chance)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        const horariosZulia = await getHorariosZuliaFromDB();
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia de DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});

// Endpoint para actualizar horarios de Zulia (y Chance)
app.post('/api/horarios', async (req, res) => {
    const { tipo, horarios } = req.body;
    if (!tipo || (tipo !== 'zulia' && tipo !== 'chance')) {
        return res.status(400).json({ message: 'Tipo de lotería inválido. Debe ser "zulia" o "chance".' });
    }
    if (!Array.isArray(horarios) || !horarios.every(h => typeof h === 'string')) {
        return res.status(400).json({ message: 'Formato de horarios inválido. Espera un array de strings.' });
    }
    try {
        await updateHorariosInDB(tipo, horarios); // Asumiendo que esta función maneja la lógica de la DB
        const updatedHorarios = await getHorariosZuliaFromDB(); // Obtener los horarios actualizados para la respuesta
        console.log(`Horarios de ${tipo} actualizados en DB.`);

        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: updatedHorarios[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo} en DB:`, error.message);
        res.status(500).json({ message: `Error interno del servidor al actualizar horarios de ${tipo}.` });
    }
});

// Endpoint para obtener los resultados de Zulia por fecha
app.get('/api/resultados-zulia', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha) {
        return res.status(400).json({ message: 'Se requiere el parámetro "fecha" para consultar resultados de Zulia.' });
    }

    try {
        const resultsForDateAndZulia = await getResultadosZuliaFromDB(fecha, 'zulia');
        res.status(200).json(resultsForDateAndZulia);
    }
    catch (error) {
        console.error('Error al obtener resultados de Zulia desde DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de Zulia.', error: error.message });
    }
});


// Endpoint para obtener los últimos resultados del sorteo
app.get('/api/resultados-sorteo', async (req, res) => {
    const client = await pool.connect();
    try {
        // Obtener todos los resultados de Zulia para este endpoint
        const resDB = await client.query('SELECT data FROM resultados_zulia');
        const resultadosZulia = resDB.rows.map(row => row.data); // 'data' es JSONB, ya viene parseado
        console.log('Enviando resultados de sorteo al frontend desde DB:', resultadosZulia.length, 'resultados.');
        res.status(200).json(resultadosZulia);
    } catch (error) {
        console.error('Error al obtener resultados de sorteo desde DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de sorteo.', error: error.message });
    } finally {
        client.release();
    }
});

// Endpoint para guardar/actualizar los resultados del sorteo
app.post('/api/resultados-sorteo', async (req, res) => {
    const { fecha, tipoLoteria, resultadosPorHora } = req.body;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid() || !tipoLoteria || !Array.isArray(resultadosPorHora)) {
        return res.status(400).json({ message: 'Faltan datos requeridos (fecha, tipoLoteria, resultadosPorHora) o el formato es inválido.' });
    }

    const now = moment().tz("America/Caracas");
    const currentDay = now.format('YYYY-MM-DD');

    try {
        const dataToSave = {
            fecha,
            tipoLoteria,
            resultados: resultadosPorHora,
            ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
        };

        await upsertResultadosZuliaInDB(dataToSave);
        console.log('Resultados de sorteo guardados/actualizados en DB.');

        if (fecha === currentDay && tipoLoteria === 'zulia') {
            let configuracion = await getConfiguracionFromDB();
            configuracion.ultima_fecha_resultados_zulia = fecha;
            await updateConfiguracionInDB(configuracion);
            console.log('Configuración (ultima_fecha_resultados_zulia) actualizada en DB.');
        }

        res.status(200).json({ message: 'Resultados de sorteo guardados/actualizados con éxito.' });
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de sorteo en DB:', error.message);
        console.error('Detalle del error:', error.stack);
        res.status(500).json({ message: 'Error interno del servidor al guardar/actualizar resultados de sorteo.', error: error.message });
    }
});

/**
 * Genera un reporte de ventas en formato Excel y lo guarda en el directorio de reportes.
 * @param {Array} salesData - Array de objetos de ventas a incluir en el reporte.
 * @param {Object} config - Objeto de configuración actual (o relevante para el contexto del reporte).
 * @param {string} reportTitle - Título principal del reporte (ej., "Corte de Ventas", "Reporte de Suspensión").
 * @param {string} fileNamePrefix - Prefijo para el nombre del archivo (ej., "Corte_Ventas", "Reporte_Suspension").
 * @returns {Promise<{excelFilePath: string, excelFileName: string}>} Objeto con la ruta y el nombre del archivo Excel generado.
 */
async function generateGenericSalesExcelReport(salesData, config, reportTitle, fileNamePrefix) {
    console.log(`[DEBUG_EXCEL] Iniciando generateGenericSalesExcelReport para: ${reportTitle}`);
    // console.log(`[DEBUG_EXCEL] salesData recibida (${salesData.length} items):`, JSON.stringify(salesData.slice(0, 5), null, 2), `... (total: ${salesData.length} items)`); // Limitar log

    const now = moment().tz(CARACAS_TIMEZONE);
    const todayFormatted = now.format('YYYY-MM-DD');

    // FIX: Asegurarse de que valueUSD y valueBs sean números antes de sumar
    const totalVentasUSD = salesData.reduce((sum, venta) => sum + (parseFloat(venta.valueUSD) || 0), 0);
    const totalVentasBs = salesData.reduce((sum, venta) => sum + (parseFloat(venta.valueBs) || 0), 0);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(reportTitle);

    worksheet.columns = [
        { header: 'Campo', key: 'field', width: 25 },
        { header: 'Valor', key: 'value', width: 40 }
    ];

    worksheet.addRow({ field: 'Título del Reporte', value: reportTitle });
    worksheet.addRow({ field: 'Fecha y Hora del Reporte', value: now.format('YYYY-MM-DD HH:mm:ss') });
    worksheet.addRow({ field: 'Fecha de Sorteo Reportado', value: config.fecha_sorteo || 'N/A' });
    worksheet.addRow({ field: 'Número de Sorteo Reportado', value: String(config.numero_sorteo_correlativo || 'N/A') });
    worksheet.addRow({ field: 'Total de Tickets Vendidos', value: String(salesData.length || 0) });
    worksheet.addRow({ field: 'Total Vendido USD', value: totalVentasUSD.toFixed(2) });
    worksheet.addRow({ field: 'Total Vendido Bs', value: totalVentasBs.toFixed(2) });

    worksheet.addRow({});
    worksheet.addRow({ field: 'Detalle de Ventas' });
    worksheet.addRow({});

    const ventasHeaders = [
        { header: 'ID Interno Venta', key: 'id', width: 20 },
        { header: 'Fecha/Hora Compra', key: 'purchaseDate', width: 25 },
        { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
        { header: 'Hora Sorteo', key: 'drawTime', width: 15 },
        { header: 'Nro. Sorteo', key: 'drawNumber', width: 15 },
        { header: 'Nro. Ticket', key: 'ticketNumber', width: 15 },
        { header: 'Comprador', key: 'buyerName', width: 25 },
        { header: 'Teléfono', key: 'buyerPhone', width: 20 },
        { header: 'Números', key: 'numbers', width: 30 },
        { header: 'Valor USD', key: 'valueUSD', width: 15 },
        { header: 'Valor Bs', key: 'valueBs', width: 15 },
        { header: 'Método de Pago', key: 'paymentMethod', width: 20 },
        { header: 'Referencia Pago', key: 'paymentReference', width: 20 },
        { header: 'URL Comprobante', key: 'voucherURL', width: 35 },
        { header: 'Estado Validación', key: 'validationStatus', width: 25 },
        { header: 'Razón Anulación', key: 'voidedReason', width: 30 },
        { header: 'Fecha Anulación', key: 'voidedAt', width: 25 },
        { header: 'Razón Cierre', key: 'closedReason', width: 30 },
        { header: 'Fecha Cierre', key: 'closedAt', width: 25 },
        // INICIO DE NUEVA LÓGICA: COLUMNAS DE VENDEDOR EN EL REPORTE
        { header: 'ID Vendedor', key: 'sellerId', width: 20 },
        { header: 'Nombre Vendedor', key: 'sellerName', width: 30 },
        { header: 'Agencia Vendedor', key: 'sellerAgency', width: 30 }
        // FIN DE NUEVA LÓGICA: COLUMNAS DE VENDEDOR EN EL REPORTE
    ];
    worksheet.addRow(ventasHeaders.map(h => h.header));

    salesData.forEach((venta, index) => {
        worksheet.addRow({
            id: venta.id,
            purchaseDate: venta.purchaseDate ? moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            drawDate: venta.drawDate || '',
            drawTime: venta.drawTime || 'N/A',
            drawNumber: venta.drawNumber || '',
            ticketNumber: venta.ticketNumber || '',
            buyerName: venta.buyerName || '',
            buyerPhone: venta.buyerPhone || '',
            // 'numbers' ya debería ser un array debido a getVentasFromDB
            numbers: (Array.isArray(venta.numbers) ? venta.numbers.join(', ') : ''),
            valueUSD: (parseFloat(venta.valueUSD) || 0), // Ensure it's a number for Excel
            valueBs: (parseFloat(venta.valueBs) || 0),   // Ensure it's a number for Excel
            paymentMethod: venta.paymentMethod || '',
            paymentReference: venta.paymentReference || '',
            voucherURL: venta.voucherURL ? `${API_BASE_URL}${venta.voucherURL}` : '',
            validationStatus: venta.validationStatus || 'Pendiente',
            voidedReason: venta.voidedReason || '',
            voidedAt: venta.voidedAt ? moment(venta.voidedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            closedReason: venta.closedReason || '',
            closedAt: venta.closedAt ? moment(venta.closedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            // INICIO DE NUEVA LÓGICA: DATOS DE VENDEDOR PARA EL REPORTE
            sellerId: venta.sellerId || '',
            sellerName: venta.sellerName || '',
            sellerAgency: venta.sellerAgency || ''
            // FIN DE NUEVA LÓGICA: DATOS DE VENDEDOR PARA EL REPORTE
        });
    });

    const excelFileName = `${fileNamePrefix}_${todayFormatted}_${now.format('HHmmss')}.xlsx`;
    const excelFilePath = path.join(REPORTS_DIR, excelFileName);
    await workbook.xlsx.writeFile(excelFilePath);

    console.log(`[DEBUG_EXCEL] Excel generado en: ${excelFilePath}`);
    return { excelFilePath, excelFileName };
}

/**
 * Genera un buffer ZIP que contiene archivos Excel para cada tabla de la base de datos especificada.
 * @returns {Promise<Buffer>} Un buffer que representa el archivo ZIP.
 */
async function generateDatabaseBackupZipBuffer() {
    console.log('[DEBUG_BACKUP] Iniciando generación de backup ZIP de la base de datos.');
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const output = new (require('stream').PassThrough)();
    archive.pipe(output);

    const client = await pool.connect();
    try {
        // Se han añadido comillas dobles a todos los nombres de columna en camelCase para asegurar la coincidencia exacta con PostgreSQL.
        const tablesToExport = [
            { name: 'configuracion', columns: ['id', 'pagina_bloqueada', 'fecha_sorteo', 'precio_ticket', 'numero_sorteo_correlativo', 'ultimo_numero_ticket', 'ultima_fecha_resultados_zulia', 'tasa_dolar', 'admin_whatsapp_numbers', 'admin_email_for_reports', 'mail_config_host', 'mail_config_port', 'mail_config_secure', 'mail_config_user', 'mail_config_pass', 'mail_config_sender_name', 'raffleNumbersInitialized', 'last_sales_notification_count', 'sales_notification_threshold', 'block_reason_message'] },
            { name: 'numeros', columns: ['id', 'numero', 'comprado', '"originalDrawNumber"'] },
            // INICIO DE MODIFICACIÓN: Incluir campos de vendedor en la exportación de ventas
            { name: 'ventas', columns: ['id', '"purchaseDate"', '"drawDate"', '"drawTime"', '"drawNumber"', '"ticketNumber"', '"buyerName"', '"buyerPhone"', 'numbers', '"valueUSD"', '"valueBs"', '"paymentMethod"', '"paymentReference"', '"voucherURL"', '"validationStatus"', '"voidedReason"', '"voidedAt"', '"closedReason"', '"closedAt"', '"sellerId"', '"sellerName"', '"sellerAgency"'] },
            // FIN DE MODIFICACIÓN: Incluir campos de vendedor en la exportación de ventas
            { name: 'horarios_zulia', columns: ['id', 'hora'] },
            { name: 'resultados_zulia', columns: ['id', 'data'] }, // 'data' is JSONB
            { name: 'premios', columns: ['id', 'data'] }, // 'data' is JSONB
            { name: 'ganadores', columns: ['id', 'data'] }, // 'data' is JSONB
            { name: 'comprobantes', columns: ['id', '"ventaId"', 'comprador', 'telefono', 'comprobante_nombre', 'comprobante_tipo', 'fecha_compra', 'url_comprobante'] },
            // INICIO DE NUEVA LÓGICA: Incluir tabla de vendedores en el backup
            { name: 'sellers', columns: ['seller_id', 'full_name', 'id_card', 'agency_name', 'created_at', 'updated_at', 'commission_percentage', 'commission_draw_date', 'commission_value_usd', 'commission_value_bs'] }
            // FIN DE NUEVA LÓGICA: Incluir tabla de vendedores en el backup
        ];

        for (const tableInfo of tablesToExport) {
            try {
                // Construir la consulta SELECT citando los nombres de columna para PostgreSQL
                const quotedColumns = tableInfo.columns.map(col => {
                    // Si el nombre de la columna ya tiene comillas dobles, usarlo tal cual.
                    // De lo contrario, añadir comillas dobles para forzar la sensibilidad a mayúsculas/minúsculas.
                    return col.startsWith('"') && col.endsWith('"') ? col : `"${col}"`;
                }).join(', ');

                const res = await client.query(`SELECT ${quotedColumns} FROM ${tableInfo.name}`);
                const data = res.rows;
                console.log(`[DEBUG_BACKUP] Exportando tabla: ${tableInfo.name} con ${data.length} filas.`);

                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet(tableInfo.name);

                if (data.length > 0) {
                    // Usar los nombres de columna originales (sin comillas) como keys para el worksheet
                    const columns = tableInfo.columns.map(key => ({ header: key.replace(/"/g, ''), key: key.replace(/"/g, ''), width: 25 }));
                    worksheet.columns = columns;
                    worksheet.addRow(columns.map(col => col.header));
                    data.forEach(row => {
                        const rowData = {};
                        columns.forEach(col => {
                            let value = row[col.key]; // Acceder a la propiedad del objeto de fila por su clave
                            if (typeof value === 'object' && value !== null) {
                                // Manejar columnas JSONB explícitamente
                                if (['data', 'numbers', 'tasa_dolar', 'admin_whatsapp_numbers', 'admin_email_for_reports'].includes(col.key.replace(/"/g, ''))) { // Remove quotes for comparison
                                    rowData[col.key.replace(/"/g, '')] = JSON.stringify(value);
                                } else if (Array.isArray(value)) {
                                    rowData[col.key.replace(/"/g, '')] = value.join(', ');
                                } else {
                                    rowData[col.key.replace(/"/g, '')] = JSON.stringify(value);
                                }
                            } else {
                                rowData[col.key.replace(/"/g, '')] = value;
                            }
                        });
                        worksheet.addRow(rowData);
                    });
                } else {
                    worksheet.addRow(['No data']);
                }

                const excelBuffer = await workbook.xlsx.writeBuffer();
                archive.append(excelBuffer, { name: `${tableInfo.name}_backup.xlsx` });
            } catch (queryError) {
                console.warn(`WARN_BACKUP: No se pudo leer o procesar la tabla ${tableInfo.name} para el respaldo: ${queryError.message}. Se omitirá.`);
            }
        }

        archive.finalize();
        console.log('[DEBUG_BACKUP] Archivo ZIP de respaldo finalizado.');

        return new Promise((resolve, reject) => {
            const buffers = [];
            output.on('data', chunk => buffers.push(chunk));
            output.on('end', () => {
                console.log('[DEBUG_BACKUP] Buffer ZIP generado y listo para enviar.');
                resolve(Buffer.concat(buffers));
            });
            archive.on('error', err => {
                console.error('ERROR_BACKUP: Error durante la creación del archivo ZIP:', err.message);
                reject(err);
            });
        });

    } catch (error) {
        console.error('ERROR_BACKUP: Error al generar el buffer ZIP de la base de datos:', error.message);
        throw error;
    } finally {
        client.release();
    }
}


app.post('/api/corte-ventas', async (req, res) => {
    console.log('[DEBUG_CORTE_VENTAS] Iniciando corte de ventas...');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const todayFormatted = now.format('YYYY-MM-DD');

        let configuracion = await getConfiguracionFromDB();
        let ventas = await getVentasFromDB();

        console.log('[DEBUG_CORTE_VENTAS] Configuración actual (desde DB):', JSON.stringify(configuracion, null, 2));

        const ventasDelDia = ventas.filter(venta =>
            venta.drawDate === configuracion.fecha_sorteo &&
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );

        console.log(`[DEBUG_CORTE_VENTAS] Ventas del día (${configuracion.fecha_sorteo}, Confirmadas/Pendientes) desde DB: ${ventasDelDia.length} items.`);
        // console.log('[DEBUG_CORTE_VENTAS] Detalle de ventasDelDia (primeras 5):', JSON.stringify(ventasDelDia.slice(0, 5), null, 2));


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            ventasDelDia,
            configuracion,
            'Corte de Ventas',
            'Corte_Ventas'
        );
        console.log(`[DEBUG_CORTE_VENTAS] Excel de corte de ventas generado: ${excelFileName}`);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + (parseFloat(venta.valueUSD) || 0), 0);
            const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + (parseFloat(venta.valueBs) || 0), 0);

            const subject = `Reporte de Corte de Ventas ${todayFormatted}`;
            const htmlContent = `
                <p>Se ha realizado el corte de ventas para el día <strong>${todayFormatted}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${totalVentasUSD.toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${totalVentasBs.toFixed(2)}</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('ERROR_CORTE_VENTAS: Fallo al enviar el correo de corte de ventas.');
            } else {
                console.log('[DEBUG_CORTE_VENTAS] Correo de corte de ventas enviado.');
            }
        } else {
            console.warn('DEBUG_CORTE_VENTAS: No hay correos de administrador configurados para enviar el reporte de corte de ventas.');
        }

        configuracion = await getConfiguracionFromDB();
        const horariosZulia = await getHorariosZuliaFromDB();

        const fechaSorteoConfigurada = configuracion.fecha_sorteo;
        const zuliaTimes = horariosZulia.zulia;

        let ultimaHoraSorteo = null;
        if (Array.isArray(zuliaTimes) && zuliaTimes.length > 0) {
            ultimaHoraSorteo = zuliaTimes.reduce((latestTime, currentTimeStr) => {
                const latestMoment = moment.tz(`${fechaSorteoConfigurada} ${latestTime}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                const currentMoment = moment.tz(`${fechaSorteoConfigurada} ${currentTimeStr}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                return currentMoment.isAfter(latestMoment) ? currentTimeStr : latestTime;
            }, zuliaTimes[0]);
        }

        const currentMomentInCaracas = moment().tz(CARACAS_TIMEZONE);
        const drawDateMoment = moment(fechaSorteoConfigurada, 'YYYY-MM-DD').tz(CARACAS_TIMEZONE);

        let shouldResetNumbers = false;
        let message = 'Corte de ventas realizado. Los números no han sido reseteados según la hora de sorteo y reservas.';

        if (ultimaHoraSorteo) {
            const ultimaHoraSorteoMoment = moment.tz(`${fechaSorteoConfigurada} ${ultimaHoraSorteo}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);

            if ((currentMomentInCaracas.isSame(drawDateMoment, 'day') && currentMomentInCaracas.isSameOrAfter(ultimaHoraSorteoMoment)) ||
                currentMomentInCaracas.isAfter(drawDateMoment, 'day')) {

                shouldResetNumbers = true;
                message = 'Corte de ventas realizado. Números procesados y reseteados condicionalmente.';
            } else {
                console.log(`[Corte de Ventas] No se realizó el reseteo de números porque la última hora de sorteo de Zulia (${ultimaHoraSorteo}) aún no ha pasado para la fecha ${fechaSorteoConfigurada}, o la fecha actual es anterior al sorteo.`);
            }
        } else {
            console.warn('[Corte de Ventas] No se encontraron horarios de Zulia válidos para determinar la última hora. El reseteo de números por tiempo no se ejecutará.');
        }

        if (shouldResetNumbers) {
            let numeros = await getNumerosFromDB();
            const currentDrawCorrelativo = parseInt(configuracion.numero_sorteo_correlativo);
            let changedCount = 0;

            for (const num of numeros) {
                if (num.comprado && num.originalDrawNumber < currentDrawCorrelativo - 1) { // Nota: 'originalDrawNumber' en minúsculas por DB
                    await updateNumeroInDB(num.numero, false, null);
                    changedCount++;
                    console.log(`Número ${num.numero} liberado. Comprado originalmente para sorteo ${num.originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
                }
            }

            if (changedCount > 0) {
                console.log(`Se liberaron ${changedCount} números antiguos en DB.`);
            } else {
                console.log('No hay números antiguos para liberar en este momento.');
            }
        }

        res.status(200).json({ message: message });

    } catch (error) {
    console.error('ERROR_CORTE_VENTAS: Error al realizar Corte de Ventas en DB:', error.message);
    res.status(500).json({ message: 'Error interno del servidor al realizar Corte de Ventas.', error: error.message });
    }
});


// --- RUTAS PARA PREMIOS ---

app.get('/api/premios', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    const fechaFormateada = moment.tz(fecha, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        const premiosDelDia = await getPremiosFromDB(fechaFormateada);

        const premiosParaFrontend = {
            fechaSorteo: fechaFormateada,
            sorteo12PM: premiosDelDia ? premiosDelDia.sorteo12PM : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: premiosDelDia ? premiosDelDia.sorteo3PM : { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' },
            sorteo5PM: premiosDelDia ? premiosDelDia.sorteo5PM : { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' }
        };

        res.status(200).json(premiosParaFrontend);
    } catch (error) {
        console.error('Error al obtener premios de DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener premios.' });
    }
});

app.post('/api/premios', async (req, res) => {
    const { fechaSorteo, sorteo12PM, sorteo3PM, sorteo5PM } = req.body;

    if (!fechaSorteo || !moment(fechaSorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'La fecha del sorteo (YYYY-MM-DD) es requerida y debe ser válida para guardar premios.' });
    }

    const fechaFormateada = moment.tz(fechaSorteo, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        const premiosData = {
            fechaSorteo: fechaFormateada,
            sorteo12PM: sorteo12PM ? {
                tripleA: sorteo12PM.tripleA || '',
                tripleB: sorteo12PM.tripleB || '',
                valorTripleA: (parseFloat(sorteo12PM.valorTripleA) || 0), // Ensure number
                valorTripleB: (parseFloat(sorteo12PM.valorTripleB) || 0)  // Ensure number
            } : { tripleA: '', tripleB: '', valorTripleA: 0, valorTripleB: 0 },
            sorteo3PM: sorteo3PM ? {
                tripleA: sorteo3PM.tripleA || '',
                tripleB: sorteo3PM.tripleB || '',
                valorTripleA: (parseFloat(sorteo3PM.valorTripleA) || 0), // Ensure number
                valorTripleB: (parseFloat(sorteo3PM.valorTripleB) || 0)  // Ensure number
            } : { tripleA: '', tripleB: '', valorTripleA: 0, valorTripleB: 0 },
            sorteo5PM: sorteo5PM ? {
                tripleA: sorteo5PM.tripleA || '',
                tripleB: sorteo5PM.tripleB || '',
                valorTripleA: (parseFloat(sorteo5PM.valorTripleA) || 0), // Ensure number
                valorTripleB: (parseFloat(sorteo5PM.valorTripleB) || 0)  // Ensure number
            } : { tripleA: '', tripleB: '', valorTripleA: 0, valorTripleB: 0 }
        };

        await upsertPremiosInDB(premiosData);
        console.log('Premios guardados/actualizados en DB.');

        res.status(200).json({ message: 'Premios guardados/actualizados con éxito.', premiosGuardados: premiosData });

    } catch (error) {
        console.error('Error al guardar premios en DB:', error.message);
        console.error('Detalle del error:', error.stack);
        res.status(500).json({ message: 'Error interno del servidor al guardar premios.', error: error.message });
    }
});

app.post('/api/send-test-email', async (req, res) => {
    try {
        const { to, subject, html } = req.body;

        if (!to || !subject || !html) {
            return res.status(400).json({ message: 'Faltan parámetros: "to", "subject" y "html" son obligatorios.' });
        }

        const emailSent = await sendEmail(to, subject, html);

        if (emailSent) {
            res.status(200).json({ message: 'Correo de prueba enviado exitosamente.' });
        } else {
            res.status(500).json({ message: 'Fallo al enviar el correo de prueba. Revisa la configuración del mailer y los logs del servidor.' });
        }
    } catch (error) {
        console.error('Error en la ruta /api/send-test-email:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al enviar correo de prueba.', error: error.message });
    }
});

app.put('/api/tickets/validate/:id', async (req, res) => {
    const ventaId = parseInt(req.params.id);
    const { validationStatus } = req.body;

    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente', 'Anulado por bajo porcentaje', 'Cerrado por Suficiencia de Ventas'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso", "Pendiente", "Anulado por bajo porcentaje" o "Cerrado por Suficiencia de Ventas".' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const ventasRes = await client.query('SELECT * FROM ventas WHERE id = $1', [ventaId]);
        if (ventasRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        let ventaData = ventasRes.rows[0];
        const oldValidationStatus = ventaData.validationStatus;
        // Asegurarse de que ventaData.numbers sea un array (viene de JSONB)
        ventaData.numbers = typeof ventaData.numbers === 'string' ? JSON.parse(ventaData.numbers) : ventaData.numbers;


        await updateVentaStatusInDB(ventaId, validationStatus); // Actualiza el estado en la DB

        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            const numerosAnulados = ventaData.numbers; // Ya es un array
            if (numerosAnulados && numerosAnulados.length > 0) {
                for (const numAnulado of numerosAnulados) {
                    await updateNumeroInDB(numAnulado, false, null);
                }
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} (marcada como Falsa) han sido puestos nuevamente disponibles en DB.`);
            }
        }

        await client.query('COMMIT');

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: { id: ventaId, ...ventaData, validationStatus: validationStatus } });
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error(`Error al actualizar el estado de la venta ${ventaId} en DB:`, error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    } finally {
        if (client) client.release();
    }
});


// Endpoint para exportar toda la base de datos en un archivo ZIP
app.get('/api/export-database', async (req, res) => {
    const archiveName = `rifas_db_backup_${moment().format('YYYYMMDD_HHmmss')}.zip`;
    res.attachment(archiveName);

    try {
        const zipBuffer = await generateDatabaseBackupZipBuffer();
        res.status(200).send(zipBuffer);
        console.log('Base de datos exportada y enviada como ZIP.');
    } catch (error) {
        console.error('Error al exportar la base de datos:', error.message);
        res.status(500).send('Error al exportar la base de datos.');
    }
});

// Endpoint para generar el enlace de WhatsApp para un cliente (pago confirmado)
app.post('/api/generate-whatsapp-customer-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp.' });
    }

    try {
        const client = await pool.connect();
        const ventaRes = await client.query('SELECT * FROM ventas WHERE id = $1', [ventaId]);
        client.release();

        const venta = ventaRes.rows[0];
        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        // 'numbers' ya debería ser un array debido a getVentasFromDB
        const purchasedNumbers = Array.isArray(venta.numbers) ? venta.numbers.join(', ') : '';
        const valorUsd = (parseFloat(venta.valueUSD) || 0).toFixed(2);
        const valorBs = (parseFloat(venta.valueBs) || 0).toFixed(2);
        const metodoPago = venta.paymentMethod;
        const referenciaPago = venta.paymentReference;
        const fechaCompra = moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('DD/MM/YYYY HH:mm');

        const whatsappMessage = encodeURIComponent(
            `¡Hola! 👋 Su compra ha sido *confirmada* con éxito. \n\n` +
            `Detalles de su ticket:\n` +
            `*Número de Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${purchasedNumbers}\n` +
            `*Valor Pagado:* $${valorUsd} USD (Bs ${valorBs})\n` +
            `*Método de Pago:* ${metodoPago}\n` +
            (referenciaPago ? `*Referencia de Pago:* ${referenciaPago}\n` : '') +
            `*Fecha de Compra:* ${fechaCompra}\n\n` +
            `¡Mucha suerte en el sorteo! Estaremos informándole sobre los resultados.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para el cliente:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});

// Endpoint para generar el enlace de WhatsApp para notificar pago falso
app.post('/api/generate-whatsapp-false-payment-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp para pago falso.' });
    }

    try {
        const client = await pool.connect();
        const ventaRes = await client.query('SELECT * FROM ventas WHERE id = $1', [ventaId]);
        client.release();

        const venta = ventaRes.rows[0];
        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp de pago falso.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        const comprador = venta.buyerName || 'Estimado cliente';

        const whatsappMessage = encodeURIComponent(
            `¡Hola ${comprador}! 👋\n\n` +
            `Lamentamos informarle que su pago para la compra con Ticket N° *${ticketNumber}* no pudo ser verificado.\n\n` +
            `Por lo tanto, su compra ha sido *anulada*.\n\n` +
            `Si cree que esto es un error o tiene alguna pregunta, por favor, contáctenos para aclarar la situación.\n\n` +
            `Gracias por su comprensión.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para pago falso:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp para pago falso.', error: error.message });
    }
});

// Endpoint NUEVO: Para enviar notificación de ticket ganador vía WhatsApp
app.post('/api/notify-winner', async (req, res) => {
    const {
        ventaId, // No se usa directamente en el mensaje de WhatsApp, pero puede ser útil para logs
        buyerPhone,
        buyerName,
        numbers,
        drawDate,
        drawTime,
        ticketNumber,
        coincidentNumbers,
        totalPotentialPrizeBs,
        totalPotentialPrizeUSD
    } = req.body;

    if (!buyerPhone || !buyerName || !numbers || !drawDate || !drawTime || !ticketNumber || !coincidentNumbers || totalPotentialPrizeBs === undefined || totalPotentialPrizeUSD === undefined) {
        return res.status(400).json({ message: 'Faltan datos requeridos para enviar la notificación de ganador.' });
    }

    try {
        const formattedCoincidentNumbers = Array.isArray(coincidentNumbers) ? coincidentNumbers.join(', ') : coincidentNumbers;
        const formattedPurchasedNumbers = Array.isArray(numbers) ? numbers.join(', ') : numbers;

        const whatsappMessage = encodeURIComponent(
            `¡Felicidades, ${buyerName}! 🥳🎉\n\n` +
            `¡Tu ticket ha sido *GANADOR* en el sorteo! 🥳\n\n` +
            `Detalles del Ticket:\n` +
            `*Nro. Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${formattedPurchasedNumbers}\n` +
            `*Fecha del Sorteo:* ${drawDate}\n` +
            `*Hora del Sorteo:* ${drawTime}\n` +
            `*Números Coincidentes:* ${formattedCoincidentNumbers}\n\n` +
            `*¡Has ganado!* 💰\n` +
            `*Premio Potencial:* $${parseFloat(totalPotentialPrizeUSD).toFixed(2)} USD (Bs ${parseFloat(totalPotentialPrizeBs).toFixed(2)})\n\n` +
            `Por favor, contáctanos para coordinar la entrega de tu premio.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${buyerPhone}&text=${whatsappMessage}`;

        console.log(`Generado enlace de WhatsApp para notificar a ${buyerName} (${buyerPhone}): ${whatsappLink}`);

        res.status(200).json({ message: 'Enlace de notificación de WhatsApp generado con éxito. Se intentará abrir WhatsApp.', whatsappLink: whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para notificar al ganador:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});


// POST /api/tickets/procesar-ganadores
app.post('/api/tickets/procesar-ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.body;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos para procesar ganadores.' });
    }

    try {
        const ventas = await getVentasFromDB();
        const resultadosZulia = (await pool.query('SELECT data FROM resultados_zulia WHERE (data->>\'fecha\')::text = $1 AND (data->>\'tipoLoteria\')::text = $2', [fecha, tipoLoteria])).rows.map(row => row.data);
        const premios = await getPremiosFromDB(fecha);
        const configuracion = await getConfiguracionFromDB();

        const ticketsGanadoresParaEsteSorteo = [];

        const resultadosDelDia = resultadosZulia.find(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (!resultadosDelDia || !resultadosDelDia.resultados || resultadosDelDia.resultados.length === 0) {
            return res.status(200).json({ message: 'No se encontraron resultados de sorteo para esta fecha y lotería para procesar ganadores.' });
        }

        const premiosDelDia = premios; // getPremiosFromDB ya devuelve el objeto para la fecha
        if (!premiosDelDia) {
            return res.status(200).json({ message: 'No se encontraron configuraciones de premios para esta fecha para procesar ganadores.' });
        }

        for (const venta of ventas) {
            // Asegurarse de que venta.numbers sea un array (viene de JSONB)
            const ventaNumbers = Array.isArray(venta.numbers) ? venta.numbers : JSON.parse(venta.numbers || '[]');

            if (venta.drawDate === fecha && venta.drawNumber.toString() === numeroSorteo.toString()) {
                let coincidentNumbers = [];
                let totalPotentialPrizeUSD = 0;
                let totalPotentialPrizeBs = 0;

                resultadosDelDia.resultados.forEach(r => {
                    const winningTripleA = r.tripleA ? r.tripleA.toString().padStart(3, '0') : null;
                    const winningTripleB = r.tripleB ? r.tripleB.toString().padStart(3, '0') : null;

                    let currentCoincidentNumbersForHour = [];

                    if (winningTripleA && ventaNumbers.includes(winningTripleA)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleA, 10));
                    }
                    if (winningTripleB && ventaNumbers.includes(winningTripleB)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleB, 10));
                    }

                    if (currentCoincidentNumbersForHour.length > 0) {
                        let prizeConfigForHour;
                        if (r.hora.includes('12:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo12PM;
                        } else if (r.hora.includes('04:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo3PM;
                        } else if (r.hora.includes('07:05 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo5PM;
                        }

                        if (prizeConfigForHour) {
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleA, 10)) && (parseFloat(prizeConfigForHour.valorTripleA) || 0)) {
                                totalPotentialPrizeUSD += (parseFloat(prizeConfigForHour.valorTripleA) || 0);
                            }
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleB, 10)) && (parseFloat(prizeConfigForHour.valorTripleB) || 0)) {
                                totalPotentialPrizeUSD += (parseFloat(prizeConfigForHour.valorTripleB) || 0);
                            }
                        }
                        coincidentNumbers = Array.from(new Set([...coincidentNumbers, ...currentCoincidentNumbersForHour]));
                    }
                });

                if (coincidentNumbers.length > 0) {
                    totalPotentialPrizeBs = totalPotentialPrizeUSD * configuracion.tasa_dolar[0]; // Acceder al valor numérico del array
                    ticketsGanadoresParaEsteSorteo.push({
                        ticketNumber: venta.ticketNumber,
                        buyerName: venta.buyerName,
                        buyerPhone: venta.buyerPhone,
                        numbers: ventaNumbers, // Asegurarse de que sea el array
                        drawDate: venta.drawDate,
                        drawNumber: venta.drawNumber,
                        purchaseDate: venta.purchaseDate,
                        coincidentNumbers: coincidentNumbers,
                        totalPotentialPrizeUSD: totalPotentialPrizeUSD,
                        totalPotentialPrizeBs: totalPotentialPrizeBs
                    });
                }
            }
        }

        const now = moment().tz(CARACAS_TIMEZONE).toISOString();
        const newWinnersEntry = {
            drawDate: fecha,
            drawNumber: parseInt(numeroSorteo),
            lotteryType: tipoLoteria,
            winners: ticketsGanadoresParaEsteSorteo,
            processedAt: now
        };

        await upsertGanadoresInDB(newWinnersEntry);
        console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} guardados/actualizados en DB.`);

        res.status(200).json({ message: 'Ganadores procesados y guardados con éxito.', totalGanadores: ticketsGanadoresParaEsteSorteo.length });

    } catch (error) {
        console.error('Error al procesar y guardar tickets ganadores en DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al procesar y guardar tickets ganadores.', error: error.message });
    }
});


// GET /api/tickets/ganadores
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        const ganadores = await getGanadoresFromDB(fecha, parseInt(numeroSorteo), tipoLoteria);
        if (ganadores && ganadores.length > 0) {
            res.status(200).json({ ganadores: ganadores });
        } else {
            res.status(200).json({ ganadores: [], message: 'No se encontraron tickets ganadores procesados para esta consulta.' });
        }
    } catch (error) {
        console.error('Error al obtener ganadores desde DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener ganadores.', error: error.message });
    }
});

// Función para liberar números que ya excedieron la reserva de 2 sorteos
async function liberateOldReservedNumbers(currentDrawCorrelativo) {
    console.log(`[liberateOldReservedNumbers] Revisando números para liberar (correlativo actual: ${currentDrawCorrelativo})...`);

    const client = await pool.connect();
    try {
        // Seleccionar números que cumplen la condición para ser liberados
        const res = await client.query(
            'SELECT numero FROM numeros WHERE comprado = TRUE AND "originalDrawNumber" < $1', // Added quotes for consistency
            [currentDrawCorrelativo - 1]
        );
        const numbersToLiberate = res.rows.map(row => row.numero);

        if (numbersToLiberate.length > 0) {
            // Actualizar el estado de esos números
            await client.query(
                'UPDATE numeros SET comprado = FALSE, "originalDrawNumber" = NULL WHERE numero = ANY($1::text[])', // Added quotes for consistency
                [Array.from(numbersToLiberate)]
            );
            console.log(`Se liberaron ${numbersToLiberate.length} números antiguos en DB.`);
        } else {
            console.log('No hay números antiguos para liberar en este momento.');
        }
    } catch (error) {
        console.error('Error al liberar números antiguos en DB:', error.message);
        throw error; // Propagar el error para que sea manejado por el llamador
    } finally {
        client.release();
    }
}

// Función auxiliar para avanzar la configuración del sorteo (fecha, correlativo, último ticket)
async function advanceDrawConfiguration(currentConfig, targetDate) {
    const updatedConfig = {
        ...currentConfig, // Mantener el resto de la configuración
        fecha_sorteo: targetDate,
        numero_sorteo_correlativo: (currentConfig.numero_sorteo_correlativo || 0) + 1,
        ultimo_numero_ticket: 0,
        pagina_bloqueada: false,
        last_sales_notification_count: 0,
        block_reason_message: ""
    };
    await updateConfiguracionInDB(updatedConfig);
    console.log(`Configuración avanzada en DB para el siguiente sorteo: Fecha ${updatedConfig.fecha_sorteo}, Correlativo ${updatedConfig.numero_sorteo_correlativo}.`);
    return updatedConfig; // Devolver la configuración actualizada
}


/**
 * Evalúa el estado del sorteo actual basándose en el porcentaje de ventas
 * y actualiza el estado de los tickets, sin avanzar la fecha del sorteo.
 * @param {moment.Moment} nowMoment - El objeto moment actual para la hora de Caracas.
 * @returns {Promise<Object>} Resultado de la evaluación.
 */
async function evaluateDrawStatusOnly(nowMoment) {
    console.log(`[evaluateDrawStatusOnly] Iniciando evaluación de estado de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    let client;
    try {
        client = await pool.connect();
        let configuracion = await getConfiguracionFromDB();
        let ventas = await getVentasFromDB();

        const currentDrawDateStr = configuracion.fecha_sorteo;

        const soldTicketsForCurrentDraw = ventas.filter(venta =>
            venta.drawDate === currentDrawDateStr &&
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );
        const totalSoldTicketsCount = soldTicketsForCurrentDraw.length;


        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalSoldTicketsCount / totalPossibleTickets) * 100;

        console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados.`);

        let message = '';
        let whatsappMessageContent = '';
        let emailSubject = '';
        let emailHtmlContent = '';
        let excelReport = { excelFilePath: null, excelFileName: null };

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados.`);

            for (const venta of soldTicketsForCurrentDraw) {
                await updateVentaStatusInDB(venta.id, 'Anulado por bajo porcentaje', 'Ventas insuficientes para el sorteo', nowMoment.toISOString(), null, null);
            }
            message = `Sorteo del ${currentDrawDateStr} marcado como anulado por ventas insuficientes.`;
            whatsappMessageContent = `*¡Alerta de Sorteo Suspendido!* 🚨\n\nEl sorteo del *${currentDrawDateStr}* ha sido *ANULADO* debido a un bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).\n\nTodos los tickets válidos para este sorteo serán revalidados automáticamente para el próximo sorteo.`;
            emailSubject = `ALERTA: Sorteo Anulado - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>ANULADO</strong>.</p>
                <p><b>Razón:</b> Bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento de la suspensión.</p>
                <p>Todos los tickets válidos para este sorteo han sido marcados para ser revalidados automáticamente para el próximo sorteo.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                configuracion,
                `Reporte de Suspensión del Sorteo ${currentDrawDateStr}`,
                'Reporte_Suspension'
            );

        } else {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) cumplen o superan el ${SALES_THRESHOLD_PERCENTAGE}%. Marcando tickets como cerrados.`);

            for (const venta of soldTicketsForCurrentDraw) {
                await updateVentaStatusInDB(venta.id, 'Cerrado por Suficiencia de Ventas', null, null, 'Ventas suficientes para el sorteo', nowMoment.toISOString());
            }
            message = `Sorteo del ${currentDrawDateStr} marcado como cerrado por suficiencia de ventas.`;
            whatsappMessageContent = `*¡Sorteo Cerrado Exitosamente!* ✅\n\nEl sorteo del *${currentDrawDateStr}* ha sido *CERRADO* con éxito. Se alcanzó el porcentaje de ventas (${soldPercentage.toFixed(2)}%) requerido.`;
            emailSubject = `NOTIFICACIÓN: Sorteo Cerrado Exitosamente - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>CERRADO EXITOSAMENTE</strong>.</p>
                <p><b>Detalles:</b> Se alcanzó o superó el porcentaje de ventas requerido (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento del cierre.</p>
                <p>La página de compra para este sorteo ha sido bloqueada. Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                configuracion,
                `Reporte de Cierre del Sorteo ${currentDrawDateStr}`,
                'Reporte_Cierre'
            );
        }
        await updateConfiguracionInDB(configuracion); // Guardar cambios en configuracion en DB
        console.log('[evaluateDrawStatusOnly] Estado de ventas y configuración actualizados en DB.');

        await sendWhatsappNotification(whatsappMessageContent);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const attachments = excelReport.excelFilePath ? [{
                filename: excelReport.excelFileName,
                path: excelReport.excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('ERROR_EVALUATE_DRAW: Fallo al enviar el correo de notificación de suspensión/cierre.');
            } else {
                console.log('DEBUG_EVALUATE_DRAW: Correo de notificación de suspensión/cierre enviado con éxito.');
            }
        }

        return { success: true, message: message, evaluatedDate: currentDrawDateStr, salesPercentage: soldPercentage };

    } catch (error) {
        console.error('ERROR_EVALUATE_DRAW: ERROR durante la evaluación del sorteo en DB:', error.message);
        return { success: false, message: `Error interno al evaluar estado de sorteo: ${error.message}` };
    } finally {
        if (client) client.release();
    }
}


// --- Lógica central para la verificación, anulación/cierre y AVANCE del sorteo (Cierre Manual) ---
async function cerrarSorteoManualmente(nowMoment) {
    console.log(`[cerrarSorteoManualmente] Iniciando cierre manual de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        let configuracion = await getConfiguracionFromDB();

        const currentDrawCorrelativo = configuracion.numero_sorteo_correlativo;

        const evaluationResult = await evaluateDrawStatusOnly(nowMoment);
        if (!evaluationResult.success) {
            return evaluationResult;
        }

        await liberateOldReservedNumbers(currentDrawCorrelativo);

        const nextDayDate = nowMoment.clone().add(1, 'days').format('YYYY-MM-DD');
        configuracion = await advanceDrawConfiguration(configuracion, nextDayDate); // Actualizar 'configuracion' después de avanzar

        const whatsappMessage = `*¡Sorteo Finalizado y Avanzado!* 🥳\n\nEl sorteo del *${evaluationResult.evaluatedDate}* ha sido finalizado. Ventas: *${evaluationResult.salesPercentage.toFixed(2)}%*.\n\nLa configuración ha avanzado al Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha *${configuracion.fecha_sorteo}*.`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `CONFIRMACIÓN: Avance de Sorteo Manual - A Sorteo ${configuracion.numero_sorteo_correlativo}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les confirma que se ha realizado el <strong>avance de sorteo manual</strong>.</p>
                <p><b>Sorteo Anterior:</b> Fecha ${evaluationResult.evaluatedDate}, Ventas ${evaluationResult.salesPercentage.toFixed(2)}%</p>
                <p><b>Nuevo Sorteo Activo:</b> Nro. <b>${configuracion.numero_sorteo_correlativo}</b> para la fecha <b>${configuracion.fecha_sorteo}</b>.</p>
                <p>La página de compra ha sido desbloqueada para nuevas ventas.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent);
            if (!emailSent) {
                console.error('ERROR_CIERRE_MANUAL: Fallo al enviar el correo de notificación de cierre manual y avance.');
            } else {
                console.log('DEBUG_CIERRE_MANUAL: Correo de notificación de cierre manual y avance enviado con éxito.');
            }
        }

        return {
            success: true,
            message: `${evaluationResult.message} y la configuración del sorteo ha avanzado para el siguiente.`,
            closedDate: evaluationResult.evaluatedDate,
            salesPercentage: evaluationResult.salesPercentage
        };

    } catch (error) {
        console.error('ERROR_CIERRE_MANUAL: ERROR durante el cierre manual del sorteo en DB:', error.message);
        return { success: false, message: `Error interno: ${error.message}` };
    }
}


// --- ENDPOINT PARA CIERRE MANUAL DEL SORTEO (Full Close + Advance) ---
app.post('/api/cerrar-sorteo-manualmente', async (req, res) => {
    console.log('API: Recibida solicitud para cierre manual de sorteo.');
    try {
        const configuracion = await getConfiguracionFromDB();

        const currentDrawDateStr = configuracion.fecha_sorteo;

        const simulatedMoment = moment().tz(CARACAS_TIMEZONE);
        const currentDrawDateMoment = moment.tz(currentDrawDateStr, 'YYYY-MM-DD', CARACAS_TIMEZONE);

        if (simulatedMoment.isSame(currentDrawDateMoment, 'day')) {
             simulatedMoment.set({ hour: DRAW_SUSPENSION_HOUR, minute: DRAW_SUSPENSION_MINUTE + 5, second: 0 });
        } else if (simulatedMoment.isBefore(currentDrawDateMoment, 'day')) {
             return res.status(400).json({ message: 'No se puede cerrar manualmente un sorteo cuya fecha aún no ha llegado.' });
        }

        const result = await cerrarSorteoManualmente(simulatedMoment);

        if (result.success) {
            res.status(200).json({ message: result.message, closedDate: result.closedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de cierre manual de sorteo en DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al cerrar el sorteo manualmente.', error: error.message });
    }
});


// --- ENDPOINT PARA SUSPENDER SORTEO (Evaluate Sales Only) ---
app.post('/api/suspender-sorteo', async (req, res) => {
    console.log('API: Recibida solicitud para suspender sorteo (evaluación de ventas).');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);

        const result = await evaluateDrawStatusOnly(now);
        if (result.success) {
            res.status(200).json({ message: result.message, evaluatedDate: result.evaluatedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de suspensión de sorteo en DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al suspender sorteo.', error: error.message });
    }
});


// --- NUEVO ENDPOINT: Establecer fecha de sorteo manualmente (después de suspensión) ---
app.post('/api/set-manual-draw-date', async (req, res) => {
    const { newDrawDate } = req.body;
    console.log(`API: Recibida solicitud para establecer fecha de sorteo manualmente a: ${newDrawDate}.`);

    if (!newDrawDate || !moment(newDrawDate, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Fecha de sorteo inválida. Debe serYYYY-MM-DD.' });
    }

    try {
        let configuracion = await getConfiguracionFromDB();

        const oldDrawDate = configuracion.fecha_sorteo;
        const oldDrawCorrelativo = configuracion.numero_sorteo_correlativo;

        configuracion = await advanceDrawConfiguration(configuracion, newDrawDate); // Actualizar 'configuracion' después de avanzar

        await liberateOldReservedNumbers(configuracion.numero_sorteo_correlativo);

        const ventas = await getVentasFromDB();
        const salesForOldDraw = ventas.filter(venta =>
            venta.drawDate === oldDrawDate &&
            ['Confirmado', 'Pendiente', 'Cerrado por Suficiencia de Ventas', 'Anulado por bajo porcentaje'].includes(venta.validationStatus)
        );


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesForOldDraw,
            { fecha_sorteo: oldDrawDate, numero_sorteo_correlativo: oldDrawCorrelativo },
            `Reporte de Reprogramación del Sorteo ${oldDrawDate}`,
            'Reporte_Reprogramacion'
        );

        const whatsappMessage = `*¡Sorteo Reprogramado!* 🗓️\n\nLa fecha del sorteo ha sido actualizada manualmente. Anteriormente Sorteo Nro. *${oldDrawCorrelativo}* de fecha *${oldDrawDate}*.\n\nAhora Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha: *${newDrawDate}*.\n\n¡La página de compra está nuevamente activa!`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `NOTIFICACIÓN: Sorteo Reprogramado - Nueva Fecha ${newDrawDate}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo ha sido <strong>reprogramado manualmente</strong>.</p>
                <p><b>Fecha Anterior:</b> ${oldDrawDate} (Sorteo Nro. ${oldDrawCorrelativo})</p>
                <p><b>Nueva Fecha:</b> ${newDrawDate} (Sorteo Nro. ${configuracion.numero_sorteo_correlativo})</p>
                <p>Adjunto encontrarás el reporte de ventas del sorteo anterior (${oldDrawDate}) al momento de la reprogramación.</p>
                <p>La página de compra ha sido desbloqueada automáticamente.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = excelFilePath ? [{
                filename: excelFileName,
                path: excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('ERROR_REPROGRAMACION: Fallo al enviar el correo de notificación de reprogramación.');
            } else {
                console.log('DEBUG_REPROGRAMACION: Correo de notificación de reprogramación enviado con éxito.');
            }
        }

        res.status(200).json({
            success: true,
            message: `Fecha del sorteo actualizada manualmente a ${newDrawDate}. El número de sorteo ha avanzado al ${configuracion.numero_sorteo_correlativo} y los números reservados antiguos han sido liberados.`,
            newConfig: configuracion
        });

    } catch (error) {
        console.error('ERROR_REPROGRAMACION: Error en la API de set-manual-draw-date en DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al establecer la fecha del sorteo manualmente.', error: error.message });
    }
});


// NUEVO ENDPOINT: Notificación de ventas para desarrolladores
app.post('/api/developer-sales-notification', async (req, res) => {
    console.log('API: Recibida solicitud para notificación de ventas para desarrolladores.');
    try {
        const configuracion = await getConfiguracionFromDB();
        const ventas = await getVentasFromDB();

        const now = moment().tz(CARACAS_TIMEZONE);

        const currentDrawDateStr = configuracion.fecha_sorteo;
        const ventasParaFechaSorteo = ventas.filter(venta =>
            venta.drawDate === currentDrawDateStr &&
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );

        const totalVentas = ventasParaFechaSorteo.length;
        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

        let messageText = `*Notificación de Ventas para Desarrolladores*\n\n`;
        messageText += `*Hora de Notificación:* ${now.format('DD/MM/YYYY HH:mm:ss')}\n`;
        messageText += `*Fecha de Sorteo Activo:* ${currentDrawDateStr}\n`;
        messageText += `*Tickets Vendidos:* ${totalVentas} de ${totalPossibleTickets}\n`;
        messageText += `*Porcentaje de Ventas:* ${soldPercentage.toFixed(2)}%\n\n`;

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            messageText += `*Estado:* Las ventas están por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        } else {
            messageText += `*Estado:* Las ventas han alcanzado o superado el ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        }

        await sendWhatsappNotification(messageText);

        res.status(200).json({ message: 'Notificación de ventas para desarrolladores enviada exitosamente por WhatsApp.' });

    } catch (error) {
        console.error('Error al enviar notificación de ventas para desarrolladores desde DB:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al enviar notificación de ventas para desarrolladores.', error: error.message });
    }
});

// INICIO DE NUEVA LÓGICA: ENDPOINTS PARA LA GESTIÓN DE VENDEDORES

// Endpoint para obtener un vendedor por su ID
app.get('/api/sellers/:sellerId', async (req, res) => {
    const { sellerId } = req.params;
    try {
        const seller = await getSellerByIdFromDB(sellerId);
        if (seller) {
            res.json(seller);
        } else {
            res.status(404).json({ message: 'Vendedor no encontrado.' });
        }
    } catch (error) {
        console.error('ERROR_API: Error al obtener vendedor:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener vendedor.' });
    }
});

// Endpoint para crear o actualizar un vendedor
app.post('/api/sellers', async (req, res) => {
    const { seller_id, full_name, id_card, agency_name } = req.body;

    if (!seller_id || !full_name || !id_card || !agency_name) {
        return res.status(400).json({ message: 'Todos los campos del vendedor son obligatorios.' });
    }

    try {
        const seller = await upsertSellerInDB({ seller_id, full_name, id_card, agency_name });
        res.status(200).json({ message: 'Perfil de vendedor guardado con éxito.', seller: seller });
    } catch (error) {
        console.error('ERROR_API: Error al guardar perfil de vendedor:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al guardar perfil de vendedor.' });
    }
});

// Endpoint para obtener todos los vendedores (para el Panel de Administración)
app.get('/api/sellers', async (req, res) => {
    try {
        const sellers = await getAllSellersFromDB();
        res.json(sellers);
    } catch (error) {
        console.error('ERROR_API: Error al obtener todos los vendedores:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener vendedores.' });
    }
});

// Endpoint para eliminar un vendedor
app.delete('/api/sellers/:sellerId', async (req, res) => {
    const { sellerId } = req.params;
    try {
        const deletedSeller = await deleteSellerFromDB(sellerId);
        if (deletedSeller) {
            res.json({ message: 'Vendedor eliminado con éxito.', seller: deletedSeller });
        } else {
            res.status(404).json({ message: 'Vendedor no encontrado para eliminar.' });
        }
    } catch (error) {
        console.error('ERROR_API: Error al eliminar vendedor:', error.message);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// NUEVO ENDPOINT: Ruta para actualizar la comisión de un vendedor
app.put('/api/sellers/commission/:sellerId', async (req, res) => {
    const { sellerId } = req.params;
    const { commission_percentage, commission_draw_date, commission_value_usd, commission_value_bs } = req.body;
    const client = await pool.connect();
    try {
        // Validar que el sellerId existe
        const sellerCheck = await client.query('SELECT 1 FROM sellers WHERE seller_id = $1', [sellerId]);
        if (sellerCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Vendedor no encontrado.' });
        }

        const result = await client.query(
            `UPDATE sellers SET
                commission_percentage = $1,
                commission_draw_date = $2,
                commission_value_usd = $3,
                commission_value_bs = $4
             WHERE seller_id = $5
             RETURNING *;`,
            [commission_percentage, commission_draw_date, commission_value_usd, commission_value_bs, sellerId]
        );
        if (result.rows.length > 0) {
            res.json({ message: 'Comisión del vendedor actualizada con éxito.', seller: result.rows[0] });
        } else {
            // Esto no debería ocurrir si el sellerCheck pasa, pero es un fallback
            res.status(500).json({ message: 'Error al actualizar la comisión del vendedor.' });
        }
    } catch (error) {
        console.error('Error al actualizar la comisión del vendedor:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar la comisión.', error: error.message });
    } finally {
        client.release();
    }
});
// FIN DE NUEVA LÓGICA: ENDPOINTS PARA LA GESTIÓN DE VENDEDORES

// INICIO DE NUEVA LÓGICA: ENDPOINT PARA REPORTE DE VENTAS POR VENDEDOR
app.get('/api/reports/sales-by-seller', async (req, res) => {
    console.log('API: Recibida solicitud para generar reporte de ventas por vendedor.');
    const { sellerId, drawDate } = req.query; // Parámetros opcionales

    let client;
    try {
        client = await pool.connect();
        let query = 'SELECT * FROM ventas WHERE 1=1';
        const queryParams = [];
        let paramIndex = 1;

        if (sellerId) {
            query += ` AND "sellerId" = $${paramIndex++}`;
            queryParams.push(sellerId);
        }
        if (drawDate) {
            query += ` AND "drawDate" = $${paramIndex++}`;
            queryParams.push(drawDate);
        }

        query += ' ORDER BY "purchaseDate" DESC';

        const salesRes = await client.query(query, queryParams);
        const salesData = salesRes.rows.map(row => ({
            ...row,
            numbers: typeof row.numbers === 'string' ? JSON.parse(row.numbers) : row.numbers
        }));

        const configuracion = await getConfiguracionFromDB();

        const reportTitle = 'Reporte de Ventas por Vendedor';
        const fileNamePrefix = 'Reporte_Ventas_Vendedor';

        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesData,
            configuracion, // Usar la configuración general
            reportTitle,
            fileNamePrefix
        );

        res.download(excelFilePath, excelFileName, (err) => {
            if (err) {
                console.error('ERROR_REPORT: Error al enviar el archivo Excel:', err.message);
                res.status(500).json({ message: 'Error al descargar el reporte.' });
            } else {
                console.log('INFO_REPORT: Reporte de ventas por vendedor enviado con éxito.');
                // Opcional: Eliminar el archivo después de enviarlo
                fs.unlink(excelFilePath).catch(unlinkErr => console.error('Error al eliminar archivo Excel temporal:', unlinkErr));
            }
        });

    } catch (error) {
        console.error('ERROR_REPORT: Error al generar reporte de ventas por vendedor:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el reporte de ventas por vendedor.' });
    } finally {
        if (client) client.release();
    }
});
// FIN DE NUEVA LÓGICA: ENDPOINT PARA REPORTE DE VENTAS POR VENDEDOR


// Endpoint para limpiar todos los datos (útil para reinicios de sorteo)
app.post('/api/admin/limpiar-datos', async (req, res) => {
    console.log('API: Recibida solicitud para limpiar datos.');
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Iniciar transacción

        // Resetear números
        await client.query('TRUNCATE TABLE numeros RESTART IDENTITY;');
        const initialNumbers = [];
        for (let i = 0; i < TOTAL_RAFFLE_NUMBERS; i++) {
            const numStr = i.toString().padStart(3, '0');
            initialNumbers.push({ numero: numStr, comprado: false, originalDrawNumber: null });
        }
        for (const num of initialNumbers) {
            await client.query('INSERT INTO numeros (numero, comprado, "originalDrawNumber") VALUES ($1, $2, $3)', [num.numero, num.comprado, num.originalDrawNumber]);
        }

        // Limpiar ventas, resultados, ganadores, comprobantes y vendedores
        await client.query('TRUNCATE TABLE ventas RESTART IDENTITY CASCADE;'); // CASCADE para eliminar referencias
        await client.query('TRUNCATE TABLE resultados_zulia RESTART IDENTITY;');
        await client.query('TRUNCATE TABLE ganadores RESTART IDENTITY;');
        await client.query('TRUNCATE TABLE comprobantes RESTART IDENTITY;');
        await client.query('TRUNCATE TABLE premios RESTART IDENTITY;'); // También limpiar premios
        await client.query('TRUNCATE TABLE sellers RESTART IDENTITY;'); // NUEVO: Limpiar tabla de vendedores
        await client.query('TRUNCATE TABLE sorteos_historial RESTART IDENTITY;'); // Limpiar historial de sorteos

        // Limpiar archivos de comprobantes subidos
        const files = await fs.readdir(COMPROBANTES_DIR); // Usar COMPROBANTES_DIR
        for (const file of files) {
            await fs.unlink(path.join(COMPROBANTES_DIR, file)); // Usar COMPROBANTES_DIR
        }
        console.log('Archivos de comprobantes en /uploads/comprobantes eliminados.');

        // Resetear configuración a valores iniciales (o un estado limpio)
        const configuracion = await getConfiguracionFromDB(); // Obtener la configuración actual para mantener mail/whatsapp
        const resetConfig = {
            id: configuracion.id, // Mantener el ID de la configuración
            tasa_dolar: [36.50], // Corregido: Array para JSONB
            pagina_bloqueada: false,
            fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            precio_ticket: 3.00,
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            ultima_fecha_resultados_zulia: null,
            admin_whatsapp_numbers: configuracion.admin_whatsapp_numbers,
            mail_config_host: configuracion.mail_config_host,
            mail_config_port: configuracion.mail_config_port,
            mail_config_secure: configuracion.mail_config_secure,
            mail_config_user: configuracion.mail_config_user,
            mail_config_pass: configuracion.mail_config_pass,
            mail_config_sender_name: configuracion.mail_config_sender_name,
            admin_email_for_reports: configuracion.admin_email_for_reports,
            raffleNumbersInitialized: true,
            last_sales_notification_count: 0,
            sales_notification_threshold: 20,
            block_reason_message: ""
        };
        await updateConfiguracionInDB(resetConfig);

        await client.query('COMMIT'); // Confirmar transacción

        res.status(200).json({ message: 'Todos los datos de la aplicación han sido limpiados y reseteados.' });
        console.log('Todos los datos de la aplicación han sido limpiados y reseteados.');

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error('ERROR_LIMPIAR_DATOS: Error al limpiar datos:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al limpiar datos.', error: error.message });
    } finally {
        if (client) client.release();
    }
});


// Tareas programadas (Cron Jobs)
// Se ejecutarán después de que el servidor se inicie y los datos se carguen

/**
 * Función asíncrona para la tarea programada de verificación diaria de ventas
 * y posible anulación/cierre de sorteo, y avance al siguiente sorteo.
 */
async function dailyDrawCheckCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: Sorteo verificado y procesado.`);
}

cron.schedule('15 12 * * *', dailyDrawCheckCronJob, {
    timezone: CARACAS_TIMEZONE
});

/**
 * Función asíncrona para la tarea programada de Notificación de ventas por WhatsApp y Email.
 * Se ejecuta periódicamente para enviar resúmenes de ventas a los administradores.
 */
async function salesSummaryCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications();
}

// Corregido: Añadir la zona horaria para consistencia
cron.schedule('*/55 * * * *', salesSummaryCronJob, {
    timezone: CARACAS_TIMEZONE
});

/**
 * NUEVA FUNCIÓN CRON JOB: Respaldo automático de la base de datos y envío por correo.
 * Se ejecuta cada 55 minutos para generar un backup y enviarlo.
 */
async function dailyDatabaseBackupCronJob() {
    console.log('CRON JOB: Iniciando respaldo automático de la base de datos y envío por correo.');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const backupFileName = `rifas_db_backup_${now.format('YYYYMMDD_HHmmss')}.zip`;
        const zipBuffer = await generateDatabaseBackupZipBuffer();

        const configuracion = await getConfiguracionFromDB(); // Recargar la más reciente

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `Respaldo Automático de Base de Datos - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se ha generado el respaldo automático de la base de datos de Rifas.</p>
                <p>Fecha y Hora del Respaldo: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
                <p>Adjunto encontrarás el archivo ZIP con los datos exportados a Excel.</p>
                <p>Por favor, guarden este archivo en un lugar seguro.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = [
                {
                    filename: backupFileName,
                    content: zipBuffer,
                    contentType: 'application/zip'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (emailSent) {
                console.log('DEBUG_BACKUP_CRON: Respaldo de base de datos enviado por correo exitosamente.');
            } else {
                console.error('ERROR_BACKUP_CRON: Fallo al enviar el correo de respaldo de base de datos.');
            }
        } else {
            console.warn('DEBUG_BACKUP_CRON: No hay correos de administrador configurados para enviar el respaldo de la base de datos.');
        }
    } catch (error) {
        console.error('ERROR_BACKUP_CRON: Error durante el cron job de respaldo automático de la base de datos:', error.message);
    }
}

cron.schedule('*/55 * * * *', dailyDatabaseBackupCronJob, {
    timezone: CARACAS_TIMEZONE
});


// Cron jobs para la limpieza de datos antiguos
cron.schedule('0 3 * * *', async () => { // Cada día a las 03:00 AM
    console.log('CRON JOB: Ejecutando limpieza de datos antiguos.');
    await cleanOldSalesAndRaffleNumbers(30); // Eliminar ventas de más de 30 días
    await cleanOldDrawResults(60); // Eliminar resultados de más de 60 días
    await cleanOldPrizes(60); // Eliminar premios de más de 60 días
    await cleanOldWinners(60); // Eliminar ganadores de más de 60 días
    console.log('CRON JOB: Limpieza de datos antiguos finalizada.');
}, {
    timezone: CARACAS_TIMEZONE
});


// --- Funciones de limpieza de datos antiguos (adaptadas para DB) ---

/**
 * Elimina ventas antiguas de la base de datos y actualiza los números de rifa asociados.
 * @param {number} daysToRetain Días para retener las ventas (ej. 30 para retener 30 días, eliminar más antiguos).
 */
async function cleanOldSalesAndRaffleNumbers(daysToRetain = 30) {
    console.log(`INFO_CLEANUP: Iniciando limpieza de ventas y números de rifa anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO_CLEANUP: Fecha de corte para eliminación: ${cutoffDate}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Obtener IDs de ventas antiguas
        const oldSalesRes = await client.query('SELECT id, numbers FROM ventas WHERE "purchaseDate"::date < $1', [cutoffDate]);
        const oldSales = oldSalesRes.rows;

        console.log(`INFO_CLEANUP: Encontradas ${oldSales.length} ventas antiguas para procesar.`);

        // Actualizar el estado 'comprado' de los números de rifa asociados a estas ventas antiguas
        const numbersToUpdate = new Set();
        oldSales.forEach(sale => {
            // Asegurarse de que sale.numbers sea un array (viene de JSONB)
            const saleNumbers = Array.isArray(sale.numbers) ? sale.numbers : JSON.parse(sale.numbers || '[]');
            saleNumbers.forEach(num => numbersToUpdate.add(num));
        });

        if (numbersToUpdate.size > 0) {
            console.log(`INFO_CLEANUP: Procesando ${numbersToUpdate.size} números de rifa para posible actualización.`);
            await client.query(
                'UPDATE numeros SET comprado = FALSE, "originalDrawNumber" = NULL WHERE numero = ANY($1::text[])', // Added quotes for consistency
                [Array.from(numbersToUpdate)]
            );
            console.log('INFO_CLEANUP: Números de rifa asociados a ventas antiguas actualizados (comprado: false).');
        } else {
            console.log('INFO_CLEANUP: No hay números de rifa para actualizar de ventas antiguas.');
        }

        // Eliminar las ventas antiguas
        const deleteSalesRes = await client.query('DELETE FROM ventas WHERE "purchaseDate"::date < $1', [cutoffDate]);
        console.log(`INFO_CLEANUP: Total de ventas antiguas eliminadas: ${deleteSalesRes.rowCount}.`);

        await client.query('COMMIT');
        console.log('INFO_CLEANUP: Limpieza de ventas y números de rifa completada.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERROR_CLEANUP: Error durante la limpieza de ventas y números de rifa:', error.message);
    } finally {
        client.release();
    }
}

/**
 * Elimina documentos de resultados de sorteos antiguos.
 * @param {number} daysToRetain Días para retener los resultados (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldDrawResults(daysToRetain = 60) {
    console.log(`INFO_CLEANUP: Iniciando limpieza de resultados de sorteos anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO_CLEANUP: Fecha de corte para eliminación de resultados: ${cutoffDate}`);

    const client = await pool.connect();
    try {
        const deleteRes = await client.query('DELETE FROM resultados_zulia WHERE (data->>\'fecha\')::date < $1', [cutoffDate]);
        console.log(`INFO_CLEANUP: Total de resultados de sorteos antiguos eliminados: ${deleteRes.rowCount}.`);
    } catch (error) {
        console.error('ERROR_CLEANUP: Error durante la limpieza de resultados de sorteos:', error.message);
    } finally {
        client.release();
    }
}

/**
 * Elimina documentos de premios antiguos.
 * @param {number} daysToRetain Días para retener los premios (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldPrizes(daysToRetain = 60) {
    console.log(`INFO_CLEANUP: Iniciando limpieza de premios anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO_CLEANUP: Fecha de corte para eliminación de premios: ${cutoffDate}`);

    const client = await pool.connect();
    try {
        const deleteRes = await client.query('DELETE FROM premios WHERE (data->>\'fechaSorteo\')::date < $1', [cutoffDate]);
        console.log(`INFO_CLEANUP: Total de premios antiguos eliminados: ${deleteRes.rowCount}.`);
    } catch (error) {
        console.error('ERROR_CLEANUP: Error durante la limpieza de premios:', error.message);
    } finally {
        client.release();
    }
}

/**
 * Elimina documentos de ganadores antiguos.
 * @param {number} daysToRetain Días para retener los ganadores (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldWinners(daysToRetain = 60) {
    console.log(`INFO_CLEANUP: Iniciando limpieza de ganadores anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO_CLEANUP: Fecha de corte para eliminación de ganadores: ${cutoffDate}`);

    const client = await pool.connect();
    try {
        const deleteRes = await client.query('DELETE FROM ganadores WHERE (data->>\'drawDate\')::date < $1', [cutoffDate]);
        console.log(`INFO_CLEANUP: Total de ganadores antiguos eliminados: ${deleteRes.rowCount}.`);
    } catch (error) {
        console.error('ERROR_CLEANUP: Error durante la limpieza de ganadores:', error.message);
    } finally {
        client.release();
    }
}


// Inicialización del servidor
(async () => {
    try {
        console.log('DEBUG: Iniciando IIFE de inicialización del servidor.');
        await ensureDataAndComprobantesDirs(); // Asegurar directorios de archivos locales
        console.log('DEBUG: Directorios asegurados.');
        await ensureTablesExist(); // Asegurar que las tablas de la DB existan
        console.log('DEBUG: Tablas de la DB verificadas/creadas.');
        await loadInitialData(); // Cargar o inicializar datos desde la DB
        console.log('DEBUG: Datos iniciales cargados.');
        await configureMailer(); // Configurar el mailer después de cargar la configuración de DB
        console.log('DEBUG: Mailer configurado.');
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`URL Base de la API: ${API_BASE_URL}`);
        });
    } catch (error) {
        console.error('ERROR_CRITICO_INIT_SERVER: Error al iniciar el servidor:', error.message);
        process.exit(1); // Salir del proceso si hay un error crítico al inicio
    }
})();
