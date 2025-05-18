const express = require('express');
const { Pool } = require('pg');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// --- Conexión a la Base de Datos ---
const pool = new Pool({
    // connectionString: process.env.DATABASE_URL, // Asegúrate de que esta variable de entorno esté configurada en Render
    // O si prefieres usar credenciales directas para desarrollo:
    host: 'dpg-d0jugcd6ubrc73aqep00-a',
    user: 'rifas_db_g8n7_user',
    database: 'rifas_db_g8n7',
    password: 'txgZtB4MwLCawXZ14tIjp5w9NqOzar8w',
    port: 5432,
});

pool.on('error', (err, client) => {
    console.error('Error inesperado en cliente idle', err);
    process.exit(-1);
});
// --- FIN Conexión a la Base de Datos ---

// Configura CORS
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app'     // Tu panel de cliente
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

// --- Modificación para incluir precio_ticket en la configuración ---
async function leerConfiguracion() {
    try {
        const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
        const config = JSON.parse(data);
        // Asegurar que el campo precio_ticket exista, con un valor por defecto si no
        if (config.precio_ticket === undefined) {
            config.precio_ticket = 1.00; // Valor por defecto global
        }
        // Asegurar que los otros campos por defecto existan si el archivo está vacío o corrupto
        if (config.tasa_dolar === undefined) config.tasa_dolar = 0;
        if (config.pagina_bloqueada === undefined) config.pagina_bloqueada = false;
        if (config.fecha_sorteo === undefined) config.fecha_sorteo = null;

        return config;
    } catch (error) {
        console.error('Error al leer la configuración, usando valores por defecto:', error.message);
        // Retorna todos los valores por defecto si hay un error
        return {
            tasa_dolar: 0,
            pagina_bloqueada: false,
            fecha_sorteo: null,
            precio_ticket: 1.00 // Valor por defecto global
        };
    }
}

async function guardarConfiguracion(config) {
    try {
        // Asegurar que el precio sea un número válido antes de guardar
        if (typeof config.precio_ticket !== 'number' || isNaN(config.precio_ticket) || config.precio_ticket < 0) {
            console.warn('Intento de guardar un precio de ticket inválido. Usando el valor actual o por defecto.');
            const currentConfig = await leerConfiguracion(); // Leer para obtener el valor actual si es inválido
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

// Las funciones leerHorariosZulia y guardarHorariosZulia no necesitan cambios.
async function leerHorariosZulia() {
    try {
        const data = await fs.readFile(HORARIOS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error al leer los horarios del Zulia:', error);
        return { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] }; // Valores por defecto
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
// --- Fin funciones Horarios Zulia ---


// --- Modificación de rutas de configuración para incluir precio_ticket ---
app.get('/api/admin/configuracion', async (req, res) => {
    const config = await leerConfiguracion();
    // Ahora el objeto config ya incluye precio_ticket, tasa_dolar, etc.
    res.json(config);
});

app.put('/api/admin/configuracion', async (req, res) => {
    // Incluir precio_ticket en la desestructuración del body
    const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket } = req.body;
    const config = await leerConfiguracion();

    // Actualizar los campos si están definidos en el body
    config.tasa_dolar = tasa_dolar !== undefined ? parseFloat(tasa_dolar) : config.tasa_dolar;
    config.pagina_bloqueada = pagina_bloqueada !== undefined ? Boolean(pagina_bloqueada) : config.pagina_bloqueada;
    config.fecha_sorteo = fecha_sorteo !== undefined ? fecha_sorteo : config.fecha_sorteo;

    // *** VALIDACIÓN Y ACTUALIZACIÓN DEL NUEVO CAMPO precio_ticket ***
    if (precio_ticket !== undefined) {
        const parsedPrice = parseFloat(precio_ticket);
        if (!isNaN(parsedPrice) && parsedPrice >= 0) { // Validar que sea un número positivo o cero
            config.precio_ticket = parsedPrice;
        } else {
            console.warn('Valor de precio_ticket recibido inválido:', precio_ticket);
            // Opcional: Enviar un error al frontend si el valor es inválido
            // return res.status(400).json({ error: 'El precio del ticket debe ser un número positivo.' });
           // Continuar con el valor actual si el recibido es inválido
        }
    }
    // --- FIN VALIDACIÓN ---


    if (await guardarConfiguracion(config)) {
        res.json({ message: 'Configuración actualizada exitosamente' });
    } else {
        res.status(500).json({ error: 'Error al guardar la configuración' });
    }
});
// --- Fin rutas configuración ---


// --- Rutas Horarios Zulia (sin cambios necesarios) ---
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
// --- Fin rutas Horarios Zulia ---


// --- Rutas de Usuarios (No requieren cambios por ahora) ---
// ... (Mantener las rutas de usuarios: GET, POST, PUT, DELETE) ...
// API para crear un nuevo usuario
app.post('/api/admin/usuarios', async (req, res) => {
    const { nombre, apellido, email, contrasena, telefono, rol } = req.body;
    // ... (código existente) ...
});
// API para obtener la lista de todos los usuarios
app.get('/api/admin/usuarios', async (req, res) => {
    // ... (código existente) ...
});
// API para obtener los detalles de un usuario por su ID
app.get('/api/admin/usuarios/:id', async (req, res) => {
    // ... (código existente) ...
});
// API para actualizar la información de un usuario existente por su ID
app.put('/api/admin/usuarios/:id', async (req, res) => {
    // ... (código existente) ...
});
// API para eliminar un usuario por su ID
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    // ... (código existente) ...
});
// --- Fin Rutas de Usuarios ---


// --- Rutas de Rifas (Consideraciones sobre precio_ticket) ---
// API para obtener la lista de todas las rifas
app.get('/api/admin/rifas', async (req, res) => {
    try {
        // Nota: Esta consulta aún trae 'precio_ticket' de la BD.
        // Si el precio global es el que prevalece, este campo de BD es redundante
        // y podrías considerarlo para eliminarlo de la tabla 'rifas'.
        // Por ahora, la ruta lo sigue trayendo, pero la lógica de compra NO lo usará.
        const result = await pool.query('SELECT id, nombre, descripcion, precio_ticket, cantidad_tickets, tickets_vendidos, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado FROM rifas');
        res.json(result.rows);
    } catch (err) {
        console.error('Error al obtener la lista de rifas', err);
        res.status(500).json({ error: 'Error al obtener la lista de rifas' });
    }
});

// API para obtener los detalles de una rifa por su ID
app.get('/api/admin/rifas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Igualmente, esta consulta trae 'precio_ticket' de la BD.
        const result = await pool.query('SELECT * FROM rifas WHERE id = $1', [id]);
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ error: `No se encontró la rifa con ID ${id}` });
        }
    } catch (err) {
        console.error(`Error al obtener la rifa con ID ${id}`, err);
        res.status(500).json({ error: `Error al obtener la rifa con ID ${id}` });
    }
});

