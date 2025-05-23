const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // Usar la versión de promesas de fs
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const fetch = require('node-fetch');

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

// Servir archivos estáticos (para los comprobantes subidos)
// Asegúrate de que la carpeta 'uploads' exista en la raíz de tu backend
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Rutas de Archivos de Datos ---
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const TERMINOS_CONDICIONES_FILE = path.join(__dirname, 'terminos_condiciones.txt'); // Nuevo archivo para TyC

// Función para leer archivos JSON
async function leerArchivo(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            await escribirArchivo(filePath, defaultValue);
            return defaultValue;
        }
        console.error(`Error al leer el archivo ${filePath}:`, error);
        throw error;
    }
}

// Función para escribir archivos JSON
async function escribirArchivo(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir el archivo ${filePath}:`, error);
        throw error;
    }
}

// Inicialización de archivos si no existen
async function inicializarArchivos() {
    await leerArchivo(CONFIG_FILE, {
        tasa_dolar: 0,
        pagina_bloqueada: false,
        fecha_sorteo: null,
        precio_ticket: 1.00,
        numero_sorteo_correlativo: 1,
        ultimo_numero_ticket: 0,
        ultima_fecha_resultados_zulia: null
    });
    await leerArchivo(VENTAS_FILE, []);
    await leerArchivo(HORARIOS_ZULIA_FILE, { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] });
    await leerArchivo(RESULTADOS_ZULIA_FILE, []);
    // No inicializamos TERMINOS_CONDICIONES_FILE aquí porque esperamos que exista con el texto ya dentro.
    // Si no existe, la ruta /api/terminos-condiciones lo manejará con un 404.
}

// Llama a la inicialización al arrancar el servidor
inicializarArchivos().catch(err => {
    console.error('Error durante la inicialización de archivos:', err);
    process.exit(1); // Sale si hay un error crítico al inicializar
});

// --- Rutas de Configuración y Horarios (Panel de Administración) ---

app.get('/api/admin/configuracion', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_FILE, {});
        res.json(config);
    } catch (error) {
        console.error('Error al obtener la configuración:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener la configuración.' });
    }
});

app.put('/api/admin/configuracion', async (req, res) => {
    try {
        const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket } = req.body;

        const config = await leerArchivo(CONFIG_FILE, {});

        // Actualizar campos si vienen en la solicitud
        if (tasa_dolar !== undefined) config.tasa_dolar = parseFloat(tasa_dolar);
        if (pagina_bloqueada !== undefined) config.pagina_bloqueada = Boolean(pagina_bloqueada);
        if (fecha_sorteo !== undefined) config.fecha_sorteo = fecha_sorteo;
        if (precio_ticket !== undefined) config.precio_ticket = parseFloat(precio_ticket);
        if (numero_sorteo_correlativo !== undefined) config.numero_sorteo_correlativo = parseInt(numero_sorteo_correlativo);
        if (ultimo_numero_ticket !== undefined) config.ultimo_numero_ticket = parseInt(ultimo_numero_ticket);

        // Validaciones
        if (isNaN(config.precio_ticket) || config.precio_ticket < 0) config.precio_ticket = 1.00;
        if (isNaN(config.numero_sorteo_correlativo) || config.numero_sorteo_correlativo < 1) config.numero_sorteo_correlativo = 1;
        if (isNaN(config.ultimo_numero_ticket) || config.ultimo_numero_ticket < 0) config.ultimo_numero_ticket = 0;

        await escribirArchivo(CONFIG_FILE, config);
        res.json({ message: 'Configuración actualizada exitosamente', config });
    } catch (error) {
        console.error('Error al actualizar la configuración:', error);
        res.status(500).json({ error: 'Error al guardar la configuración' });
    }
});

app.get('/api/admin/horarios-zulia', async (req, res) => {
    try {
        const horarios = await leerArchivo(HORARIOS_ZULIA_FILE, {});
        res.json(horarios);
    } catch (error) {
        console.error('Error al obtener horarios del Zulia:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener horarios.' });
    }
});

app.put('/api/admin/horarios-zulia', async (req, res) => {
    const { horarios_zulia } = req.body;
    if (!Array.isArray(horarios_zulia)) {
        return res.status(400).json({ error: 'El formato de los horarios debe ser un array.' });
    }
    try {
        await escribirArchivo(HORARIOS_ZULIA_FILE, { horarios_zulia });
        res.json({ message: 'Horarios del Zulia actualizados exitosamente', horarios_zulia });
    } catch (error) {
        console.error('Error al guardar los horarios del Zulia:', error);
        res.status(500).json({ error: 'Error al guardar los horarios del Zulia' });
    }
});

// --- Rutas de Gestión de Ventas (Panel de Administración) ---

app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al obtener la lista de ventas:', error);
        res.status(500).json({ error: 'Error al obtener la lista de ventas.' });
    }
});

app.get('/api/admin/ventas/exportar-excel', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE, []);
        console.log('Contenido de ventas para exportar:', ventas);
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(ventas);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Ventas');
        const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="ventas.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(excelBuffer);

    } catch (error) {
        console.error('Error al exportar la lista de ventas a Excel:', error);
        res.status(500).json({ error: 'Error al exportar la lista de ventas a Excel.' });
    }
});

// NUEVA RUTA: Confirmar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:numeroTicket/confirmar', async (req, res) => {
    const numeroTicket = req.params.numeroTicket;

    try {
        let ventas = await leerArchivo(VENTAS_FILE, []);
        const ventaIndex = ventas.findIndex(v => v.numeroTicket === numeroTicket);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[ventaIndex].estado === 'confirmado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido confirmada.' });
        }

        ventas[ventaIndex].estado = 'confirmado';
        ventas[ventaIndex].fechaConfirmacionAdmin = new Date().toISOString();
        await escribirArchivo(VENTAS_FILE, ventas);

        res.json({ message: `Venta ${numeroTicket} confirmada exitosamente.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error('Error al confirmar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al confirmar la venta.' });
    }
});

