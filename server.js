// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs'); // Asegúrate de tener 'exceljs' instalado: npm install exceljs

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configura la URL base de tu API, preferiblemente desde variables de entorno
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// RUTAS CORREGIDAS: Ahora los archivos JSON se buscan directamente en el directorio __dirname
const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const COMPROBANTES_REGISTRO_FILE = path.join(__dirname, 'comprobantes.json'); // Archivo para registrar comprobantes finalizados por clientes

// Variables globales para datos (se cargarán al inicio)
let configuracion = {};
let numerosDisponibles = [];
let ventasRegistradas = [];
let horariosZulia = [];
let resultadosZulia = [];
let comprobantesRegistros = [];

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Aumentar el límite para payloads grandes
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Para datos de formulario
app.use(fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    abortOnLimit: true
}));

// Servir archivos estáticos (comprobantes subidos)
// Asegúrate de que esta ruta sea accesible públicamente desde tu frontend
app.use('/comprobantes', express.static(path.join(__dirname, 'comprobantes')));

// --- Funciones de Utilidad para manejo de archivos JSON ---
async function readJsonFile(filePath, defaultValue = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Archivo no encontrado: ${filePath}. Usando valor por defecto.`);
            return defaultValue;
        } else {
            console.error(`Error al leer el archivo ${filePath}:`, error);
            // Si el archivo existe pero está corrupto, lo borramos y usamos el valor por defecto
            try {
                await fs.unlink(filePath);
                console.warn(`Archivo corrupto ${filePath} eliminado. Usando valor por defecto.`);
            } catch (unlinkError) {
                console.error(`Error al eliminar archivo corrupto ${filePath}:`, unlinkError);
            }
            return defaultValue;
        }
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error al escribir en el archivo ${filePath}:`, error);
        throw error;
    }
}

// Función para asegurar que los directorios existen
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(COMPROBANTES_DIR, { recursive: true });
        console.log('Directorios "data" y "comprobantes" asegurados.');
    } catch (error) {
        console.error('Error al asegurar los directorios:', error);
        throw error; // Si no se pueden crear los directorios, el servidor no puede funcionar.
    }
}