// API para crear una nueva rifa
app.post('/api/admin/rifas', async (req, res) => {
    // Eliminamos precio_ticket del body que se espera, ya que ahora es global
    const { nombre, descripcion, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio } = req.body;
    try {
        // NOTA IMPORTANTE: La tabla 'rifas' probablemente tiene una columna 'precio_ticket'.
        // Con esta modificación, ese campo en la BD quedará sin usar o deberá ser eliminado.
        // Esta consulta SQL ya NO inserta el precio_ticket que venía en el body.
        const result = await pool.query(
            'INSERT INTO rifas (nombre, descripcion, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [nombre, descripcion, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio]
        );
        const response = { message: 'Rifa creada exitosamente', id: result.rows[0].id };
        console.log('Respuesta POST /api/admin/rifas:', response);
        res.status(201).json(response);
    } catch (err) {
        console.error('Error al crear la rifa', err);
        res.status(500).json({ error: 'Error al crear la rifa' });
    }
});

// API para actualizar los detalles de una rifa existente por su ID
app.put('/api/admin/rifas/:id', async (req, res) => {
    const { id } = req.params;
    // Eliminamos precio_ticket del body que se espera
    const { nombre, descripcion, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado, numero_ganador } = req.body;
    try {
        // Esta consulta SQL ya NO actualiza el campo 'precio_ticket' en la BD.
        const result = await pool.query(
            'UPDATE rifas SET nombre = $1, descripcion = $2, cantidad_tickets = $3, fecha_inicio = $4, fecha_fin = $5, fecha_sorteo = $6, premio = $7, imagen_premio = $8, estado = $9, numero_ganador = $10 WHERE id = $11',
            [nombre, descripcion, cantidad_tickets, fecha_inicio, fecha_fin, fecha_sorteo, premio, imagen_premio, estado, numero_ganador, id]
        );
        if (result.rowCount > 0) {
            const response = { message: 'Rifa actualizada exitosamente' };
            console.log('Respuesta PUT /api/admin/rifas/:id:', response);
            res.json(response);
        } else {
            res.status(404).json({ error: `No se encontró la rifa con ID ${id}` });
        }
    } catch (err) {
        console.error(`Error al actualizar la rifa con ID ${id}`, err);
        res.status(500).json({ error: `Error al actualizar la rifa con ID ${id}` });
    }
});

// API para eliminar una rifa por su ID (sin cambios necesarios)
app.delete('/api/admin/rifas/:id', async (req, res) => {
    const { id } = req.params;
    // ... (código existente) ...
});
// --- Fin Rutas de Rifas ---


