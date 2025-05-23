const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx'); // Importar la librería xlsx
const fetch = require('node-fetch'); // Para hacer solicitudes a APIs externas

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
app.use(express.json()); // Para parsear JSON en el body de las peticiones
app.use(fileUpload()); // Para manejar la subida de archivos

// Servir archivos estáticos (para los comprobantes subidos)
// Asegúrate de que la carpeta 'uploads' exista en la raíz de tu backend
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const CONFIG_FILE_PATH = path.join(__dirname, 'configuracion.json');
const HORARIOS_FILE_PATH = path.join(__dirname, 'horarios_zulia.json');
const VENTAS_FILE_PATH = path.join(__dirname, 'ventas.json');
const RESULTADOS_ZULIA_FILE_PATH = path.join(__dirname, 'resultados_zulia.json'); // Nuevo archivo para resultados históricos

// --- Funciones de Utilidad para Lectura/Escritura de Archivos JSON ---

async function leerArchivo(filePath, defaultValue = []) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        // Manejar el caso de archivo vacío
        if (data.trim() === '') {
            return defaultValue;
        }
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // Archivo no encontrado
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
            return defaultValue;
        }
        console.error(`Error al leer ${filePath}:`, error.message);
        throw error; // Propagar el error si no es ENOENT
    }
}