// Función para cargar los datos iniciales
async function loadInitialData() {
    try {
        configuracion = await readJsonFile(CONFIG_FILE, {
            tasa_dolar: 36.5,
            pagina_bloqueada: false,
            // Si la fecha_sorteo no está definida en el JSON, usa la fecha actual de Venezuela
            fecha_sorteo: moment().tz("America/Caracas").format('YYYY-MM-DD'),
            precio_ticket: 1.00,
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            ultima_fecha_resultados_zulia: null,
            admin_whatsapp_numbers: [],
            metodosDePago: ["Transferencia", "Pago Móvil", "Binance", "Zelle"],
            codigosPais: [
                { nombre: "Venezuela", codigo: "+58", predeterminado: true },
                { nombre: "Colombia", codigo: "+57" },
                { nombre: "Estados Unidos", codigo: "+1" },
                { nombre: "España", codigo: "+34" }
            ],
            mail_config: {
                host: "smtp.gmail.com",
                port: 465,
                secure: true,
                user: "SkyFall7k@gmail.com", 
                pass: "gnrl fxqe oqpd twti", 
                senderName: "Sistema de Rifas"
            },
            admin_email_for_reports: "SkyFall7k@gmail.com" 
        });

        // --- CORRECCIÓN CLAVE AQUÍ: Generar todos los números del 000 al 999 si el archivo no existe o está vacío ---
        let allNumbers = [];
        for (let i = 0; i <= 999; i++) {
            allNumbers.push(String(i).padStart(3, '0'));
        }

        try {
            // Intenta leer numeros.json. Si no existe o está vacío/corrupto, se usa allNumbers.
            let loadedNumeros = await readJsonFile(NUMEROS_FILE, allNumbers);
            if (!Array.isArray(loadedNumeros) || loadedNumeros.length === 0) {
                console.warn("numeros.json está vacío o corrupto. Regenerando todos los números como disponibles.");
                numerosDisponibles = allNumbers;
                await writeJsonFile(NUMEROS_FILE, numerosDisponibles); // Y se guarda
            } else {
                // Asegurar que todos los números cargados son de 3 dígitos (limpieza si fuera necesario)
                numerosDisponibles = loadedNumeros.map(n => String(n).padStart(3, '0'));
                // Opcional: Si quieres asegurar que solo se mantengan números válidos existentes
                // numerosDisponibles = loadedNumeros.filter(n => allNumbers.includes(String(n).padStart(3, '0')));
            }
        } catch (fileError) {
            // Si el archivo NUMEROS_FILE no existe (fileError), lo creamos con todos los números
            console.warn(`El archivo ${NUMEROS_FILE} no existe o no se pudo leer. Creándolo con todos los números.`);
            numerosDisponibles = allNumbers;
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles);
        }
        // FIN CORRECCIÓN CLAVE

        ventasRegistradas = await readJsonFile(VENTAS_FILE, []);
        // Asegurarse de que `ventasRegistradas` sea un array, incluso si el archivo está vacío o corrupto
        if (!Array.isArray(ventasRegistradas)) ventasRegistradas = [];

        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, ["13:00", "15:00", "17:00", "19:00"]);
        if (!Array.isArray(horariosZulia)) horariosZulia = ["13:00", "15:00", "17:00", "19:00"];

        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        if (!Array.isArray(resultadosZulia)) resultadosZulia = [];

        comprobantesRegistros = await readJsonFile(COMPROBANTES_REGISTRO_FILE, []);
        if (!Array.isArray(comprobantesRegistros)) comprobantesRegistros = [];

        console.log('Datos iniciales cargados con éxito.');
    } catch (error) {
        console.error('Error al cargar datos iniciales:', error);
        throw error; // Es importante que el servidor no inicie si no puede cargar datos esenciales.
    }
}

// --- Rutas de la API ---

// Ruta para obtener configuración general (Frontend Cliente y Admin)
app.get('/configuracion', (req, res) => {
    res.json(configuracion);
});