// NUEVA RUTA: Cancelar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:numeroTicket/cancelar', async (req, res) => {
    const numeroTicket = req.params.numeroTicket;

    try {
        let ventas = await leerArchivo(VENTAS_FILE, []);
        const ventaIndex = ventas.findIndex(v => v.numeroTicket === numeroTicket);

        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[ventaIndex].estado === 'cancelado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido cancelada.' });
        }

        ventas[ventaIndex].estado = 'cancelado';
        ventas[ventaIndex].fechaCancelacionAdmin = new Date().toISOString();
        await escribirArchivo(VENTAS_FILE, ventas);

        res.json({ message: `Venta ${numeroTicket} cancelada exitosamente.`, venta: ventas[ventaIndex] });
    } catch (error) {
        console.error('Error al cancelar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al cancelar la venta.' });
    }
});


// --- Rutas de Usuarios y Rifas (Placeholders) ---
// (Estas rutas no interactúan con los archivos JSON en este momento)
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

// --- API para Obtener Números DISPONIBLES para el Cliente ---
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerArchivo(CONFIG_FILE, {});
        const fechaSorteoActual = config.fecha_sorteo; //YYYY-MM-DD
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;
        const paginaBloqueada = config.pagina_bloqueada;

        if (paginaBloqueada) {
            return res.status(200).json({
                numerosDisponibles: [],
                fechaSorteo: fechaSorteoActual,
                numeroSorteoCorrelativo: numeroSorteoCorrelativo,
                paginaBloqueada: true,
                message: 'La página está bloqueada por el administrador. No se pueden realizar compras.'
            });
        }

        if (!fechaSorteoActual) {
            return res.status(200).json({
                numerosDisponibles: [],
                fechaSorteo: null,
                numeroSorteoCorrelativo: numeroSorteoCorrelativo,
                paginaBloqueada: false,
                message: 'No hay una fecha de sorteo configurada. Números no disponibles para la venta.'
            });
        }

        const ventas = await leerArchivo(VENTAS_FILE, []);
        const numerosVendidosParaSorteoActual = new Set();
        ventas.forEach(venta => {
            if (venta.fechaSorteo === fechaSorteoActual && ['pendiente', 'confirmado'].includes(venta.estado)) {
                if (Array.isArray(venta.numeros)) {
                    venta.numeros.forEach(num => numerosVendidosParaSorteoActual.add(num));
                }
            }
        });

        const todosLosNumeros = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
        const numerosDisponibles = todosLosNumeros.filter(num => !numerosVendidosParaSorteoActual.has(num));

        res.json({
            numerosDisponibles: numerosDisponibles,
            fechaSorteo: fechaSorteoActual,
            numeroSorteoCorrelativo: numeroSorteoCorrelativo,
            paginaBloqueada: false
        });

    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener números disponibles.' });
    }
});