async function escribirArchivo(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error al escribir en ${filePath}:`, error);
        return false;
    }
}

// --- Funciones para leer/escribir configuración ---
async function leerConfiguracion() {
    try {
        const data = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
        const config = JSON.parse(data);

        // Asegurar que todos los campos existan con valores por defecto si no están presentes
        config.precio_ticket = config.precio_ticket === undefined ? 1.00 : parseFloat(config.precio_ticket);
        config.tasa_dolar = config.tasa_dolar === undefined ? 0 : parseFloat(config.tasa_dolar);
        config.pagina_bloqueada = config.pagina_bloqueada === undefined ? false : Boolean(config.pagina_bloqueada);
        config.fecha_sorteo = config.fecha_sorteo === undefined ? null : config.fecha_sorteo;
        config.numero_sorteo_correlativo = config.numero_sorteo_correlativo === undefined ? 1 : parseInt(config.numero_sorteo_correlativo);
        config.ultimo_numero_ticket = config.ultimo_numero_ticket === undefined ? 0 : parseInt(config.ultimo_numero_ticket);
        config.ultima_fecha_resultados_zulia = config.ultima_fecha_resultados_zulia === undefined ? null : config.ultima_fecha_resultados_zulia;

        return config;
    } catch (error) {
        console.error('Error al leer la configuración, usando valores por defecto:', error.message);
        // Si el archivo no existe o está corrupto, devuelve un objeto de configuración por defecto
        return {
            tasa_dolar: 0,
            pagina_bloqueada: false,
            fecha_sorteo: null, // Fecha del sorteo actual (ej. "YYYY-MM-DD")
            precio_ticket: 1.00,
            numero_sorteo_correlativo: 1, // Número para identificar el sorteo actual (ej. Sorteo #100)
            ultimo_numero_ticket: 0, // Último número de ticket vendido para el sorteo actual
            ultima_fecha_resultados_zulia: null // Última fecha para la que se buscaron resultados de Zulia
        };
    }
}

async function guardarConfiguracion(config) {
    // Validaciones antes de guardar
    config.precio_ticket = parseFloat(config.precio_ticket);
    if (isNaN(config.precio_ticket) || config.precio_ticket < 0) {
        console.warn('Valor de precio_ticket inválido, se establecerá un valor por defecto.');
        config.precio_ticket = 1.00;
    }

    config.numero_sorteo_correlativo = parseInt(config.numero_sorteo_correlativo);
    if (isNaN(config.numero_sorteo_correlativo) || config.numero_sorteo_correlativo < 1) {
        console.warn('Valor de numero_sorteo_correlativo inválido, se establecerá un valor por defecto (1).');
        config.numero_sorteo_correlativo = 1;
    }

    config.ultimo_numero_ticket = parseInt(config.ultimo_numero_ticket);
    if (isNaN(config.ultimo_numero_ticket) || config.ultimo_numero_ticket < 0) {
        console.warn('Valor de ultimo_numero_ticket inválido, se establecerá un valor por defecto (0).');
        config.ultimo_numero_ticket = 0;
    }

    return escribirArchivo(CONFIG_FILE_PATH, config);
}

// ... (Las funciones leerHorariosZulia y guardarHorariosZulia se mantienen similar) ...
async function leerHorariosZulia() {
    return leerArchivo(HORARIOS_FILE_PATH, { horarios_zulia: ["12:00 PM", "04:00 PM", "07:00 PM"] });
}

async function guardarHorariosZulia(horarios) {
    return escribirArchivo(HORARIOS_FILE_PATH, horarios);
}

// --- Rutas de Configuración y Horarios (Panel de Administración) ---

app.get('/api/admin/configuracion', async (req, res) => {
    const config = await leerConfiguracion();
    res.json(config);
});

app.put('/api/admin/configuracion', async (req, res) => {
    const { tasa_dolar, pagina_bloqueada, fecha_sorteo, precio_ticket, numero_sorteo_correlativo, ultimo_numero_ticket } = req.body;

    const config = await leerConfiguracion(); // Obtener configuración actual para no sobrescribir campos no enviados

    config.tasa_dolar = tasa_dolar !== undefined ? parseFloat(tasa_dolar) : config.tasa_dolar;
    config.pagina_bloqueada = pagina_bloqueada !== undefined ? Boolean(pagina_bloqueada) : config.pagina_bloqueada;
    config.fecha_sorteo = fecha_sorteo !== undefined ? fecha_sorteo : config.fecha_sorteo; // "YYYY-MM-DD"
    config.precio_ticket = precio_ticket !== undefined ? parseFloat(precio_ticket) : config.precio_ticket;
    config.numero_sorteo_correlativo = numero_sorteo_correlativo !== undefined ? parseInt(numero_sorteo_correlativo) : config.numero_sorteo_correlativo;
    config.ultimo_numero_ticket = ultimo_numero_ticket !== undefined ? parseInt(ultimo_numero_ticket) : config.ultimo_numero_ticket;

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

// --- Rutas de Gestión de Ventas (Panel de Administración) ---

app.get('/api/admin/ventas', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE_PATH, []);
        res.json(ventas);
    } catch (error) {
        console.error('Error al leer el archivo de ventas:', error);
        res.status(500).json({ error: 'Error al obtener la lista de ventas.' });
    }
});

app.get('/api/admin/ventas/exportar-excel', async (req, res) => {
    try {
        const ventas = await leerArchivo(VENTAS_FILE_PATH, []);
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

// NUEVA RUTA: Confirmar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:id/confirmar', async (req, res) => {
    const ventaId = parseInt(req.params.id);

    if (isNaN(ventaId)) {
        return res.status(400).json({ error: 'ID de venta inválido.' });
    }

    try {
        let ventas = await leerArchivo(VENTAS_FILE_PATH, []);
        const index = ventas.findIndex(v => v.id === ventaId);

        if (index === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[index].estado === 'confirmado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido confirmada.' });
        }

        ventas[index].estado = 'confirmado';
        ventas[index].fechaConfirmacionAdmin = new Date().toISOString();

        if (await escribirArchivo(VENTAS_FILE_PATH, ventas)) {
            res.json({ message: `Venta ${ventaId} confirmada exitosamente.`, venta: ventas[index] });
        } else {
            res.status(500).json({ error: 'Error al guardar la venta confirmada.' });
        }
    } catch (error) {
        console.error('Error al confirmar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al confirmar la venta.' });
    }
});

// NUEVA RUTA: Cancelar una venta por ID (desde el panel de administración)
app.put('/api/admin/ventas/:id/cancelar', async (req, res) => {
    const ventaId = parseInt(req.params.id);

    if (isNaN(ventaId)) {
        return res.status(400).json({ error: 'ID de venta inválido.' });
    }

    try {
        let ventas = await leerArchivo(VENTAS_FILE_PATH, []);
        const index = ventas.findIndex(v => v.id === ventaId);

        if (index === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }

        if (ventas[index].estado === 'cancelado') {
            return res.status(400).json({ message: 'Esta venta ya ha sido cancelada.' });
        }

        ventas[index].estado = 'cancelado';
        ventas[index].fechaCancelacionAdmin = new Date().toISOString();

        if (await escribirArchivo(VENTAS_FILE_PATH, ventas)) {
            res.json({ message: `Venta ${ventaId} cancelada exitosamente.`, venta: ventas[index] });
        } else {
            res.status(500).json({ error: 'Error al guardar la venta cancelada.' });
        }
    } catch (error) {
        console.error('Error al cancelar la venta:', error);
        res.status(500).json({ error: 'Error interno del servidor al cancelar la venta.' });
    }
});


// --- Rutas de Usuarios y Rifas (Placeholders) ---
// Mantengo los placeholders como indicaste. Implementar estas requeriría estructuras de datos adicionales.
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
// MODIFICADO PARA ENVIAR EL NUMERO DE SORTEO CORRELATIVO Y FECHA DE SORTEO.
app.get('/api/numeros-disponibles', async (req, res) => {
    try {
        const config = await leerConfiguracion();
        const fechaSorteoActual = config.fecha_sorteo; // YYYY-MM-DD
        const numeroSorteoCorrelativo = config.numero_sorteo_correlativo;
        const paginaBloqueada = config.pagina_bloqueada;

        // Si la página está bloqueada, no se permiten ventas.
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

        let ventas = await leerArchivo(VENTAS_FILE_PATH, []);

        const numerosVendidosParaSorteoActual = new Set();
        ventas.forEach(venta => {
            // Solo considerar ventas confirmadas o pendientes para el sorteo actual
            const ventaFechaSorteo = venta.fechaSorteo ? venta.fechaSorteo.substring(0, 10) : null;
            if (ventaFechaSorteo === fechaSorteoActual && ['pendiente', 'confirmado'].includes(venta.estado) && Array.isArray(venta.numeros)) {
                venta.numeros.forEach(num => numerosVendidosParaSorteoActual.add(num));
            }
        });

        const todosLosNumeros = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
        const numerosDisponibles = todosLosNumeros.filter(num => !numerosVendidosParaSorteoActual.has(num));

        res.json({
            numerosDisponibles: numerosDisponibles,
            fechaSorteo: fechaSorteoActual,
            numeroSorteoCorrelativo: numeroSorteoCorrelativo,
            paginaBloqueada: false // Redundante pero explícito
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
            cedula, // Nuevo campo
            telefono,
            email, // Nuevo campo
            metodoPago, // Nuevo campo
            referenciaPago, // Nuevo campo
            valorTotalUsd,
            valorTotalBs,
            tasaAplicada,
            fechaCompra,
            fechaSorteo // Esperado como "YYYY-MM-DD"
        } = req.body;

        // Validar si la página está bloqueada antes de procesar la venta
        const currentConfig = await leerConfiguracion();
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

        let ventas = await leerArchivo(VENTAS_FILE_PATH, []);

        // --- VALIDACIÓN DE NÚMEROS YA VENDIDOS PARA ESTE SORTEO Y ESTADO ---
        const numerosYaVendidosParaEsteSorteo = new Set();
        ventas.forEach(venta => {
            const ventaFechaSorteo = venta.fechaSorteo ? venta.fechaSorteo.substring(0, 10) : null;
            const currentDrawDate = fechaSorteo.substring(0, 10);

            // Solo considerar números de ventas que estén pendientes o confirmadas para el sorteo actual
            if (ventaFechaSorteo === currentDrawDate && ['pendiente', 'confirmado'].includes(venta.estado) && Array.isArray(venta.numeros)) {
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

        // Manejo de la subida del comprobante (si se envía)
        let comprobanteUrl = null;
        if (req.files && req.files.comprobante) {
            const comprobanteFile = req.files.comprobante;
            const uploadDir = path.join(__dirname, 'uploads', 'comprobantes');
            await fs.mkdir(uploadDir, { recursive: true }); // Asegura que el directorio exista

            const fileExtension = path.extname(comprobanteFile.name);
            const fileName = `${Date.now()}-${comprobanteFile.md5}${fileExtension}`; // Usar md5 para evitar colisiones con el nombre original
            const filePath = path.join(uploadDir, fileName);

            try {
                await comprobanteFile.mv(filePath);
                comprobanteUrl = `/uploads/comprobantes/${fileName}`; // URL accesible públicamente
                console.log('Comprobante subido a:', filePath);
            } catch (uploadError) {
                console.error('Error al subir el comprobante:', uploadError);
                // Decide si la venta debe fallar si el comprobante no se sube.
                // Por ahora, solo logueamos el error y la venta continúa sin comprobanteUrl.
                comprobanteUrl = null;
            }
        }

        // --- Generar el número de ticket correlativo ---
        const config = await leerConfiguracion(); // Volver a leer por si otra venta incrementó
        config.ultimo_numero_ticket++; // Incrementa el contador
        await guardarConfiguracion(config); // Guarda el nuevo contador en el archivo

        const numeroTicketGenerado = String(config.ultimo_numero_ticket).padStart(4, '0'); // Formatea a 4 dígitos

        const nuevaVenta = {
            id: Date.now(), // Un ID único basado en timestamp
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
            fechaSorteo: fechaSorteo, // "YYYY-MM-DD"
            comprobanteUrl: comprobanteUrl, // URL del comprobante
            estado: 'pendiente', // Estado inicial de la venta
            numeroSorteoCorrelativo: currentConfig.numero_sorteo_correlativo // Asociar al sorteo actual
        };

        ventas.push(nuevaVenta);

        if (await escribirArchivo(VENTAS_FILE_PATH, ventas)) {
            console.log('Venta guardada exitosamente:', nuevaVenta.id);
            res.status(201).json({ message: '¡Venta registrada con éxito!', venta: nuevaVenta });
        } else {
            // Si falla la escritura de la venta, deberías revertir el incremento del ticket
            // Pero con archivos JSON, es más complejo que con una base de datos.
            // Para una solución robusta, se recomienda una DB transaccional.
            res.status(500).json({ error: 'Hubo un error al guardar la venta después de generarla.' });
        }

    } catch (error) {
        console.error('Error al registrar la venta:', error);
        res.status(500).json({ error: 'Hubo un error al registrar tu venta. Por favor, intenta de nuevo.' });
    }
});

// --- Rutas de Gestión de Resultados de Lotería Zulia ---

// Obtener resultados históricos (si se han guardado)
app.get('/api/admin/resultados-zulia', async (req, res) => {
    try {
        const resultados = await leerArchivo(RESULTADOS_ZULIA_FILE_PATH, []);
        res.json(resultados);
    } catch (error) {
        console.error('Error al obtener resultados del Zulia:', error);
        res.status(500).json({ error: 'Error al obtener los resultados del Zulia.' });
    }
});

// Simular la obtención de resultados de una API externa (¡REEMPLAZAR CON API REAL!)
app.get('/api/admin/obtener-resultados-externos', async (req, res) => {
    // NOTA: Esta es una SIMULACIÓN. Deberás reemplazarla con una API real.
    // Consulta al proveedor de datos de loterías de Venezuela.
    // Ejemplos de APIs (esto es FALSO, solo para ilustración):
    // const externalApiUrl = `https://api.resultadosdeloterias.com/zulia?fecha=${req.query.fecha || new Date().toISOString().split('T')[0]}&apiKey=TU_API_KEY_AQUI`;
    // const externalApiUrl = 'https://some-real-lottery-api.com/zulia/daily';

    try {
        // Simulación de respuesta de API externa
        const mockResults = {
            zuliaNumeros: {
                "12:00 PM": "123",
                "04:00 PM": "456",
                "07:00 PM": "789"
            },
            fecha: req.query.fecha || new Date().toISOString().split('T')[0]
        };

        // En un entorno real, harías esto:
        // const response = await fetch(externalApiUrl);
        // if (!response.ok) {
        //     throw new Error(`Error HTTP: ${response.status} - ${response.statusText}`);
        // }
        // const data = await response.json();
        // const numerosGanadores = data.zuliaNumeros; // Ajusta según la estructura de la API real

        res.json({ success: true, message: 'Resultados simulados obtenidos.', resultados: mockResults.zuliaNumeros });

    } catch (error) {
        console.error('Error al obtener resultados de la API externa (simulada):', error);
        res.status(500).json({ success: false, message: `Error al conectar con la API de resultados: ${error.message}` });
    }
});

