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
        console.log('Contenido de ventas para exportar:', ventas); // <-- Agrega esta línea
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

// API para registrar una nueva venta
app.post('/api/ventas', async (req, res) => {
    try {
        const nuevaVenta = req.body; // Los datos de la nueva venta vendrán en el cuerpo de la solicitud (req.body)

        // Leer el contenido actual del archivo ventas.json
        const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
        const ventas = JSON.parse(data);

        // Agregar la nueva venta al array
        ventas.push(nuevaVenta);

        // Escribir el array actualizado de vuelta a ventas.json
        await fs.writeFile(VENTAS_FILE_PATH, JSON.stringify(ventas, null, 2), 'utf8');

        res.status(201).json({ message: 'Venta registrada exitosamente', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Error al registrar la venta.' });
    }
});

// API para obtener la lista de comprobantes adjuntados
app.get('/api/admin/comprobantes', async (req, res) => {
    const filePath = path.join(__dirname, 'comprobantes.json');
    console.log('Intentando leer el archivo de comprobantes en:', filePath);
    try {
        const data = await fs.readFile(filePath, 'utf8');
        const comprobantes = JSON.parse(data);
        res.json(comprobantes); // Envía todo el array sin filtrar
    } catch (error) {
        console.error('Error al leer el archivo de comprobantes:', error);
        res.status(500).json({ error: 'Error al obtener la lista de comprobantes desde el archivo.' });
    }
});

// API para cargar y registrar comprobantes
app.post('/api/comprobantes', async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ error: 'No se encontraron archivos para subir.' });
        }

        const comprobante = req.files.comprobante; // Asumimos que el archivo se envía con el nombre de campo "comprobante"
        const { ventaId } = req.body; // Puedes enviar información adicional como el ID de la venta

        // Validar el tipo y tamaño del archivo si es necesario
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!allowedMimeTypes.includes(comprobante.mimetype)) {
            return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
        }

        const maxSize = 5 * 1024 * 1024; // 5MB
        if (comprobante.size > maxSize) {
            return res.status(400).json({ error: 'El archivo es demasiado grande.' });
        }

        // Generar un nombre de archivo único (puedes usar UUID o una combinación de timestamp y nombre original)
        const nombreArchivo = `${Date.now()}-${comprobante.name}`;
        const rutaAlmacenamiento = path.join(__dirname, 'uploads', nombreArchivo); // Define una carpeta 'uploads' para guardar los archivos

        // Mover el archivo subido a la carpeta de almacenamiento
        await comprobante.mv(rutaAlmacenamiento);

        // Leer el contenido actual del archivo comprobantes.json
        const data = await fs.readFile(COMPROBANTES_FILE_PATH, 'utf8');
        const comprobantes = JSON.parse(data);

        // Crear un nuevo objeto de comprobante para almacenar en el archivo JSON
        const nuevoComprobante = {
            id: Date.now(), // Generar un ID simple basado en timestamp
            ventaId: ventaId,
            comprobante_nombre: nombreArchivo,
            comprobante_tipo: comprobante.mimetype,
            fecha_carga: new Date().toISOString()
            // Puedes agregar más información relevante aquí
        };

        // Agregar el nuevo comprobante al array
        comprobantes.push(nuevoComprobante);

        // Escribir el array actualizado de vuelta a comprobantes.json
        await fs.writeFile(COMPROBANTES_FILE_PATH, JSON.stringify(comprobantes, null, 2), 'utf8');

        res.status(201).json({ message: 'Comprobante cargado exitosamente', comprobante: nuevoComprobante });

    } catch (error) {
        console.error('Error al cargar el comprobante:', error);
        res.status(500).json({ error: 'Error al cargar el comprobante.' });
    }
});

// --- Fin Nuevas Rutas para Gestión de Ventas ---

// --- Ruta de Compra (Sin cambios) ---
app.post('/api/compras', async (req, res) => { /* ... */ });
// --- Fin Ruta de Compra ---


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