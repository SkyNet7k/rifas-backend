const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx'); // Importar la librería xlsx

const app = express();
const port = process.env.PORT || 3000;

// Configura CORS
const corsOptions = {
    origin: [
        'https://paneladmin01.netlify.app', // Tu panel de administración
        'https://tuoportunidadeshoy.netlify.app' // Tu panel de cliente
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(fileUpload()); // Mantenerlo por ahora, por si lo usas en el admin u otras cosas

const CONFIG_FILE_PATH = path.join(__dirname, 'configuracion.json');
const HORARIOS_FILE_PATH = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE_PATH = path.join(__dirname, 'ventas.json');
const COMPROBANTES_FILE_PATH = path.join(__dirname, 'comprobantes.json'); // Mantener si aún usas este archivo para algo.

async function leerConfiguracion() {
    try {
        const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
        const config = JSON.parse(data);
        console.log('Valor de precio_ticket leído del archivo:', config.precio_ticket);
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

// Rutas de configuración y horarios
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

// Rutas de Usuarios (expandidas como placeholders)
app.post('/api/admin/usuarios', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Crear - No implementada' });
});
app.get('/api/admin/usuarios', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Obtener todos - No implementada' });
});
app.get('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Obtener por ID - No implementada' });
});
app.put('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Actualizar - No implementada' });
});
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de usuarios: Eliminar - No implementada' });
});

// Rutas de Rifas (expandidas como placeholders)
app.get('/api/admin/rifas', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Obtener todas - No implementada' });
});
app.get('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Obtener por ID - No implementada' });
});
app.post('/api/admin/rifas', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Crear - No implementada' });
});
app.put('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Actualizar - No implementada' });
});
app.delete('/api/admin/rifas/:id', async (req, res) => {
    res.status(501).json({ message: 'Ruta de rifas: Eliminar - No implementada' });
});

// --- Rutas de Gestión de Ventas ---

// API para obtener la lista de todas las ventas
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
        console.log('Contenido de ventas para exportar:', ventas);
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

// --- Nueva Ruta para Obtener Números Vendidos para el Cliente ---

app.get('/api/numeros-vendidos-para-cliente', async (req, res) => {
    try {
        const { fechaSorteo } = req.query; // Esperamos la fecha del sorteo en formato 'YYYY-MM-DD' (ej. 2025-05-20)

        if (!fechaSorteo) {
            return res.status(400).json({ error: 'La fecha del sorteo es obligatoria.' });
        }

        let ventas = [];
        try {
            const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
            ventas = JSON.parse(data);
        } catch (readError) {
            console.warn('Archivo ventas.json no encontrado o vacío al consultar números vendidos para cliente. Error:', readError.message);
            ventas = [];
        }

        const numerosVendidos = new Set();

        ventas.forEach(venta => {
            const ventaDate = venta.fechaSorteo ? venta.fechaSorteo.substring(0, 10) : null;

            if (ventaDate === fechaSorteo && Array.isArray(venta.numeros)) {
                venta.numeros.forEach(numero => {
                    numerosVendidos.add(numero);
                });
            }
        });

        res.json({
            fechaSorteo: fechaSorteo,
            numeros_vendidos: Array.from(numerosVendidos)
        });

    } catch (error) {
        console.error('Error al obtener números vendidos para el cliente:', error);
        res.status(500).json({ error: 'Error al obtener los números vendidos.' });
    }
});

// --- API para Registrar una Nueva Venta (Con Validación de Duplicados) ---

