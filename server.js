const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx'); // Importar la librería xlsx

const app = express();
const port = process.env.PORT || 3000;

// --- Conexión a la Base de Datos (COMENTADA) ---
// const { Pool } = require('pg');
// const pool = new Pool({
//     host: 'dpg-d0jugcd6ubrc73aqep00-a',
//     user: 'rifas_db_g8n7_user',
//     database: 'rifas_db_g8n7',
//     password: 'txgZtB4MwLCawXZ14tIjp5w9NqOzar8w',
//     port: 5432,
// });
//
// pool.on('error', (err, client) => {
//     console.error('Error inesperado en cliente idle', err);
//     process.exit(-1);
// });
// --- FIN Conexión a la Base de Datos (COMENTADA) ---

// Configura CORS
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app'           // Tu panel de cliente
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(fileUpload());

const CONFIG_FILE_PATH = path.join(__dirname, 'configuracion.json');
const HORARIOS_FILE_PATH = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE_PATH = path.join(__dirname, 'ventas.json');
const COMPROBANTES_FILE_PATH = path.join(__dirname, 'comprobantes.json');

async function leerConfiguracion() {
    try {
        const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
        const config = JSON.parse(data);
        if (config.precio_ticket === undefined) config.precio_ticket = 1.00;
        if (config.tasa_dolar === undefined) config.tasa_dolar = 0;
        if (config.pagina_bloqueada === undefined) config.pagina_bloqueada = false;
        if (config.fecha_sorteo === undefined) config.fecha_sorteo = null;
        return config;
    } catch (error) {
        console.error('Error al leer la configuración, usando valores por defecto:', error.message);
        return { tasa_dolar: 0, pagina_bloqueada: false, fecha_sorteo: null, precio_ticket: 1.00 };
    }
}

async function guardarConfiguracion(config) {
    try {
        if (typeof config.precio_ticket !== 'number' || isNaN(config.precio_ticket) || config.precio_ticket < 0) {
            console.warn('Intento de guardar un precio de ticket inválido. Usando el valor actual o por defecto.');
            const currentConfig = await leerConfiguracion();
            config.precio_ticket = currentConfig.precio_ticket || 1.00;
        }
        await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('Configuración guardada exitosamente.');
        return true;
    } catch (error) {
        console.error('Error al guardar la configuración:', error);
        return false;
    }
}

async function leerHorariosZulia() {
    try {
        const data = await fs.readFile(HORARIOS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error al leer los horarios del Zulia:', error);
        return { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] };
    }
}

async function guardarHorariosZulia(horarios) {
    try {
        await fs.writeFile(HORARIOS_FILE_PATH, JSON.stringify(horarios, null, 2), 'utf8');
        console.log('Horarios del Zulia guardados exitosamente.');
        return true;
    } catch (error) {
        console.error('Error al guardar los horarios del Zulia:', error);
        return false;
    }
}

app.get('/api/admin/configuracion', async (req, res) => {
    const config = await leerConfiguracion();
    res.json(config);
});

app.put('/api/admin/configuracion', async (req, res) => {
    const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket } = req.body;
    const config = await leerConfiguracion();
    config.tasa_dolar = tasa_dolar !== undefined ? parseFloat(tasa_dolar) : config.tasa_dolar;
    config.pagina_bloqueada = pagina_bloqueada !== undefined ? Boolean(pagina_bloqueada) : config.pagina_bloqueada;
    config.fecha_sorteo = fecha_sorteo !== undefined ? fecha_sorteo : config.fecha_sorteo;
    if (precio_ticket !== undefined) {
        const parsedPrice = parseFloat(precio_ticket);
        if (!isNaN(parsedPrice) && parsedPrice >= 0) {
            config.precio_ticket = parsedPrice;
        } else {
            console.warn('Valor de precio_ticket recibido inválido:', precio_ticket);
        }
    }
    if (await guardarConfiguracion(config)) {
        res.json({ message: 'Configuración actualizada exitosamente' });
    } else {
        res.status(500).json({ error: 'Error al guardar la configuración' });
    }
});

app.get('/api/admin/horarios-zulia', async (req, res) => {
    const horarios = await leerHorariosZulia();
    res.json(horarios);
});

app.put('/api/admin/horarios-zulia', async (req, res) => {
    const { horarios_zulia } = req.body;
    if (Array.isArray(horarios_zulia)) {
        if (await guardarHorariosZulia({ horarios_zulia })) {
            res.json({ message: 'Horarios del Zulia actualizados exitosamente' });
        } else {
            res.status(500).json({ error: 'Error al guardar los horarios del Zulia' });
        }
    } else {
        res.status(400).json({ error: 'El formato de los horarios debe ser un array.' });
    }
});

// --- Rutas de Usuarios (Sin cambios) ---
app.post('/api/admin/usuarios', async (req, res) => { /* ... */ });
app.get('/api/admin/usuarios', async (req, res) => { /* ... */ });
app.get('/api/admin/usuarios/:id', async (req, res) => { /* ... */ });
app.put('/api/admin/usuarios/:id', async (req, res) => { /* ... */ });
app.delete('/api/admin/usuarios/:id', async (req, res) => { /* ... */ });
// --- Fin Rutas de Usuarios ---

// --- Rutas de Rifas (Sin cambios importantes en la lógica) ---
app.get('/api/admin/rifas', async (req, res) => { /* ... */ });
app.get('/api/admin/rifas/:id', async (req, res) => { /* ... */ });
app.post('/api/admin/rifas', async (req, res) => { /* ... */ });
app.put('/api/admin/rifas/:id', async (req, res) => { /* ... */ });
app.delete('/api/admin/rifas/:id', async (req, res) => { /* ... */ });
// --- Fin Rutas de Rifas ---

// --- Ruta de Compra (Sin cambios) ---
app.post('/api/compras', async (req, res) => { /* ... */ });
// --- Fin Ruta de Compra ---

// --- Nuevas Rutas para Gestión de Ventas (MODIFICADAS PARA ARCHIVOS) ---

// API para obtener la lista de todas las ventas (SIN comprobantes)
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
        const ventas = JSON.parse(data);
        res.json(ventas);
    } catch (error) {
        console.error('Error al leer el archivo de ventas:', error);
        res.status(500).json({ error: 'Error al obtener la lista de ventas desde el archivo.' });
    }
});

// API para exportar la lista de todas las ventas a Excel
app.get('/api/admin/ventas/exportar-excel', async (req, res) => {
    try {
        const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
        const ventas = JSON.parse(data);
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(ventas);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Ventas');
        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="ventas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(excelBuffer);

    } catch (error) {
        console.error('Error al leer el archivo de ventas para exportar:', error);
        res.status(500).json({ error: 'Error al exportar la lista de ventas a Excel.' });
    }
});

// API para obtener la lista de comprobantes adjuntados
app.get('/api/admin/comprobantes', async (req, res) => {
    try {
        const data = await fs.readFile(COMPROBANTES_FILE_PATH, 'utf8');
        const comprobantes = JSON.parse(data);
        res.json(comprobantes); // SIMPLIFICADO: Envía todo el array sin filtrar
    } catch (error) {
        console.error('Error al leer el archivo de comprobantes:', error);
        res.status(500).json({ error: 'Error al obtener la lista de comprobantes desde el archivo.' });
    }
});

// --- Fin Nuevas Rutas para Gestión de Ventas ---

app.get('/', (req, res) => {
    res.send('¡Hola desde el backend de tu proyecto de Rifas y Loterias!');
});

app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

process.on('SIGINT', () => {
    console.log('Servidor cerrado.');
    process.exit(0);
});