// Guardar los números ganadores del Zulia para un sorteo específico
app.post('/api/admin/guardar-numeros-ganadores-zulia', async (req, res) => {
    const { fecha_sorteo, numeros_ganadores, hora_sorteo } = req.body; // fecha_sorteo en "YYYY-MM-DD", hora_sorteo en "HH:MM XM"

    if (!fecha_sorteo || !numeros_ganadores || !hora_sorteo) {
        return res.status(400).json({ message: 'Faltan datos obligatorios: fecha_sorteo, hora_sorteo, numeros_ganadores.' });
    }

    try {
        let resultados = await leerArchivo(RESULTADOS_ZULIA_FILE_PATH, []);

        // Buscar si ya existe un resultado para esta fecha y hora
        const existingIndex = resultados.findIndex(
            r => r.fecha_sorteo === fecha_sorteo && r.hora_sorteo === hora_sorteo
        );

        const nuevoResultado = {
            fecha_sorteo: fecha_sorteo,
            hora_sorteo: hora_sorteo,
            numeros: numeros_ganadores, // Puede ser un array o string "XX,YY,ZZ"
            timestamp: new Date().toISOString()
        };

        if (existingIndex !== -1) {
            resultados[existingIndex] = nuevoResultado; // Actualizar
            console.log(`Resultado de Zulia para ${fecha_sorteo} ${hora_sorteo} actualizado.`);
        } else {
            resultados.push(nuevoResultado); // Añadir
            console.log(`Nuevo resultado de Zulia para ${fecha_sorteo} ${hora_sorteo} guardado.`);
        }

        if (await escribirArchivo(RESULTADOS_ZULIA_FILE_PATH, resultados)) {
            // Opcional: Actualizar la última fecha de resultados buscados en la configuración
            const config = await leerConfiguracion();
            config.ultima_fecha_resultados_zulia = fecha_sorteo;
            await guardarConfiguracion(config);

            res.json({ success: true, message: 'Resultados de Zulia guardados/actualizados con éxito.' });
        } else {
            res.status(500).json({ error: 'Error al guardar los resultados de Zulia.' });
        }
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de Zulia:', error);
        res.status(500).json({ error: 'Error interno del servidor al procesar resultados de Zulia.' });
    }
});