// --- API para Registrar una Nueva Venta (¡CON NÚMERO DE TICKET CORRELATIVO Y ESTADO!) ---
app.post('/api/ventas', async (req, res) => {
    try {
        const {
            numeros,
            comprador,
            cedula,
            telefono,
            email,
            metodoPago,
            referenciaPago,
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaCompra,
            fechaSorteo
        } = req.body;

        const currentConfig = await leerArchivo(CONFIG_FILE, {});
        if (currentConfig.pagina_bloqueada) {
            return res.status(403).json({ message: 'La página está bloqueada por el administrador. No se pueden realizar compras en este momento.' });
        }
        if (currentConfig.fecha_sorteo !== fechaSorteo) {
            return res.status(400).json({ message: 'La fecha del sorteo en la solicitud no coincide con la fecha del sorteo actual configurada.' });
        }

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
        if (!metodoPago || metodoPago.trim() === '') {
            return res.status(400).json({ message: 'El método de pago es obligatorio.' });
        }
        if (!referenciaPago || referenciaPago.trim() === '') {
            return res.status(400).json({ message: 'La referencia de pago es obligatoria.' });
        }
        if (!fechaSorteo) {
            return res.status(400).json({ message: 'La fecha del sorteo es obligatoria.' });
        }
        if (isNaN(valorTotalUsd) || isNaN(valorTotalBs) || valorTotalUsd <= 0 || valorTotalBs <= 0) {
            return res.status(400).json({ message: 'Los valores de pago deben ser numéricos y mayores que cero.' });
        }

        // --- VALIDACIÓN DE NÚMEROS YA VENDIDOS PARA ESTE SORTEO Y ESTADO ---
        const ventasExistentes = await leerArchivo(VENTAS_FILE, []);
        const numerosYaVendidosParaEsteSorteo = new Set();
        ventasExistentes.forEach(venta => {
            if (venta.fechaSorteo === fechaSorteo && ['pendiente', 'confirmado'].includes(venta.estado)) {
                if (Array.isArray(venta.numeros)) {
                    venta.numeros.forEach(num => numerosYaVendidosParaEsteSorteo.add(num));
                }
            }
        });

        const numerosDuplicados = numeros.filter(num => numerosYaVendidosParaEsteSorteo.has(num));

        if (numerosDuplicados.length > 0) {
            return res.status(409).json({
                message: `¡Ups! Los siguientes números ya están vendidos para el sorteo del ${fechaSorteo}: ${numerosDuplicados.join(', ')}. Por favor, elige otros.`,
                numeros_conflictivos: numerosDuplicados
            });
        }
        // --- FIN VALIDACIÓN ---

        // Manejo de la subida del comprobante (si se envía)
        let comprobanteUrl = null;
        if (req.files && req.files.comprobante) {
            const comprobanteFile = req.files.comprobante;
            const uploadDir = path.join(__dirname, 'uploads', 'comprobantes');
            await fs.mkdir(uploadDir, { recursive: true });

            const fileExtension = path.extname(comprobanteFile.name);
            const fileName = `${Date.now()}-${comprobanteFile.md5}${fileExtension}`;
            const filePath = path.join(uploadDir, fileName);

            try {
                await comprobanteFile.mv(filePath);
                comprobanteUrl = `/uploads/comprobantes/${fileName}`;
                console.log('Comprobante subido a:', filePath);
            } catch (uploadError) {
                console.error('Error al subir el comprobante:', uploadError);
                comprobanteUrl = null;
            }
        }

        // --- Generar el número de ticket correlativo ---
        // Se carga la configuración, se actualiza y se guarda
        const config = await leerArchivo(CONFIG_FILE, {});
        config.ultimo_numero_ticket++;
        await escribirArchivo(CONFIG_FILE, config);

        const numeroTicketGenerado = String(config.ultimo_numero_ticket).padStart(4, '0'); // Formatea a 4 dígitos

        const nuevaVenta = {
            numeroTicket: numeroTicketGenerado,
            numeros: numeros,
            comprador: comprador,
            cedula: cedula || '',
            telefono: telefono,
            email: email || '',
            metodoPago: metodoPago,
            referenciaPago: referenciaPago,
            valorTotalUsd: parseFloat(valorTotalUsd),
            valorTotalBs: parseFloat(valorTotalBs),
            tasaAplicada: parseFloat(tasaAplicada),
            fechaCompra: fechaCompra || new Date().toISOString(),
            fechaSorteo: fechaSorteo,
            comprobanteUrl: comprobanteUrl,
            estado: 'pendiente', // Estado inicial
            numeroSorteoCorrelativo: currentConfig.numero_sorteo_correlativo
        };

        const ventas = await leerArchivo(VENTAS_FILE, []);
        ventas.push(nuevaVenta);
        await escribirArchivo(VENTAS_FILE, ventas); // Guarda la nueva venta

        console.log('Venta guardada exitosamente:', nuevaVenta.numeroTicket);
        res.status(201).json({ message: '¡Venta registrada con éxito!', venta: nuevaVenta });

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Hubo un error al registrar tu venta. Por favor, intenta de nuevo.' });
    }
});

