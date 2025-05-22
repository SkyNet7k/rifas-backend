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
app.use(fileUpload());

const CONFIG_FILE_PATH = path.join(__dirname, 'configuracion.json');
const HORARIOS_FILE_PATH = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE_PATH = path.join(__dirname, 'ventas.json');
const COMPROBANTES_FILE_PATH = path.join(__dirname, 'comprobantes.json'); // Mantener si todavía usas esto para logs


// --- Funciones para leer/escribir configuración (con nuevo campo `ultimo_numero_ticket`) ---
async function leerConfiguracion() {
    try {
        const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
        const config = JSON.parse(data);
        console.log('Valor de precio_ticket leído del archivo:', config.precio_ticket);
        if (config.precio_ticket === undefined) config.precio_ticket = 1.00;
        if (config.tasa_dolar === undefined) config.tasa_dolar = 0;
        if (config.pagina_bloqueada === undefined) config.pagina_bloqueada = false;
        if (config.fecha_sorteo === undefined) config.fecha_sorteo = null;
        if (config.numero_sorteo_correlativo === undefined) config.numero_sorteo_correlativo = 1;

        // --- CAMBIO IMPORTANTE: Nuevo campo para el número de ticket ---
        if (config.ultimo_numero_ticket === undefined) config.ultimo_numero_ticket = 0; // Se inicializa en 0 o 1
        // Si tienes ventas existentes, podrías querer inicializarlo con el ID más alto + 1
        // Para este ejemplo, lo inicializamos en 0. La primera venta será 0001.

        return config;
    } catch (error) {
        console.error('Error al leer la configuración, usando valores por defecto:', error.message);
        return {
            tasa_dolar: 0,
            pagina_bloqueada: false,
            fecha_sorteo: null,
            precio_ticket: 1.00,
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0 // Valor por defecto
        };
    }
}

async function guardarConfiguracion(config) {
    try {
        if (typeof config.precio_ticket !== 'number' || isNaN(config.precio_ticket) || config.precio_ticket < 0) {
            console.warn('Intento de guardar un precio de ticket inválido. Usando el valor actual o por defecto.');
            const currentConfig = await leerConfiguracion();
            config.precio_ticket = currentConfig.precio_ticket || 1.00;
        }
        if (typeof config.numero_sorteo_correlativo !== 'number' || isNaN(config.numero_sorteo_correlativo) || config.numero_sorteo_correlativo < 1) {
            console.warn('Intento de guardar un número de sorteo correlativo inválido. Usando el valor actual o por defecto (1).');
            const currentConfig = await leerConfiguracion();
            config.numero_sorteo_correlativo = currentConfig.numero_sorteo_correlativo || 1;
        }

        // --- CAMBIO IMPORTANTE: Validar y guardar ultimo_numero_ticket ---
        if (typeof config.ultimo_numero_ticket !== 'number' || isNaN(config.ultimo_numero_ticket) || config.ultimo_numero_ticket < 0) {
            console.warn('Intento de guardar un último número de ticket inválido. Usando el valor actual o por defecto (0).');
            const currentConfig = await leerConfiguracion();
            config.ultimo_numero_ticket = currentConfig.ultimo_numero_ticket || 0;
        }

        await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('Configuración guardada exitosamente.');
        return true;
    } catch (error) {
        console.error('Error al guardar la configuración:', error);
        return false;
    }
}