// Ruta para actualizar configuración (Panel Admin)
app.post('/configuracion', async (req, res) => {
    try {
        const newConfig = req.body;
        // Solo permitir la actualización de campos específicos para evitar sobrescribir todo
        if (newConfig.tasa_dolar !== undefined) configuracion.tasa_dolar = parseFloat(newConfig.tasa_dolar);
        if (newConfig.pagina_bloqueada !== undefined) configuracion.pagina_bloqueada = Boolean(newConfig.pagina_bloqueada);
        if (newConfig.fecha_sorteo) configuracion.fecha_sorteo = newConfig.fecha_sorteo;
        if (newConfig.precio_ticket !== undefined) configuracion.precio_ticket = parseFloat(newConfig.precio_ticket);
        if (newConfig.numero_sorteo_correlativo !== undefined) configuracion.numero_sorteo_correlativo = parseInt(newConfig.numero_sorteo_correlativo);
        if (newConfig.ultimo_numero_ticket !== undefined) configuracion.ultimo_numero_ticket = parseInt(newConfig.ultimo_numero_ticket);
        if (newConfig.ultima_fecha_resultados_zulia !== undefined) configuracion.ultima_fecha_resultados_zulia = newConfig.ultima_fecha_resultados_zulia;
        if (newConfig.admin_whatsapp_numbers) configuracion.admin_whatsapp_numbers = newConfig.admin_whatsapp_numbers;
        if (newConfig.metodosDePago) configuracion.metodosDePago = newConfig.metodosDePago;
        if (newConfig.codigosPais) configuracion.codigosPais = newConfig.codigosPais;
        if (newConfig.mail_config) configuracion.mail_config = { ...configuracion.mail_config, ...newConfig.mail_config };
        if (newConfig.admin_email_for_reports) configuracion.admin_email_for_reports = newConfig.admin_email_for_reports;


        await writeJsonFile(CONFIG_FILE, configuracion);
        res.json({ message: 'Configuración actualizada con éxito.', configuracion });
    } catch (error) {
        console.error('Error al actualizar configuración:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Ruta para obtener números disponibles (Frontend Cliente)
app.get('/numeros-disponibles', (req, res) => {
    try {
        res.json(numerosDisponibles);
    } catch (error) {
        console.error('Error al obtener números disponibles:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta para obtener todas las ventas (Panel Admin)
app.get('/ventas', (req, res) => {
    res.json(ventasRegistradas);
});

// Ruta para obtener comprobantes finalizados (Panel Admin)
app.get('/comprobantes-finalizados', (req, res) => {
    res.json(comprobantesRegistros);
});

// Ruta para agregar horarios de Zulia (Panel Admin)
app.post('/horarios-zulia', async (req, res) => {
    const { nuevoHorario } = req.body;
    if (!nuevoHorario || !/^\d{2}:\d{2}$/.test(nuevoHorario)) {
        return res.status(400).json({ message: 'Formato de horario inválido (HH:MM).' });
    }
    if (horariosZulia.includes(nuevoHorario)) {
        return res.status(409).json({ message: 'El horario ya existe.' });
    }
    horariosZulia.push(nuevoHorario);
    horariosZulia.sort(); // Mantener ordenados
    await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
    res.json({ message: 'Horario agregado con éxito.', horariosZulia });
});

// Ruta para eliminar horarios de Zulia (Panel Admin)
app.delete('/horarios-zulia/:horario', async (req, res) => {
    const { horario } = req.params;
    const initialLength = horariosZulia.length;
    horariosZulia = horariosZulia.filter(h => h !== horario);
    if (horariosZulia.length === initialLength) {
        return res.status(404).json({ message: 'Horario no encontrado.' });
    }
    await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
    res.json({ message: 'Horario eliminado con éxito.', horariosZulia });
});

// Ruta para obtener resultados de Zulia (Panel Admin y potencialmente Cliente)
app.get('/resultados-zulia', (req, res) => {
    res.json(resultadosZulia);
});

// Ruta para agregar resultados de Zulia (Panel Admin)
app.post('/resultados-zulia', async (req, res) => {
    const { fecha, resultados } = req.body; // resultados esperado como { "13:00": "XX", "15:00": "YY" }

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Fecha inválida. Usa YYYY-MM-DD.' });
    }
    if (!resultados || typeof resultados !== 'object' || Object.keys(resultados).length === 0) {
        return res.status(400).json({ message: 'Resultados inválidos.' });
    }

    // Validar que los números de resultados sean de 2 dígitos
    for (const hora in resultados) {
        if (typeof resultados[hora] !== 'string' || !/^\d{2}$/.test(resultados[hora])) {
            return res.status(400).json({ message: `Resultado inválido para ${hora}. Debe ser un número de 2 dígitos.` });
        }
    }

    const existingIndex = resultadosZulia.findIndex(r => r.fecha === fecha);

    if (existingIndex > -1) {
        // Si ya existe un registro para esa fecha, actualiza los resultados
        resultadosZulia[existingIndex].resultados = {
            ...resultadosZulia[existingIndex].resultados,
            ...resultados
        };
    } else {
        // Si no existe, agrega un nuevo registro
        resultadosZulia.push({ fecha, resultados });
    }

    resultadosZulia.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)); // Ordenar por fecha descendente
    await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);

    // Actualizar la última fecha de resultados Zulia en la configuración
    const maxFechaResultado = resultadosZulia.reduce((maxDate, entry) => {
        return moment(entry.fecha).isAfter(maxDate) ? entry.fecha : maxDate;
    }, moment('1900-01-01').format('YYYY-MM-DD')); // Fecha muy antigua como inicio

    configuracion.ultima_fecha_resultados_zulia = maxFechaResultado;
    await writeJsonFile(CONFIG_FILE, configuracion);


    res.json({ message: 'Resultados actualizados con éxito.', resultados: resultadosZulia });
});


// Ruta de compra (Frontend Cliente)
app.post('/comprar', async (req, res) => {
    const { numeros, comprador, telefono, metodo_pago, referencia_pago, valor_usd, valor_bs, fecha_sorteo, numero_sorteo_correlativo } = req.body;

    if (!numeros || !Array.isArray(numeros) || numeros.length === 0) {
        return res.status(400).json({ message: 'Debe seleccionar al menos un número.' });
    }
    if (!comprador || !telefono || !metodo_pago || valor_usd === undefined || valor_bs === undefined || !fecha_sorteo || numero_sorteo_correlativo === undefined) {
        return res.status(400).json({ message: 'Faltan datos obligatorios para la compra.' });
    }

    // Validar que los números sean de 3 dígitos (Ej. "001")
    const invalidNumbers = numeros.filter(n => typeof n !== 'string' || !/^\d{3}$/.test(n));
    if (invalidNumbers.length > 0) {
        return res.status(400).json({ message: 'Los números seleccionados deben ser cadenas de 3 dígitos (Ej. "001").' });
    }

    const numbersToUpdate = [];
    const soldNumbers = []; // Para los números que realmente se vendieron en esta transacción
    const unavailableNumbers = []; // Para números que no estaban disponibles

    // Verificar disponibilidad en tiempo real y bloquearlos
    for (const num of numeros) {
        const index = numerosDisponibles.indexOf(num);
        if (index > -1) {
            numbersToUpdate.push(num);
            soldNumbers.push(num); // Añadir a los que se vendieron
        } else {
            unavailableNumbers.push(num);
        }
    }

    if (unavailableNumbers.length > 0) {
        return res.status(409).json({ message: `Algunos números no están disponibles: ${unavailableNumbers.join(', ')}. Por favor, recarga la página y selecciona otros.` });
    }

    // Remover los números vendidos de numerosDisponibles
    numerosDisponibles = numerosDisponibles.filter(n => !numbersToUpdate.includes(n));
    await writeJsonFile(NUMEROS_FILE, numerosDisponibles); // Guardar los números actualizados

    // Generar número de ticket único
    configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
    const nroTicket = configuracion.ultimo_numero_ticket;
    await writeJsonFile(CONFIG_FILE, configuracion); // Guardar el contador de ticket actualizado

    const newSale = {
        id: `venta_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        fecha_hora_compra: moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss'),
        fecha_sorteo: fecha_sorteo,
        numero_sorteo_correlativo: numero_sorteo_correlativo,
        nro_ticket: nroTicket,
        comprador,
        telefono,
        numeros: soldNumbers, // Asegúrate de guardar solo los números que realmente se vendieron
        valor_usd,
        valor_bs,
        metodo_pago,
        referencia_pago: referencia_pago || 'N/A',
        estado: 'pendiente-comprobante', // Estado inicial
        url_comprobante: null // Se llenará si el cliente sube un comprobante
    };

    ventasRegistradas.push(newSale);
    await writeJsonFile(VENTAS_FILE, ventasRegistradas);

    res.status(201).json({ message: 'Compra realizada con éxito.', venta: newSale });
});

// Ruta para que el cliente finalice una apuesta con un comprobante (subida de archivo)
app.post('/finalizar-apuesta', async (req, res) => {
    const { id_venta } = req.body; // El ID de la venta ya creada
    const { comprobante } = req.files; // El archivo de comprobante

    if (!id_venta || !comprobante) {
        return res.status(400).json({ message: 'Faltan datos (ID de venta o comprobante).' });
    }

    const ventaIndex = ventasRegistradas.findIndex(v => v.id === id_venta);
    if (ventaIndex === -1) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
    }

    const venta = ventasRegistradas[ventaIndex];

    const fileExtension = path.extname(comprobante.name);
    const fileName = `comprobante_${id_venta}_${Date.now()}${fileExtension}`;
    const filePath = path.join(COMPROBANTES_DIR, fileName);
    const fileUrl = `${API_BASE_URL}/comprobantes/${fileName}`; // URL pública para acceder al comprobante

    try {
        await comprobante.mv(filePath); // Mover el archivo subido

        venta.url_comprobante = fileUrl;
        venta.estado = 'comprobante-subido'; // Actualizar estado de la venta
        venta.fecha_hora_comprobante_subido = moment().tz("America/Caracas").format('YYYY-MM-DD HH:mm:ss');

        // Registrar en comprobantesRegistros para el panel admin
        const newComprobanteRegistro = {
            id: `comp_reg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            id_venta: venta.id,
            comprador: venta.comprador,
            telefono: venta.telefono,
            numeros: venta.numeros,
            metodo_pago: venta.metodo_pago,
            referencia: venta.referencia_pago,
            fecha_hora_finalizacion: venta.fecha_hora_comprobante_subido,
            fecha_sorteo: venta.fecha_sorteo,
            nro_sorteo: venta.numero_sorteo_correlativo,
            url: fileUrl,
            url_comprobante_original_venta: venta.url_comprobante_original_venta || null // Para mantener referencia si se subió antes
        };
        comprobantesRegistros.push(newComprobanteRegistro);


        await writeJsonFile(VENTAS_FILE, ventasRegistradas);
        await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);

        // Enviar notificación por correo al admin (si configurado)
        if (configuracion.mail_config && configuracion.mail_config.user && configuracion.mail_config.pass && configuracion.admin_email_for_reports) {
            const transporter = nodemailer.createTransport({
                host: configuracion.mail_config.host,
                port: configuracion.mail_config.port,
                secure: configuracion.mail_config.secure,
                auth: {
                    user: configuracion.mail_config.user,
                    pass: configuracion.mail_config.pass,
                },
            });

            const mailOptions = {
                from: `${configuracion.mail_config.senderName} <${configuracion.mail_config.user}>`,
                to: configuracion.admin_email_for_reports,
                subject: `¡Nuevo Comprobante de Venta Subido! - Rifa Nro. ${venta.numero_sorteo_correlativo}`,
                html: `
                    <p>Se ha subido un nuevo comprobante para la venta de la rifa.</p>
                    <p><strong>ID Venta:</strong> ${venta.id}</p>
                    <p><strong>Comprador:</strong> ${venta.comprador}</p>
                    <p><strong>Teléfono:</strong> ${venta.telefono}</p>
                    <p><strong>Números:</strong> ${venta.numeros.join(', ')}</p>
                    <p><strong>Monto:</strong> $${venta.valor_usd.toFixed(2)} (Bs ${venta.valor_bs.toFixed(2)})</p>
                    <p><strong>Método de Pago:</strong> ${venta.metodo_pago}</p>
                    <p><strong>Referencia:</strong> ${venta.referencia_pago}</p>
                    <p><strong>Fecha Sorteo:</strong> ${venta.fecha_sorteo}</p>
                    <p><strong>Ver Comprobante:</strong> <a href="${fileUrl}">${fileUrl}</a></p>
                    <p>Por favor, revisa el panel de administración.</p>
                `,
            };

            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    console.error('Error al enviar correo de notificación:', error);
                } else {
                    console.log('Correo de notificación enviado:', info.response);
                }
            });
        }


        res.json({ message: 'Comprobante subido y venta actualizada con éxito.', venta: venta, url: fileUrl });
    } catch (error) {
        console.error('Error al subir comprobante:', error);
        res.status(500).json({ message: 'Error al subir el comprobante. Intenta de nuevo.' });
    }
});


