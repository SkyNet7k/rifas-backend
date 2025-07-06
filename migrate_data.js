// migrate_data.js

const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

// Configuración del pool de conexiones a la base de datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Rutas a tus archivos JSON
const jsonFiles = {
    horarios_zulia: path.join(__dirname, 'horarios_zulia.json'),
    numeros: path.join(__dirname, 'numeros.json'),
    configuracion: path.join(__dirname, 'configuracion.json'),
    comprobantes: path.join(__dirname, 'comprobantes.json'),
    ganadores: path.join(__dirname, 'ganadores.json'),
    premios: path.join(__dirname, 'premios.json'),
    resultados_zulia: path.join(__dirname, 'resultados_zulia.json'),
    ventas: path.join(__dirname, 'ventas.json')
};

/**
 * Lee un archivo JSON y parsear su contenido.
 * @param {string} filePath - La ruta al archivo JSON.
 * @returns {Promise<object|Array>} El contenido parseado del JSON.
 */
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Advertencia: El archivo ${filePath} no fue encontrado. Se asumirá un array/objeto vacío.`);
            // Dependiendo del archivo, devuelve un array o un objeto vacío
            // Para los que sabemos que son arrays de objetos, devolvemos un array vacío.
            // Para configuracion.json que es un objeto, devolveríamos un objeto vacío.
            if (filePath.includes('configuracion.json') || filePath.includes('premios.json')) {
                return {};
            }
            return [];
        }
        console.error(`Error al leer o parsear ${filePath}:`, error);
        throw error;
    }
}

/**
 * Migra los datos de horarios_zulia.json a la tabla horarios_zulia.
 */
async function migrateHorariosZulia(client) {
    console.log('Migrando horarios_zulia...');
    const data = await readJsonFile(jsonFiles.horarios_zulia);
    if (data && data.zulia && Array.isArray(data.zulia)) {
        for (const hora of data.zulia) {
            try {
                // Se asume que la tabla horarios_zulia tiene una restricción UNIQUE en la columna 'hora'
                await client.query('INSERT INTO horarios_zulia (hora) VALUES ($1) ON CONFLICT (hora) DO NOTHING', [hora]);
            } catch (error) {
                console.error(`Error al insertar hora ${hora}:`, error);
            }
        }
        console.log('Migración de horarios_zulia completada.');
    } else {
        console.log('No hay datos válidos en horarios_zulia.json para migrar.');
    }
}

/**
 * Migra los datos de numeros.json a la tabla numeros.
 */
async function migrateNumeros(client) {
    console.log('Migrando numeros...');
    const data = await readJsonFile(jsonFiles.numeros);
    if (Array.isArray(data)) {
        console.log(`Iniciando inserción de ${data.length} números...`);
        for (let i = 0; i < data.length; i++) {
            const item = data[i];
            try {
                await client.query('INSERT INTO numeros (numero, comprado) VALUES ($1, $2) ON CONFLICT (numero) DO NOTHING', [item.numero, item.comprado]);
                if ((i + 1) % 100 === 0) { // Log cada 100 números
                    console.log(`Insertados ${i + 1} números.`);
                }
            } catch (error) {
                console.error(`Error al insertar numero ${item.numero} (índice ${i}):`, error);
                // Si hay un error, podemos decidir si queremos detener la migración o continuar.
                // Por ahora, solo logueamos el error y continuamos.
            }
        }
        console.log('Migración de numeros completada.');
    } else {
        console.log('No hay datos válidos en numeros.json para migrar.');
    }
}

/**
 * Migra los datos de configuracion.json a la tabla configuracion.
 * Se asume que solo habrá una fila de configuración.
 */
async function migrateConfiguracion(client) {
    console.log('Migrando configuracion...');
    const config = await readJsonFile(jsonFiles.configuracion);
    if (Object.keys(config).length > 0) {
        // Eliminar cualquier configuración existente antes de insertar la nueva
        await client.query('TRUNCATE TABLE configuracion RESTART IDENTITY;');

        const query = `
            INSERT INTO configuracion (
                pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo,
                ultimo_numero_ticket, ultima_fecha_resultados_zulia, tasa_dolar,
                admin_whatsapp_numbers, admin_email_for_reports,
                mail_config_host, mail_config_port, mail_config_secure,
                mail_config_user, mail_config_pass, mail_config_sender_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `;
        const values = [
            config.pagina_bloqueada || false,
            config.fecha_sorteo || null,
            config.precio_ticket || 0.00,
            config.numero_sorteo_correlativo || 0,
            config.ultimo_numero_ticket || 0,
            config.ultima_fecha_resultados_zulia ? new Date(config.ultima_fecha_resultados_zulia) : null,
            // Convertir arrays a strings JSON válidos para columnas JSONB
            JSON.stringify(config.tasa_dolar || []),
            JSON.stringify(config.admin_whatsapp_numbers || []),
            JSON.stringify(config.admin_email_for_reports || []),
            config.mail_config ? config.mail_config.host : null,
            config.mail_config ? config.mail_config.port : null,
            config.mail_config ? config.mail_config.secure : false,
            config.mail_config ? config.mail_config.user : null,
            config.mail_config ? config.mail_config.pass : null,
            config.mail_config ? config.mail_config.senderName : null
        ];

        try {
            await client.query(query, values);
            console.log('Migración de configuracion completada.');
        } catch (error) {
            console.error('Error al insertar configuración:', error);
        }
    } else {
        console.log('No hay datos válidos en configuracion.json para migrar.');
    }
}

/**
 * Migra los datos de comprobantes.json a la tabla comprobantes.
 */
async function migrateComprobantes(client) {
    console.log('Migrando comprobantes...');
    const data = await readJsonFile(jsonFiles.comprobantes);
    if (Array.isArray(data) && data.length > 0) {
        for (const item of data) {
            try {
                const query = `
                    INSERT INTO comprobantes (id, comprador, telefono, comprobante_nombre, comprobante_tipo, fecha_compra)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id) DO UPDATE SET
                        comprador = EXCLUDED.comprador,
                        telefono = EXCLUDED.telefono,
                        comprobante_nombre = EXCLUDED.comprobante_nombre,
                        comprobante_tipo = EXCLUDED.comprobante_tipo,
                        fecha_compra = EXCLUDED.fecha_compra;
                `;
                const values = [
                    item.id,
                    item.comprador,
                    item.telefono,
                    item.comprobante_nombre,
                    item.comprobante_tipo,
                    item.fecha_compra ? new Date(item.fecha_compra) : null // Convertir a objeto Date
                ];
                await client.query(query, values);
            } catch (error) {
                console.error(`Error al insertar comprobante con ID ${item.id}:`, error);
            }
        }
        console.log('Migración de comprobantes completada.');
    } else {
        console.log('No hay datos válidos en comprobantes.json para migrar.');
    }
}

/**
 * Migra los datos de los archivos JSON vacíos (ganadores, premios, resultados_zulia, ventas)
 * a sus respectivas tablas, almacenando el contenido JSON completo en la columna 'data' (JSONB).
 */
async function migrateEmptyJsonFiles(client, fileName, tableName) {
    console.log(`Migrando ${fileName}...`);
    const filePath = jsonFiles[fileName];
    const data = await readJsonFile(filePath);

    // Si el JSON estaba vacío o no tiene datos, no hacemos nada o insertamos un objeto vacío si es el caso
    if (Object.keys(data).length === 0 && !Array.isArray(data) && Object.keys(data).length === 0) {
        console.log(`El archivo ${fileName} está vacío. No se migrarán datos.`);
        return;
    }

    // Para evitar duplicados si se corre varias veces y los IDs no son secuenciales o manejados.
    // Una estrategia simple es TRUNCATE, pero si hay datos existentes que no vienen de JSON, sería problemático.
    // Para una migración inicial, TRUNCATE es aceptable si la DB está vacía.
    // await client.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY;`);

    if (Array.isArray(data)) {
        for (const item of data) {
            try {
                // Asumiendo que estos JSONs vacíos eventualmente tendrán una estructura con un 'id' o similar
                // Por ahora, insertamos el objeto completo como JSONB
                await client.query(`INSERT INTO ${tableName} (data) VALUES ($1)`, [item]);
            } catch (error) {
                console.error(`Error al insertar item en ${tableName} desde ${fileName}:`, error);
            }
        }
    } else {
        // Si es un objeto singular (como premios.json podría ser)
        try {
            await client.query(`INSERT INTO ${tableName} (data) VALUES ($1)`, [data]);
        } catch (error) {
            console.error(`Error al insertar objeto en ${tableName} desde ${fileName}:`, error);
        }
    }
    console.log(`Migración de ${fileName} completada.`);
}


/**
 * Función principal para ejecutar todas las migraciones.
 */
async function runMigrations() {
    let client;
    try {
        client = await pool.connect();
        console.log('Conectado a la base de datos PostgreSQL para migración de datos.');

        // Ejecutar migraciones en orden
        await migrateHorariosZulia(client);
        await migrateNumeros(client);
        await migrateConfiguracion(client);
        await migrateComprobantes(client);

        // Migrar los archivos JSON que estaban vacíos
        await migrateEmptyJsonFiles(client, 'ganadores', 'ganadores');
        await migrateEmptyJsonFiles(client, 'premios', 'premios');
        await migrateEmptyJsonFiles(client, 'resultados_zulia', 'resultados_zulia');
        await migrateEmptyJsonFiles(client, 'ventas', 'ventas');

        console.log('¡Todas las migraciones de datos completadas!');
    } catch (err) {
        console.error('Error durante la migración de datos:', err);
    } finally {
        if (client) {
            client.release();
            console.log('Cliente de base de datos liberado.');
        }
        await pool.end();
        console.log('Pool de conexiones de base de datos cerrado.');
    }
}

// Ejecuta la función principal de migraciones
runMigrations();