app.post('/api/ventas', async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            telefono,
            numeroComprobante,
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaCompra,
            fechaSorteo
        } = req.body;

        // **Validaciones básicas**
        if (!numeros || numeros.length === 0) {
            return res.status(400).json({ message: 'Debe seleccionar al menos un número.' });
        }
        if (!comprador || comprador.trim() === '') {
            return res.status(400).json({ message: 'El nombre del comprador es obligatorio.' });
        }
        if (!telefono || telefono.trim() === '') {
            return res.status(400).json({ message: 'El teléfono es obligatorio.' });
        }
        if (!numeroComprobante || numeroComprobante.trim() === '') {
            return res.status(400).json({ message: 'El número de comprobante es obligatorio.' });
        }
        if (!fechaSorteo) {
            return res.status(400).json({ message: 'La fecha del sorteo es obligatoria.' });
        }

        let ventas = [];
        try {
            const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
            ventas = JSON.parse(data);
        } catch (readError) {
            console.warn('Archivo ventas.json no encontrado o vacío al procesar nueva venta. Error:', readError.message);
            ventas = [];
        }

        // --- VALIDACIÓN DE NÚMEROS YA VENDIDOS PARA ESTE SORTEO ---
        const numerosYaVendidosParaEsteSorteo = new Set();
        ventas.forEach(venta => {
            const ventaDate = venta.fechaSorteo ? venta.fechaSorteo.substring(0, 10) : null;
            const currentDrawDate = fechaSorteo.substring(0, 10);

            if (ventaDate === currentDrawDate && Array.isArray(venta.numeros)) {
                venta.numeros.forEach(num => numerosYaVendidosParaEsteSorteo.add(num));
            }
        });

        const numerosDuplicados = numeros.filter(num => numerosYaVendidosParaEsteSorteo.has(num));

        if (numerosDuplicados.length > 0) {
            return res.status(409).json({
                message: `¡Ups! Los siguientes números ya están vendidos para el sorteo del ${fechaSorteo.substring(0, 10)}: ${numerosDuplicados.join(', ')}. Por favor, elige otros.`,
                numeros_conflictivos: numerosDuplicados
            });
        }
        // --- FIN VALIDACIÓN ---

        const nuevaVenta = {
            id: Date.now(),
            numeros: numeros,
            comprador: comprador,
            telefono: telefono,
            numeroComprobante: numeroComprobante,
            valorTotalUsd: valorTotalUsd,
            valorTotalBs: valorTotalBs,
            tasaAplicada: tasaAplicada,
            fechaCompra: fechaCompra,
            fechaSorteo: fechaSorteo
        };

        ventas.push(nuevaVenta);

        await fs.writeFile(VENTAS_FILE_PATH, JSON.stringify(ventas, null, 2), 'utf8');

        console.log('Venta guardada exitosamente:', nuevaVenta.id);
        res.status(201).json({ message: '¡Venta registrada con éxito!', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Hubo un error al registrar tu venta. Por favor, intenta de nuevo.' });
    }
});

// --- API para cargar y registrar comprobantes (Comentada para el flujo de cliente) ---
/*
app.post('/api/comprobantes', async (req, res) => {
    try {
        if (!req.files || Object.keys(req.files).length === 0) {
            return res.status(400).json({ error: 'No se encontraron archivos para subir.' });
        }
        const comprobante = req.files.comprobante;
        const { ventaId } = req.body;
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!allowedMimeTypes.includes(comprobante.mimetype)) {
            return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
        }
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (comprobante.size > maxSize) {
            return res.status(400).json({ error: 'El archivo es demasiado grande.' });
        }
        const nombreArchivo = `${Date.now()}-${comprobante.name}`;
        const rutaAlmacenamiento = path.join(__dirname, 'uploads', nombreArchivo);
        await comprobante.mv(rutaAlmacenamiento);
        const data = await fs.readFile(COMPROBANTES_FILE_PATH, 'utf8');
        const comprobantes = JSON.parse(data);
        const nuevoComprobante = {
            id: Date.now(),
            ventaId: ventaId,
            comprobante_nombre: nombreArchivo,
            comprobante_tipo: comprobante.mimetype,
            fecha_carga: new Date().toISOString()
        };
        comprobantes.push(nuevoComprobante);
        await fs.writeFile(COMPROBANTES_FILE_PATH, JSON.stringify(comprobantes, null, 2), 'utf8');
        res.status(201).json({ message: 'Comprobante cargado exitosamente', comprobante: nuevoComprobante });
    } catch (error) {
        console.error('Error al cargar el comprobante:', error);
        res.status(500).json({ error: 'Error al cargar el comprobante.' });
    }
});
*/

// API para obtener la lista de comprobantes adjuntados (si el archivo comprobantes.json aún existe)
app.get('/api/admin/comprobantes', async (req, res) => {
    const filePath = path.join(__dirname, 'comprobantes.json');
    console.log('Intentando leer el archivo de comprobantes en:', filePath);
    try {
        const data = await fs.readFile(filePath, 'utf8');
        const comprobantes = JSON.parse(data);
        res.json(comprobantes);
    } catch (error) {
        console.error('Error al leer el archivo de comprobantes:', error);
        res.status(500).json({ error: 'Error al obtener la lista de comprobantes desde el archivo.' });
    }
});

// Ruta de Compra (expandida como placeholder)
app.post('/api/compras', async (req, res) => {
    res.status(501).json({ message: 'Ruta de compras: Proceso de compra - No implementada' });
});

app.get('/', (req, res) => {
    res.send('¡Hola desde el backend de tu proyecto web de Rifas y Loterias!');
});

app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

process.on('SIGINT', () => {
    console.log('Servidor cerrado.');
    process.exit(0);
});