// --- Modificación CRUCIAL en la ruta de compra para usar el precio global ---
// API para registrar una nueva compra
app.post('/api/compras', async (req, res) => {
    // Ahora esperamos solo los números seleccionados, comprador, telefono, fechaCompra, fechaSorteo, y el comprobante
    // Eliminamos valorTotalUsd, valorTotalBs, tasaAplicada del body esperado, ya que los calcularemos aquí.
    const { numeros, comprador, telefono, fechaCompra, fechaSorteo } = req.body;
    const comprobante = req.files && req.files.comprobante; // Acceder al archivo adjunto

    if (!numeros || numeros.length === 0 || !comprador || !telefono || !comprobante) {
        return res.status(400).json({ error: 'Faltan datos obligatorios para la compra (números, comprador, teléfono, comprobante).' });
    }

    try {
        // *** 1. Leer la configuración global para obtener el precio del ticket y la tasa de dólar ***
        const config = await leerConfiguracion();
        const precioTicketUsd = config.precio_ticket;
        const tasaDolar = config.tasa_dolar;

        if (!precioTicketUsd || precioTicketUsd <= 0 || !tasaDolar || tasaDolar <= 0) {
            // Manejar caso donde la configuración no está completa o válida
            console.error('Configuración de precio de ticket o tasa de dólar inválida.');
            return res.status(500).json({ error: 'Error en la configuración del sistema para procesar la compra.' });
        }

        // *** 2. Calcular el valor total basado en el precio global y la cantidad de números ***
        const cantidadNumeros = numeros.length;
        const valorTotalUsdCalculado = cantidadNumeros * precioTicketUsd;
        const valorTotalBsCalculado = valorTotalUsdCalculado * tasaDolar; // Calcular en Bs

        // 3. Guardar la información de la compra en la base de datos (usando los valores CALCULADOS)
        const resultCompra = await pool.query(
            'INSERT INTO compras (comprador, telefono, numeros_seleccionados, valor_usd, valor_bs, tasa_aplicada, fecha_compra, fecha_sorteo, comprobante_nombre, comprobante_tipo, comprobante_datos) VALUES ($1, $2,$3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
            [comprador, telefono, JSON.stringify(numeros), valorTotalUsdCalculado, valorTotalBsCalculado, tasaDolar, fechaCompra, fechaSorteo, comprobante.name, comprobante.mimetype, comprobante.data]
        );
        const compraId = resultCompra.rows[0].id;

        // 4. (Opcional) Aquí podrías agregar lógica para actualizar el estado de los números comprados si tienes una tabla de números.

        res.status(201).json({ message: 'Compra registrada exitosamente', compraId: compraId, valorCalculadoUsd: valorTotalUsdCalculado, valorCalculadoBs: valorTotalBsCalculado }); // Opcional: devolver los valores calculados al frontend

    } catch (error) {
        console.error('Error al registrar la compra:', error);
        res.status(500).json({ error: 'Error al registrar la compra.' });
    }
});
// --- Fin Modificación CRUCIAL en la ruta de compra ---


// --- Nuevas Rutas para Gestión de Ventas ---

// API para obtener la lista de todas las ventas
app.get('/api/admin/ventas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id,
                comprador,
                telefono,
                numeros_seleccionados,
                valor_usd,
                valor_bs,
                tasa_aplicada,
                fecha_compra,
                fecha_sorteo,
                comprobante_nombre,
                comprobante_tipo
            FROM compras
            ORDER BY fecha_compra DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error al obtener la lista de ventas:', err);
        res.status(500).json({ error: 'Error al obtener la lista de ventas desde la base de datos.' });
    }
});

// API para obtener la lista de comprobantes adjuntados
app.get('/api/admin/comprobantes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                id AS id_compra, -- Alias para mayor claridad
                comprador,
                telefono,
                comprobante_nombre,
                comprobante_tipo,
                fecha_compra
            FROM compras
            WHERE comprobante_nombre IS NOT NULL AND comprobante_nombre != ''
            ORDER BY fecha_compra DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error al obtener la lista de comprobantes:', err);
        res.status(500).json({ error: 'Error al obtener la lista de comprobantes desde la base de datos.' });
    }
});

// --- Fin Nuevas Rutas para Gestión de Ventas ---


// Tu ruta de ejemplo existente
app.get('/', (req, res) => {
    res.send('¡Hola desde el backend de tu proyecto de Rifas y Loterias!');
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

// Asegurarse de que el pool se cierra al salir (importante para despliegues)
process.on('SIGINT', () => {
    pool.end(() => {
        console.log('Pool de base de datos cerrado.');
        process.exit(0);
    });
});