// --- Rutas de Gestión de Resultados de Lotería Zulia ---

// Obtener resultados históricos
app.get('/api/admin/resultados-zulia', async (req, res) => {
    try {
        const resultados = await leerArchivo(RESULTADOS_ZULIA_FILE, []);
        res.json(resultados);
    } catch (error) {
        console.error('Error al obtener resultados del Zulia:', error);
        res.status(500).json({ error: 'Error al obtener los resultados del Zulia.' });
    }
});

// Simular la obtención de resultados de una API externa (¡REEMPLAZAR CON API REAL!)
app.get('/api/admin/obtener-resultados-externos', async (req, res) => {
    try {
        const mockResults = {
            zuliaNumeros: {
                "12:00 PM": "123",
                "04:00 PM": "456",
                "07:00 PM": "789"
            },
            fecha: req.query.fecha || new Date().toISOString().split('T')[0]
        };

        res.json({ success: true, message: 'Resultados simulados obtenidos.', resultados: mockResults.zuliaNumeros });

    } catch (error) {
        console.error('Error al obtener resultados de la API externa (simulada):', error);
        res.status(500).json({ success: false, message: `Error al conectar con la API de resultados: ${error.message}` });
    }
});

// Guardar los números ganadores del Zulia para un sorteo específico
app.post('/api/admin/guardar-numeros-ganadores-zulia', async (req, res) => {
    const { fecha_sorteo, numeros_ganadores, hora_sorteo } = req.body;

    if (!fecha_sorteo || !numeros_ganadores || !hora_sorteo) {
        return res.status(400).json({ message: 'Faltan datos obligatorios: fecha_sorteo, hora_sorteo, numeros_ganadores.' });
    }

    try {
        let resultados = await leerArchivo(RESULTADOS_ZULIA_FILE, []);

        // Busca si ya existe un resultado para esa fecha y hora
        const existingIndex = resultados.findIndex(
            r => r.fecha_sorteo === fecha_sorteo && r.hora_sorteo === hora_sorteo
        );

        const nuevoResultado = {
            fecha_sorteo: fecha_sorteo,
            hora_sorteo: hora_sorteo,
            numeros: numeros_ganadores,
            timestamp: new Date().toISOString()
        };

        if (existingIndex !== -1) {
            // Actualiza el resultado existente
            resultados[existingIndex] = nuevoResultado;
        } else {
            // Agrega el nuevo resultado
            resultados.push(nuevoResultado);
        }

        await escribirArchivo(RESULTADOS_ZULIA_FILE, resultados);

        // Opcional: Actualizar la última fecha de resultados buscados en la configuración
        const config = await leerArchivo(CONFIG_FILE, {});
        config.ultima_fecha_resultados_zulia = fecha_sorteo;
        await escribirArchivo(CONFIG_FILE, config);

        res.json({ success: true, message: 'Resultados de Zulia guardados/actualizados con éxito.', resultado: nuevoResultado });

    } catch (error) {
        console.error('Error al guardar/actualizar resultados de Zulia:', error);
        res.status(500).json({ error: 'Error interno del servidor al procesar resultados de Zulia.' });
    }
});