// NUEVA RUTA: Cerrar el sorteo actual y preparar el siguiente (ADMIN)
app.post('/api/admin/cerrar-sorteo-actual', async (req, res) => {
    const { siguiente_fecha_sorteo } = req.body; // La fecha del próximo sorteo "YYYY-MM-DD"

    if (!siguiente_fecha_sorteo) {
        return res.status(400).json({ message: 'Debe proporcionar la fecha del siguiente sorteo (YYYY-MM-DD).' });
    }

    try {
        const config = await leerConfiguracion();

        // 1. Opcional: Limpiar ventas de sorteos anteriores (o moverlas a un historial)
        // Por ahora, simplemente las dejamos y el filtro de `numeros-disponibles` se encarga.
        // Si necesitas limpiar `ventas.json`, es aquí donde lo harías.

        // 2. Incrementar el número correlativo del sorteo
        config.numero_sorteo_correlativo++;

        // 3. Reiniciar el contador de tickets
        config.ultimo_numero_ticket = 0; // O 1 si quieres que empiece desde 1

        // 4. Establecer la nueva fecha del sorteo
        config.fecha_sorteo = siguiente_fecha_sorteo;

        // 5. Desbloquear la página (si estuviera bloqueada por el cierre del sorteo)
        config.pagina_bloqueada = false;

        if (await guardarConfiguracion(config)) {
            res.json({
                success: true,
                message: `Sorteo actual cerrado y siguiente sorteo preparado. Nuevo Sorteo #: ${config.numero_sorteo_correlativo}, Fecha: ${config.fecha_sorteo}.`,
                nuevaConfig: config
            });
        } else {
            res.status(500).json({ error: 'Error al cerrar el sorteo y preparar el siguiente.' });
        }

    } catch (error) {
        console.error('Error al cerrar el sorteo actual:', error);
        res.status(500).json({ error: 'Error interno del servidor al cerrar el sorteo.' });
    }
});


// Ruta principal (solo para verificar que el servidor está corriendo)
app.get('/', (req, res) => {
    res.send('¡Hola desde el backend de tu proyecto web de Rifas y Loterias!');
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
});

// Manejo de cierre del servidor (para que se cierre limpiamente en Netlify u otros hosts)
process.on('SIGINT', () => {
    console.log('Servidor cerrado.');
    process.exit(0);
});