// Ruta para marcar un comprobante como revisado y eliminarlo de la lista de pendientes (Panel Admin)
app.post('/marcar-comprobante-revisado', async (req, res) => {
    const { id_registro_comprobante } = req.body;

    if (!id_registro_comprobante) {
        return res.status(400).json({ message: 'ID del registro de comprobante es requerido.' });
    }

    const initialLength = comprobantesRegistros.length;
    comprobantesRegistros = comprobantesRegistros.filter(c => c.id !== id_registro_comprobante);

    if (comprobantesRegistros.length === initialLength) {
        return res.status(404).json({ message: 'Comprobante no encontrado en la lista de registros.' });
    }

    await writeJsonFile(COMPROBANTES_REGISTRO_FILE, comprobantesRegistros);
    res.json({ message: 'Comprobante marcado como revisado y eliminado con éxito.', comprobantesRegistros });
});


// Ruta para realizar corte de ventas y reiniciar números (Panel Admin)
app.post('/corte-ventas', async (req, res) => {
    try {
        // Generar todos los números del 000 al 999 para el nuevo sorteo
        let newNumerosDisponibles = [];
        for (let i = 0; i <= 999; i++) {
            newNumerosDisponibles.push(String(i).padStart(3, '0'));
        }
        numerosDisponibles = newNumerosDisponibles;
        await writeJsonFile(NUMEROS_FILE, numerosDisponibles); // Guardar los números reiniciados

        // Resetear el último número de ticket
        configuracion.ultimo_numero_ticket = 0;

        // Incrementar el número de sorteo correlativo
        configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;

        // Actualizar la fecha del sorteo a mañana (o la lógica que desees para el siguiente sorteo)
        // Ejemplo: si el corte de ventas es para iniciar un nuevo sorteo al día siguiente
        // Esto podría ser también manejado por el panel admin para ajustar la fecha manualmente
        // configuracion.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');

        await writeJsonFile(CONFIG_FILE, configuracion);

        // Opcional: limpiar ventas registradas si cada corte significa un inicio de cero
        // ventasRegistradas = [];
        // await writeJsonFile(VENTAS_FILE, ventasRegistradas);

        res.json({ message: 'Corte de ventas realizado con éxito. Números reiniciados.', configuracion });
    } catch (error) {
        console.error('Error al realizar corte de ventas:', error);
        res.status(500).json({ message: 'Error interno del servidor al realizar corte de ventas.' });
    }
});