// NUEVA RUTA: Cerrar el sorteo actual y preparar el siguiente (ADMIN)
app.post('/api/admin/cerrar-sorteo-actual', async (req, res) => {
    const { siguiente_fecha_sorteo } = req.body;

    if (!siguiente_fecha_sorteo) {
        return res.status(400).json({ message: 'Debe proporcionar la fecha del siguiente sorteo (YYYY-MM-DD).' });
    }

    try {
        const config = await leerArchivo(CONFIG_FILE, {});

        // 1. Incrementar el número correlativo del sorteo
        config.numero_sorteo_correlativo++;

        // 2. Reiniciar el contador de tickets para el nuevo sorteo
        config.ultimo_numero_ticket = 0;

        // 3. Establecer la nueva fecha del sorteo
        config.fecha_sorteo = siguiente_fecha_sorteo;

        // 4. Desbloquear la página (si estuviera bloqueada por el cierre del sorteo)
        config.pagina_bloqueada = false;

        await escribirArchivo(CONFIG_FILE, config); // Guarda los cambios en la configuración

        res.json({
            success: true,
            message: `Sorteo actual cerrado y siguiente sorteo preparado. Nuevo Sorteo #: ${config.numero_sorteo_correlativo}, Fecha: ${config.fecha_sorteo}.`,
            nuevaConfig: config
        });

    } catch (error) {
        console.error('Error al cerrar el sorteo actual:', error);
        res.status(500).json({ error: 'Error interno del servidor al cerrar el sorteo.' });
    }
});

---



```javascript
// --- Archivo de Términos y Condiciones ---
const TERMINOS_CONDICIONES_FILE = path.join(__dirname, 'terminos_condiciones.txt');

// Nueva ruta para obtener los términos y condiciones (accesible para el cliente)
app.get('/api/terminos-condiciones', async (req, res) => {
    try {
        const data = await fs.readFile(TERMINOS_CONDICIONES_FILE, 'utf8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); // Indica que el contenido es texto plano
        res.send(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo de términos y condiciones no encontrado: ${TERMINOS_CONDICIONES_FILE}.`);
            return res.status(404).json({ message: 'Términos y condiciones no encontrados en el servidor.' });
        }
        console.error('Error al leer el archivo de términos y condiciones:', error);
        res.status(500).json({ error: 'Error interno del servidor al obtener los términos y condiciones.' });
    }
});