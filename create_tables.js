// create_tables.js

// Importa la librería 'pg' para interactuar con PostgreSQL
const { Pool } = require('pg');
// Importa 'dotenv' para cargar variables de entorno desde el archivo .env
require('dotenv').config();

// Configura el pool de conexiones a la base de datos
// La URL de la base de datos se obtiene de la variable de entorno DATABASE_URL
// que debe estar definida en tu archivo .env
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Es crucial para las conexiones a Render que el SSL sea configurado
    // para no rechazar certificados no autorizados, ya que Render usa SSL.
    ssl: {
        rejectUnauthorized: false
    }
});

// Definición de las sentencias SQL para crear las tablas
// Estas sentencias deben coincidir con el esquema que propusimos.
const createTableQueries = `
-- Tabla para horarios_zulia
CREATE TABLE IF NOT EXISTS horarios_zulia (
    id SERIAL PRIMARY KEY,
    hora VARCHAR(10) UNIQUE NOT NULL -- Añadido UNIQUE para permitir ON CONFLICT
);

-- Tabla para numeros
CREATE TABLE IF NOT EXISTS numeros (
    id SERIAL PRIMARY KEY,
    numero VARCHAR(3) UNIQUE NOT NULL,
    comprado BOOLEAN DEFAULT FALSE
);

-- Tabla para configuracion
-- Nota: Los campos que eran objetos o arrays en JSON se almacenan como JSONB
CREATE TABLE IF NOT EXISTS configuracion (
    id SERIAL PRIMARY KEY,
    pagina_bloqueada BOOLEAN DEFAULT FALSE,
    fecha_sorteo VARCHAR(50),
    precio_ticket NUMERIC(10, 2),
    numero_sorteo_correlativo INTEGER,
    ultimo_numero_ticket INTEGER,
    ultima_fecha_resultados_zulia TIMESTAMP,
    tasa_dolar JSONB,
    admin_whatsapp_numbers JSONB,
    admin_email_for_reports JSONB,
    mail_config_host VARCHAR(255),
    mail_config_port INTEGER,
    mail_config_secure BOOLEAN,
    mail_config_user VARCHAR(255),
    mail_config_pass VARCHAR(255),
    mail_config_sender_name VARCHAR(255)
);

-- Tabla para comprobantes
CREATE TABLE IF NOT EXISTS comprobantes (
    id SERIAL PRIMARY KEY,
    comprador VARCHAR(255),
    telefono VARCHAR(50),
    comprobante_nombre VARCHAR(255),
    comprobante_tipo VARCHAR(100),
    fecha_compra DATE
);

-- Tablas genéricas para archivos JSON que estaban vacíos
-- Se usa JSONB para almacenar la estructura completa cuando haya datos
CREATE TABLE IF NOT EXISTS ganadores (
    id SERIAL PRIMARY KEY,
    data JSONB
);

CREATE TABLE IF NOT EXISTS premios (
    id SERIAL PRIMARY KEY,
    data JSONB
);

CREATE TABLE IF NOT EXISTS resultados_zulia (
    id SERIAL PRIMARY KEY,
    data JSONB
);

CREATE TABLE IF NOT EXISTS ventas (
    id SERIAL PRIMARY KEY,
    data JSONB
);
`;

/**
 * Función asíncrona para ejecutar las sentencias SQL de creación de tablas.
 */
async function createTables() {
    let client;
    try {
        // Conecta un cliente del pool a la base de datos
        client = await pool.connect();
        console.log('Conectado a la base de datos PostgreSQL de Render.');

        // Ejecuta todas las sentencias SQL
        await client.query(createTableQueries);
        console.log('¡Tablas creadas o ya existentes en la base de datos!');
    } catch (err) {
        // Captura y muestra cualquier error que ocurra durante la ejecución
        console.error('Error al crear las tablas:', err);
    } finally {
        // Asegura que el cliente se libere de vuelta al pool, incluso si hay un error
        if (client) {
            client.release();
            console.log('Cliente de base de datos liberado.');
        }
        // Cierra el pool de conexiones después de que todas las operaciones han terminado
        await pool.end();
        console.log('Pool de conexiones de base de datos cerrado.');
    }
}

// Llama a la función para crear las tablas
createTables();