// ... (Las funciones leerHorariosZulia y guardarHorariosZulia se mantienen igual) ...
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
    const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket } = req.body; // Incluir nuevo campo

    const config = await leerConfiguracion(); // Obtener configuración actual para no sobrescribir campos

    // Actualizar campos si vienen en la petición
    config.tasa_dolar = tasa_dolar !== undefined ? parseFloat(tasa_dolar) : config.tasa_dolar;
    config.pagina_bloqueada = pagina_bloqueada !== undefined ? Boolean(pagina_bloqueada) : config.pagina_bloqueada;
    config.fecha_sorteo = fecha_sorteo !== undefined ? fecha_sorteo : config.fecha_sorteo;

    // Manejo del precio_ticket
    if (precio_ticket !== undefined) {
        const parsedPrice = parseFloat(precio_ticket);
        if (!isNaN(parsedPrice) && parsedPrice >= 0) {
            config.precio_ticket = parsedPrice;
        } else {
            console.warn('Valor de precio_ticket recibido inválido:', precio_ticket);
        }
    }

    // Manejo del numero_sorteo_correlativo
    if (numero_sorteo_correlativo !== undefined) {
        const parsedNumeroSorteo = parseInt(numero_sorteo_correlativo);
        if (!isNaN(parsedNumeroSorteo) && parsedNumeroSorteo >= 1) {
            config.numero_sorteo_correlativo = parsedNumeroSorteo;
        } else {
            console.warn('Valor de numero_sorteo_correlativo recibido inválido:', numero_sorteo_correlativo);
        }
    }

    // --- CAMBIO IMPORTANTE: Manejo del nuevo campo ultimo_numero_ticket ---
    if (ultimo_numero_ticket !== undefined) {
        const parsedLastTicket = parseInt(ultimo_numero_ticket);
        if (!isNaN(parsedLastTicket) && parsedLastTicket >= 0) {
            config.ultimo_numero_ticket = parsedLastTicket;
        } else {
            console.warn('Valor de ultimo_numero_ticket recibido inválido:', ultimo_numero_ticket);
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

// Rutas de Usuarios (expandidas como placeholders) - se mantienen igual
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

// Rutas de Rifas (expandidas como placeholders) - se mantienen igual
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

// --- Rutas de Gestión de Ventas (se mantienen como están, leen/escriben a VENTAS_FILE_PATH) ---
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

// --- API para Obtener Números DISPONIBLES para el Cliente ---
// MODIFICADO PARA ENVIAR EL NUMERO DE SORTEO CORRELATIVO.
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerConfiguracion();
        const fechaSorteoActual = config.fecha_sorteo;
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;

        if (!fechaSorteoActual) {
            return res.status(200).json({
                numerosDisponibles: [],
                fechaSorteo: null,
                numeroSorteoCorrelativo: numeroSorteoCorrelativo,
                message: 'No hay una fecha de sorteo configurada. Números no disponibles.'
            });
        }

        let ventas = [];
        try {
            const data = await fs.readFile(VENTAS_FILE_PATH, 'utf8');
            ventas = JSON.parse(data);
        } catch (readError) {
            console.warn('Archivo ventas.json no encontrado o vacío al consultar números disponibles. Error:', readError.message);
            ventas = [];
        }

        const numerosVendidosParaSorteoActual = new Set();
        ventas.forEach(venta => {
            const ventaFechaSorteo = venta.fechaSorteo ? venta.fechaSorteo.substring(0, 10) : null;

            if (ventaFechaSorteo === fechaSorteoActual && Array.isArray(venta.numeros)) {
                venta.numeros.forEach(num => numerosVendidosParaSorteoActual.add(num));
            }
        });

        const todosLosNumeros = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
        const numerosDisponibles = todosLosNumeros.filter(num => !numerosVendidosParaSorteoActual.has(num));

        res.json({
            numerosDisponibles: numerosDisponibles,
            fechaSorteo: fechaSorteoActual,
            numeroSorteoCorrelativo: numeroSorteoCorrelativo
        });

    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener números disponibles.' });
    }
});

// --- API para Registrar una Nueva Venta (¡CON NÚMERO DE TICKET CORRELATIVO AHORA!) ---
app.post('/api/ventas', async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            telefono,
            numeroComprobante, // Este es el número de comprobante externo, no el correlativo de ticket
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

        // Leer ventas existentes para validación de duplicados
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

        // --- CAMBIO IMPORTANTE: Generar el número de ticket correlativo ---
        const config = await leerConfiguracion();
        config.ultimo_numero_ticket++; // Incrementa el contador
        await guardarConfiguracion(config); // Guarda el nuevo contador en el archivo

        const numeroTicketGenerado = String(config.ultimo_numero_ticket).padStart(4, '0'); // Formatea a 4 dígitos


        const nuevaVenta = {
            id: Date.now(), // Un ID único basado en timestamp (puede ser el mismo que el ticket, o diferente)
            numeroTicket: numeroTicketGenerado, // ¡NUEVO CAMPO!
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
        res.status(201).json({ message: '¡Venta registrada con éxito!', venta: nuevaVenta }); // Envía la venta completa con el numeroTicket

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Hubo un error al registrar tu venta. Por favor, intenta de nuevo.' });
    }
});


// API para obtener la lista de comprobantes adjuntados (si el archivo comprobantes.json aún existe)
// Nota: Si usas fileUpload para cargar comprobantes y los guardas en `uploads`,
// esos archivos también se borrarán con cada reinicio. Necesitarías un servicio de almacenamiento en la nube (S3, Cloudinary, etc.)
// para que los comprobantes sean persistentes.
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

// Ruta de Compra (expandida como placeholder) - Ya la migramos a /api/ventas
app.post('/api/compras', async (req, res) => {
    res.status(501).json({ message: 'Ruta de compras: Proceso de compra - No implementada (usa /api/ventas ahora)' });
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