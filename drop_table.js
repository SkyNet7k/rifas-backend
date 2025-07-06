// drop_table.js

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function dropHorariosZuliaTable() {
    let client;
    try {
        client = await pool.connect();
        console.log('Conectado a la base de datos PostgreSQL de Render para eliminar tabla.');

        // Sentencia SQL para eliminar la tabla horarios_zulia si existe
        const dropQuery = `DROP TABLE IF EXISTS horarios_zulia;`;
        await client.query(dropQuery);
        console.log('Tabla horarios_zulia eliminada (si existía).');
    } catch (err) {
        console.error('Error al eliminar la tabla horarios_zulia:', err);
    } finally {
        if (client) {
            client.release();
            console.log('Cliente de base de datos liberado.');
        }
        await pool.end();
        console.log('Pool de conexiones de base de datos cerrado.');
    }
}

dropHorariosZuliaTable();