// Ruta para exportar ventas a Excel (Panel Admin)
app.get('/exportar-ventas', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ventas');

        // Definir columnas
        worksheet.columns = [
            { header: 'ID Venta', key: 'id', width: 30 },
            { header: 'Fecha/Hora Compra', key: 'fecha_hora_compra', width: 25 },
            { header: 'Fecha Sorteo', key: 'fecha_sorteo', width: 15 },
            { header: 'Nro. Sorteo', key: 'numero_sorteo_correlativo', width: 12 },
            { header: 'Nro. Ticket', key: 'nro_ticket', width: 12 },
            { header: 'Comprador', key: 'comprador', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 20 },
            { header: 'Números', key: 'numeros', width: 40 },
            { header: 'Valor USD', key: 'valor_usd', width: 15 },
            { header: 'Valor Bs', key: 'valor_bs', width: 15 },
            { header: 'Método de Pago', key: 'metodo_pago', width: 20 },
            { header: 'Referencia Pago', key: 'referencia_pago', width: 25 },
            { header: 'Estado', key: 'estado', width: 15 },
            { header: 'URL Comprobante', key: 'url_comprobante', width: 50 },
            { header: 'Fecha/Hora Comprobante', key: 'fecha_hora_comprobante_subido', width: 25 }
        ];

        // Añadir filas
        ventasRegistradas.forEach(venta => {
            worksheet.addRow({
                id: venta.id,
                fecha_hora_compra: venta.fecha_hora_compra,
                fecha_sorteo: venta.fecha_sorteo,
                numero_sorteo_correlativo: venta.numero_sorteo_correlativo,
                nro_ticket: venta.nro_ticket,
                comprador: venta.comprador,
                telefono: venta.telefono,
                numeros: venta.numeros ? venta.numeros.join(', ') : '',
                valor_usd: venta.valor_usd,
                valor_bs: venta.valor_bs,
                metodo_pago: venta.metodo_pago,
                referencia_pago: venta.referencia_pago,
                estado: venta.estado,
                url_comprobante: venta.url_comprobante,
                fecha_hora_comprobante: venta.fecha_hora_comprobante_subido
            });
        });

        // Configurar cabeceras de respuesta para descarga
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Reporte_Ventas_${moment().format('YYYYMMDD_HHmmss')}.xlsx`);

        // Enviar el archivo Excel
        await workbook.xlsx.write(res);
        res.end();

    } catch (error) {
        console.error('Error al exportar ventas a Excel:', error);
        res.status(500).json({ message: 'Error interno del servidor al exportar ventas.' });
    }
});


// Lógica de cron job para corte de ventas y reinicio de números (si aplica)
cron.schedule('0 0 * * *', async () => { // Ejecuta a medianoche todos los días (00:00)
    console.log('Ejecutando tarea programada de corte de ventas y reinicio de números...');
    try {
        const todayFormatted = moment().tz("America/Caracas").format('YYYY-MM-DD');
        // Asegúrate de que `configuracion.fecha_sorteo` esté en el formato 'YYYY-MM-DD'
        const currentDrawDate = configuracion.fecha_sorteo;

        // Compara fechas usando moment.js para mayor robustez
        const isPastOrToday = moment(currentDrawDate).isSameOrBefore(moment(todayFormatted));

        if (isPastOrToday) {
            // --- INICIO DE LA CORRECCIÓN PARA reiniciar números en cron ---
            // Regenerar todos los números para la nueva rifa del día siguiente
            let newNumerosDisponibles = [];
            for (let i = 0; i <= 999; i++) {
                newNumerosDisponibles.push(String(i).padStart(3, '0'));
            }
            numerosDisponibles = newNumerosDisponibles;
            await writeJsonFile(NUMEROS_FILE, numerosDisponibles); // Guardar los números reiniciados
            console.log("Números disponibles reiniciados para el nuevo sorteo.");
            // --- FIN DE LA CORRECCIÓN PARA reiniciar números en cron ---

            // Reiniciar ventas (si cada sorteo borra las ventas anteriores)
            // Descomenta y usa esto si quieres que las ventas se borren cada día
            // ventasRegistradas = [];
            // await writeJsonFile(VENTAS_FILE, ventasRegistradas);
            // console.log("Ventas registradas reiniciadas.");


            // Actualizar la fecha del sorteo para el día siguiente
            configuracion.fecha_sorteo = moment().tz("America/Caracas").add(1, 'days').format('YYYY-MM-DD');
            configuracion.numero_sorteo_correlativo = (configuracion.numero_sorteo_correlativo || 0) + 1;
            configuracion.ultimo_numero_ticket = 0; // Reiniciar el contador de tickets también, si aplica
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`Fecha del sorteo actualizada automáticamente a: ${configuracion.fecha_sorteo} y correlativo a ${configuracion.numero_sorteo_correlativo}.`);
        } else {
             console.log(`No es necesario reiniciar números o actualizar fecha de sorteo. La fecha de sorteo actual (${currentDrawDate}) es posterior a hoy (${todayFormatted}).`);
        }


    } catch (error) {
        console.error('Error en la tarea programada de corte de ventas y reinicio:', error);
    }
}, {
    timezone: "America/Caracas" // Asegúrate de que la zona horaria sea correcta para la ejecución del cron
});


// Inicialización del servidor
// Se eliminó ensureDataAndComprobantesDirs() ya que se ejecutará en loadInitialData ahora
ensureDataAndComprobantesDirs().then(() => {
    loadInitialData().then(() => {
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
            console.log(`Panel de administración disponible en: https://paneladmin01.netlify.app`); // Asegúrate de que esta URL sea correcta
            console.log(`Frontend principal disponible en: https://tuoportunidadeshoy.netlify.app`); // Asegúrate de que esta URL sea correcta
        });
    }).catch(err => {
        console.error('Fallo crítico al iniciar el servidor debido a error de carga de datos:', err);
        process.exit(1); // Sale del proceso si no se pueden cargar los datos iniciales
    });
}).catch(err => {
    console.error('Fallo crítico al iniciar el servidor debido a error de creación de directorios:', err);
    process.exit(1); // Sale del proceso si no se pueden crear los directorios
});
