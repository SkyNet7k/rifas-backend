// server.js

const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs').promises; // Para operaciones asíncronas de archivos
const { readFileSync } = require('fs'); // Para leer archivos de configuración locales de forma síncrona
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dotenv = require('dotenv');
const ExcelJS = require('exceljs');
const moment = require('moment-timezone');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid'); // Para generar IDs únicos
const crypto = require('crypto'); // Para generar IDs únicos si es necesario

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware para parsear JSON y archivos
app.use(express.json());
app.use(fileUpload());

// Constantes y configuraciones
const CARACAS_TIMEZONE = 'America/Caracas';
const API_BASE_URL = process.env.API_BASE_URL || 'https://rifas-t-loterias.onrender.com';

// Rutas a tus directorios y archivos JSON locales
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // Para comprobantes
const REPORTS_DIR = path.join(__dirname, 'reports'); // Para reportes Excel

const CONFIG_FILE = path.join(__dirname, 'configuracion.json');
const NUMEROS_FILE = path.join(__dirname, 'numeros.json');
const HORARIOS_ZULIA_FILE = path.join(__dirname, 'horarios_zulia.json');
const PREMIOS_FILE = path.join(__dirname, 'premios.json');
const VENTAS_FILE = path.join(__dirname, 'ventas.json');
const RESULTADOS_ZULIA_FILE = path.join(__dirname, 'resultados_zulia.json');
const GANADORES_FILE = path.join(__dirname, 'ganadores.json');
const COMPROBANTES_FILE = path.join(__dirname, 'comprobantes.json'); // Para el registro de comprobantes


// --- Variables globales en memoria (caché de datos de los archivos JSON) ---
let configuracion = {};
let numeros = []; // Caché de los 1000 números de la rifa (estado comprado/no comprado)
let horariosZulia = { zulia: [], chance: [] };
let premios = {}; // Caché para los premios
let ventas = []; // Caché para las ventas
let resultadosZulia = []; // Caché para los resultados de Zulia
let ganadores = []; // Caché para los ganadores
let comprobantes = []; // Caché para los comprobantes (metadata)

const SALES_THRESHOLD_PERCENTAGE = 80;
const DRAW_SUSPENSION_HOUR = 12;
const DRAW_SUSPENSION_MINUTE = 15;
const TOTAL_RAFFLE_NUMBERS = 1000;

// --- Funciones Auxiliares para Operaciones con Archivos JSON ---

/**
 * Lee un archivo JSON y devuelve su contenido. Si el archivo no existe, lo crea con un valor por defecto.
 * @param {string} filePath - La ruta al archivo JSON.
 * @param {any} defaultValue - El valor por defecto si el archivo no existe.
 * @returns {Promise<object|Array>} El contenido parseado del JSON.
 */
async function readJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found
            console.warn(`Archivo no encontrado: ${filePath}. Creando con valor por defecto.`);
            await writeJsonFile(filePath, defaultValue); // Create with default
            return defaultValue;
        }
        console.error(`Error leyendo ${filePath}:`, error);
        throw error;
    }
}

/**
 * Escribe datos en un archivo JSON.
 * @param {string} filePath - La ruta al archivo JSON.
 * @param {object|Array} data - Los datos a escribir.
 * @returns {Promise<void>}
 */
async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`Datos escritos en ${filePath}`);
    } catch (error) {
        console.error(`Error escribiendo ${filePath}:`, error);
        throw error;
    }
}

// Función para asegurar que los directorios existan (solo para archivos locales como comprobantes y reportes)
async function ensureDataAndComprobantesDirs() {
    try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.mkdir(REPORTS_DIR, { recursive: true });
        console.log('Directorios locales asegurados.');
    } catch (error) {
        console.error('Error al asegurar directorios locales:', error);
    }
}

// Carga inicial de datos desde archivos JSON locales
async function loadInitialData() {
    console.log('Iniciando carga inicial de datos desde archivos JSON locales...');

    try {
        configuracion = await readJsonFile(CONFIG_FILE, {
            tasa_dolar: 36.50,
            pagina_bloqueada: false,
            fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            precio_ticket: 3.00,
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            ultima_fecha_resultados_zulia: null,
            admin_whatsapp_numbers: [],
            mail_config: { host: "", port: 587, secure: false, user: "", pass: "", senderName: "" },
            admin_email_for_reports: [],
            raffleNumbersInitialized: false, // Nuevo flag para inicialización de números
            last_sales_notification_count: 0,
            sales_notification_threshold: 20,
            block_reason_message: ""
        });

        // Asegurar que la configuración tenga los valores por defecto si faltan
        if (typeof configuracion.raffleNumbersInitialized === 'undefined') configuracion.raffleNumbersInitialized = false;
        if (Array.isArray(configuracion.tasa_dolar) || typeof configuracion.tasa_dolar !== 'number') configuracion.tasa_dolar = 36.50;
        if (!configuracion.fecha_sorteo || !moment(configuracion.fecha_sorteo, 'YYYY-MM-DD', true).isValid()) {
            configuracion.fecha_sorteo = moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD');
        }
        if (!configuracion.mail_config) configuracion.mail_config = { host: "", port: 587, secure: false, user: "", pass: "", senderName: "" };
        if (!configuracion.admin_whatsapp_numbers) configuracion.admin_whatsapp_numbers = [];
        if (!configuracion.admin_email_for_reports) configuracion.admin_email_for_reports = [];
        if (typeof configuracion.last_sales_notification_count === 'undefined') configuracion.last_sales_notification_count = 0;
        if (typeof configuracion.sales_notification_threshold === 'undefined') configuracion.sales_notification_threshold = 20;
        if (typeof configuracion.block_reason_message === 'undefined') configuracion.block_reason_message = "";


        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, { zulia: [], chance: [] });
        if (Array.isArray(horariosZulia)) { // Compatibilidad con formato antiguo si era un array
            horariosZulia = { zulia: horariosZulia, chance: [] };
        }
        if (!horariosZulia.zulia) horariosZulia.zulia = [];
        if (!horariosZulia.chance) horariosZulia.chance = [];

        premios = await readJsonFile(PREMIOS_FILE, {});
        ventas = await readJsonFile(VENTAS_FILE, []);
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []);
        ganadores = await readJsonFile(GANADORES_FILE, []);
        comprobantes = await readJsonFile(COMPROBANTES_FILE, []);


        // Inicializar colección de números de rifa si no ha sido inicializada
        if (!configuracion.raffleNumbersInitialized) {
            console.warn('Flag "raffleNumbersInitialized" es false. Inicializando colección de números de rifa.');
            const initialNumbers = [];
            for (let i = 0; i < TOTAL_RAFFLE_NUMBERS; i++) {
                const numStr = i.toString().padStart(3, '0');
                initialNumbers.push({ numero: numStr, comprado: false, originalDrawNumber: null });
            }
            await writeJsonFile(NUMEROS_FILE, initialNumbers);
            numeros = initialNumbers;
            configuracion.raffleNumbersInitialized = true;
            await writeJsonFile(CONFIG_FILE, configuracion); // Guardar la configuración actualizada
            console.log('Colección de números de rifa inicializada y flag actualizado.');
        } else {
            numeros = await readJsonFile(NUMEROS_FILE, []);
            if (numeros.length === 0 && TOTAL_RAFFLE_NUMBERS > 0) { // Si el archivo existe pero está vacío
                console.warn('Archivo de números de rifa vacío. Reinicializando con 1000 números por defecto.');
                const initialNumbers = [];
                for (let i = 0; i < TOTAL_RAFFLE_NUMBERS; i++) {
                    const numStr = i.toString().padStart(3, '0');
                    initialNumbers.push({ numero: numStr, comprado: false, originalDrawNumber: null });
                }
                await writeJsonFile(NUMEROS_FILE, initialNumbers);
                numeros = initialNumbers;
            }
        }

        console.log('Datos iniciales cargados desde los archivos JSON locales.');
    } catch (err) {
        console.error('Error CRÍTICO al cargar los archivos JSON locales. Asegúrate de que existan y sean válidos:', err);
        process.exit(1);
    }
}

// Configuración de Nodemailer
let transporter;
function configureMailer() {
    const emailUser = process.env.EMAIL_USER || configuracion.mail_config.user;
    const emailPass = process.env.EMAIL_PASS || configuracion.mail_config.pass;

    if (configuracion.mail_config && emailUser && emailPass) {
        transporter = nodemailer.createTransport({
            host: configuracion.mail_config.host,
            port: configuracion.mail_config.port,
            secure: configuracion.mail_config.secure,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });
        console.log('Nodemailer configurado.');
    } else {
        console.warn('Configuración de correo incompleta. El envío de correos no funcionará.');
        transporter = null;
    }
}

/**
 * Envía un correo electrónico utilizando el transporter configurado.
 * Ahora 'to' puede ser una cadena de texto (un solo correo) o un array de cadenas (múltiples correos).
 * @param {string|string[]} to - Dirección(es) de correo del destinatario(s).
 * @param {string} subject - Asunto del correo.
 * @param {string} html - Contenido HTML del correo.
 * @param {Array} attachments - Array de adjuntos para el correo (opcional).
 * @returns {Promise<boolean>} True si el correo se envió con éxito, false en caso contrario.
 */
async function sendEmail(to, subject, html, attachments = []) {
    if (!transporter) {
        console.error('Mailer no configurado. No se pudo enviar el correo.');
        return false;
    }
    try {
        const recipients = Array.isArray(to) ? to.join(',') : to;
        const mailOptions = {
            from: `${configuracion.mail_config.senderName || 'Sistema de Rifas'} <${configuracion.mail_config.user}>`,
            to: recipients,
            subject,
            html,
            attachments
        };
        await transporter.sendMail(mailOptions);
        console.log('Correo enviado exitosamente.');
        return true;
    }  catch (error) {
        console.error('Error al enviar correo:', error.message);
        return false;
    }
}

/**
 * Envía una notificación de resumen de ventas o mensajes personalizados por WhatsApp a los números de administrador configurados.
 * Esto genera una URL de wa.me y la imprime en consola, ya que el envío directo de WhatsApp requiere integración con una API externa.
 * @param {string} messageText - El texto del mensaje a enviar.
 */
async function sendWhatsappNotification(messageText) {
    try {
        const encodedMessage = encodeURIComponent(messageText);

        if (configuracion.admin_whatsapp_numbers && configuracion.admin_whatsapp_numbers.length > 0) {
            console.log(`\n--- Notificación de WhatsApp para Administradores ---`);
            configuracion.admin_whatsapp_numbers.forEach(adminNumber => {
                const whatsappUrl = `https://api.whatsapp.com/send?phone=${adminNumber}&text=${encodedMessage}`;
                console.log(`[WhatsApp Link for ${adminNumber}]: ${whatsappUrl}`);
            });
            console.log('--- Fin Notificación de WhatsApp ---\n');
            console.log('NOTA: Los enlaces de WhatsApp se han generado y mostrado en la consola. Para el envío automático real, se requiere una integración con un proveedor de WhatsApp API (ej. Twilio, Vonage, WhatsApp Business API).');
        } else {
            console.warn('No hay números de WhatsApp de administrador configurados para enviar notificaciones.');
        }

    } catch (error) {
        console.error('Error al enviar notificación por WhatsApp:', error.message);
    }
}

// Función auxiliar para enviar notificación de resumen de ventas (WhatsApp y Email)
async function sendSalesSummaryNotifications() {
    // Recargar configuración para asegurar que `last_sales_notification_count` y `sales_notification_threshold` estén al día.
    configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Cargar la más reciente

    console.log('[sendSalesSummaryNotifications] Iniciando notificación de resumen de ventas.');
    const now = moment().tz(CARACAS_TIMEZONE);

    // Obtener ventas directamente de la caché (que se actualiza al inicio)
    const ventasParaFechaSorteo = ventas.filter(venta => 
        venta.drawDate === configuracion.fecha_sorteo && 
        (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
    );

    const totalVentas = ventasParaFechaSorteo.length;
    const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
    const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

    const whatsappMessageText = `*Actualización de Ventas Lotería:*\n\n` +
                                `Fecha Sorteo: *${configuracion.fecha_sorteo}*\n` +
                                `Sorteo Nro: *${configuracion.numero_sorteo_correlativo}*\n` +
                                `Total de Ventas Actuales (Confirmadas/Pendientes): *${totalVentas}* tickets vendidos.\n\n` +
                                `Porcentaje de Ventas: *${soldPercentage.toFixed(2)}%*\n\n` +
                                `Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}`;
    await sendWhatsappNotification(whatsappMessageText);

    try {
        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
                ventasParaFechaSorteo,
                configuracion,
                'Reporte de Ventas Periódico',
                'Reporte_Ventas_Periodico'
            );

            const emailSubject = `Reporte de Ventas Periódico - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Se ha generado un reporte de ventas periódico para el sorteo del día <strong>${configuracion.fecha_sorteo}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${ventasParaFechaSorteo.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0).toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${ventasParaFechaSorteo.reduce((sum, venta) => sum + (venta.valueBs || 0), 0).toFixed(2)}</p>
                <p><b>Porcentaje de Tickets Vendidos:</b> ${soldPercentage.toFixed(2)}%</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
                <p>Última actualización: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de reporte de ventas periódico.');
            }
        }
    } catch (emailError) {
        console.error('Error al generar o enviar el reporte de ventas periódico por correo:', emailError.message);
    }
}


// ===============================================
// === ENDPOINTS DE LA API =======================
// ===============================================

app.get('/', (req, res) => {
    res.status(200).json({ message: 'Servidor de la API de Loterías activo. Accede a las rutas /api/ para interactuar.' });
});

// Configuración de CORS explícita y exclusiva para múltiples orígenes
const allowedOrigins = ['https://paneladmin01.netlify.app', 'https://tuoportunidadeshoy.netlify.app'];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Handle preflight requests (OPTIONS) - sometimes explicit handling is needed
app.options('*', cors()); // Enable pre-flight across all routes


// Obtener configuración
app.get('/api/configuracion', async (req, res) => {
    try {
        // Leer siempre del archivo para asegurar la última versión
        configuracion = await readJsonFile(CONFIG_FILE, configuracion);
        const configToSend = { ...configuracion };
        delete configToSend.mail_config; // No enviar credenciales sensibles
        res.json(configToSend);
    } catch (error) {
        console.error('Error al obtener configuración:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener configuración.' });
    }
});

// Actualizar configuración (Cambiado de POST a PUT)
app.put('/api/configuracion', async (req, res) => {
    const newConfig = req.body;
    try {
        // Leer la configuración más reciente del archivo para asegurar consistencia
        let currentConfig = await readJsonFile(CONFIG_FILE, configuracion); // Usar la caché como fallback
        
        Object.keys(newConfig).forEach(key => {
            if (currentConfig.hasOwnProperty(key) && key !== 'mail_config') {
                currentConfig[key] = newConfig[key];
            }
        });

        if (newConfig.admin_email_for_reports !== undefined) {
            currentConfig.admin_email_for_reports = Array.isArray(newConfig.admin_email_for_reports)
                                                      ? newConfig.admin_email_for_reports
                                                      : [newConfig.admin_email_for_reports].filter(Boolean);
        }
        if (newConfig.admin_whatsapp_numbers !== undefined) {
            currentConfig.admin_whatsapp_numbers = Array.isArray(newConfig.admin_whatsapp_numbers)
                                                    ? newConfig.admin_whatsapp_numbers
                                                    : [newConfig.admin_whatsapp_numbers].filter(Boolean);
        }
        if (newConfig.last_sales_notification_count !== undefined) {
            currentConfig.last_sales_notification_count = parseInt(newConfig.last_sales_notification_count, 10);
        }
        if (newConfig.sales_notification_threshold !== undefined) {
            currentConfig.sales_notification_threshold = parseInt(newConfig.sales_notification_threshold, 10);
        }
        if (newConfig.block_reason_message !== undefined) {
            currentConfig.block_reason_message = newConfig.block_reason_message;
        }


        await writeJsonFile(CONFIG_FILE, currentConfig);
        configuracion = currentConfig; // Actualizar la caché en memoria

        res.json({ message: 'Configuración actualizada con éxito', configuracion: configuracion });
    } catch (error) {
        console.error('Error al actualizar configuración:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar configuración.' });
    }
});


// Obtener estado de los números (AHORA LEE DIRECTAMENTE DEL ARCHIVO LOCAL)
app.get('/api/numeros', async (req, res) => {
    try {
        numeros = await readJsonFile(NUMEROS_FILE, []); // Recargar para asegurar la última versión
        console.log('DEBUG_BACKEND: Recibida solicitud GET /api/numeros. Enviando estado actual de numeros desde archivo local.');
        res.json(numeros);
    } catch (error) {
        console.error('Error al obtener números desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener números.', error: error.message });
    }
});

// Actualizar estado de los números (usado internamente o por admin)
app.post('/api/numeros', async (req, res) => {
    const updatedNumbers = req.body;
    try {
        await writeJsonFile(NUMEROS_FILE, updatedNumbers);
        numeros = updatedNumbers; // Actualizar caché en memoria

        console.log('DEBUG_BACKEND: Números actualizados en archivo local y en caché.');
        res.json({ message: 'Números actualizados con éxito.' });
    } catch (error) {
        console.error('Error al actualizar números en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar números.' });
    }
});

// Ruta para obtener ventas (ahora siempre desde archivo local)
app.get('/api/ventas', async (req, res) => {
    try {
        ventas = await readJsonFile(VENTAS_FILE, []); // Recargar para asegurar la última versión
        console.log('Enviando ventas al frontend desde archivo local:', ventas.length, 'ventas.');
        res.status(200).json(ventas);
    } catch (error) {
        console.error('Error al obtener ventas desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener ventas.', error: error.message });
    }
});


// Manejar solicitudes GET inesperadas a /api/compra
app.get('/api/compra', (req, res) => {
    res.status(404).json({
        message: 'Esta ruta no soporta solicitudes GET. Para realizar una una compra, utiliza el método POST en /api/comprar.',
        hint: 'Si estás intentando obtener información de ventas, usa la ruta GET /api/ventas.'
    });
});


// Ruta para la compra de tickets
app.post('/api/comprar', async (req, res) => {
    console.log('DEBUG_BACKEND: Recibida solicitud POST /api/comprar.');
    const { numerosSeleccionados, valorUsd, valorBs, metodoPago, referenciaPago, comprador, telefono, horaSorteo } = req.body;

    if (!numerosSeleccionados || numerosSeleccionados.length === 0 || !valorUsd || !valorBs || !metodoPago || !comprador || !telefono || !horaSorteo) {
        console.error('DEBUG_BACKEND: Faltan datos requeridos para la compra.');
        return res.status(400).json({ message: 'Faltan datos requeridos para la compra (números, valor, método de pago, comprador, teléfono, hora del sorteo).' });
    }

    configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Cargar la más reciente
    numeros = await readJsonFile(NUMEROS_FILE, numeros); // Cargar la más reciente
    ventas = await readJsonFile(VENTAS_FILE, ventas); // Cargar la más reciente

    if (configuracion.pagina_bloqueada) {
        console.warn('DEBUG_BACKEND: Página bloqueada, denegando compra.');
        return res.status(403).json({ message: 'La página está bloqueada para nuevas compras en este momento.' });
    }

    try {
        const conflictos = numerosSeleccionados.filter(n =>
            numeros.find(numObj => numObj.numero === n && numObj.comprado)
        );

        if (conflictos.length > 0) {
            console.warn(`DEBUG_BACKEND: Conflicto de números: ${conflictos.join(', ')} ya comprados.`);
            return res.status(409).json({ message: `Los números ${conflictos.join(', ')} ya han sido comprados. Por favor, selecciona otros.` });
        }

        numerosSeleccionados.forEach(numSel => {
            const numObjInCache = numeros.find(n => n.numero === numSel);
            if (numObjInCache) {
                numObjInCache.comprado = true;
                numObjInCache.originalDrawNumber = configuracion.numero_sorteo_correlativo;
            } else {
                // Esto no debería pasar si los números se inicializan correctamente
                numeros.push({ numero: numSel, comprado: true, originalDrawNumber: configuracion.numero_sorteo_correlativo });
            }
        });
        await writeJsonFile(NUMEROS_FILE, numeros);
        console.log('DEBUG_BACKEND: Números actualizados en archivo local y en caché.');

        const now = moment().tz("America/Caracas");
        configuracion.ultimo_numero_ticket = (configuracion.ultimo_numero_ticket || 0) + 1;
        const numeroTicket = configuracion.ultimo_numero_ticket.toString().padStart(5, '0');

        const nuevaVenta = {
            id: Date.now(), // Usar timestamp como ID único
            purchaseDate: now.toISOString(),
            drawDate: configuracion.fecha_sorteo,
            drawTime: horaSorteo,
            drawNumber: configuracion.numero_sorteo_correlativo,
            ticketNumber: numeroTicket,
            buyerName: comprador,
            buyerPhone: telefono,
            numbers: numerosSeleccionados,
            valueUSD: parseFloat(valorUsd),
            valueBs: parseFloat(valorBs),
            paymentMethod: metodoPago,
            paymentReference: referenciaPago,
            voucherURL: null,
            validationStatus: 'Pendiente'
        };

        ventas.push(nuevaVenta);
        await writeJsonFile(VENTAS_FILE, ventas);
        console.log('DEBUG_BACKEND: Venta guardada en archivo local.');

        await writeJsonFile(CONFIG_FILE, {
            ...configuracion, // Mantener el resto de la configuración
            ultimo_numero_ticket: configuracion.ultimo_numero_ticket
        });
        console.log('DEBUG_BACKEND: Configuración (ultimo_numero_ticket) actualizada en archivo local.');

        res.status(200).json({ message: 'Compra realizada con éxito!', ticket: nuevaVenta });
        console.log('DEBUG_BACKEND: Respuesta de compra enviada al frontend.');

        const whatsappMessageIndividual = `*¡Nueva Compra!*%0A%0A*Fecha Sorteo:* ${configuracion.fecha_sorteo}%0A*Hora Sorteo:* ${horaSorteo}%0A*Nro. Ticket:* ${numeroTicket}%0A*Comprador:* ${comprador}%0A*Teléfono:* ${telefono}%0A*Números:* ${numerosSeleccionados.join(', ')}%0A*Valor USD:* $${valorUsd}%0A*Valor Bs:* Bs ${valorBs}%0A*Método Pago:* ${metodoPago}%0A*Referencia:* ${referenciaPago}`;
        await sendWhatsappNotification(whatsappMessageIndividual);
        console.log('DEBUG_BACKEND: Proceso de compra en backend finalizado.');

        // Lógica de notificación por umbral de ventas (ahora con datos locales)
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar la más reciente

        const currentTotalSales = ventas.filter(sale => 
            sale.drawDate === configuracion.fecha_sorteo && 
            (sale.validationStatus === 'Confirmado' || sale.validationStatus === 'Pendiente')
        ).length;

        const prevNotifiedCount = configuracion.last_sales_notification_count || 0;
        const notificationThreshold = configuracion.sales_notification_threshold || 20;

        const currentMultiple = Math.floor(currentTotalSales / notificationThreshold);
        const prevMultiple = Math.floor(prevNotifiedCount / notificationThreshold);

        if (currentMultiple > prevMultiple) {
            console.log(`[WhatsApp Notificación Resumen] Ventas actuales (${currentTotalSales}) han cruzado un nuevo múltiplo (${currentMultiple * notificationThreshold}) del umbral (${notificationThreshold}). Enviando notificación de resumen.`);
            await sendSalesSummaryNotifications();

            configuracion.last_sales_notification_count = currentMultiple * notificationThreshold;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log(`[WhatsApp Notificación Resumen] Contador 'last_sales_notification_count' actualizado a ${currentMultiple * notificationThreshold} en archivo local.`);
        } else {
            console.log(`[WhatsApp Notificación Resumen Check] Ventas actuales (${currentTotalSales}) no han cruzado un nuevo múltiplo del umbral (${notificationThreshold}). Último contador notificado: ${prevNotifiedCount}. No se envió notificación de resumen.`);
        }

    } catch (error) {
        console.error('ERROR_BACKEND: Error al procesar la compra:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al procesar la compra.', error: error.message });
    }
});

// Subir comprobante de pago
app.post('/api/upload-comprobante/:ventaId', async (req, res) => {
    const ventaId = parseInt(req.params.ventaId);
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ message: 'No se subió ningún archivo.' });
    }

    const comprobanteFile = req.files.comprobante;
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(comprobanteFile.mimetype)) {
        return res.status(400).json({ message: 'Tipo de archivo no permitido. Solo se aceptan imágenes (JPG, PNG, GIF) y PDF.' });
    }

    ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar para asegurar la última versión
    let ventaIndex = ventas.findIndex(v => v.id === ventaId);
    if (ventaIndex === -1) {
        return res.status(404).json({ message: 'Venta no encontrada.' });
    }
    let ventaData = ventas[ventaIndex];

    const now = moment().tz("America/Caracas");
    const timestamp = now.format('YYYYMMDD_HHmmss');
    const originalExtension = path.extname(comprobanteFile.name);
    const fileName = `comprobante_${ventaId}_${timestamp}${originalExtension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    try {
        await comprobanteFile.mv(filePath);

        // Actualizar la URL del comprobante en la venta
        ventaData.voucherURL = `/uploads/${fileName}`;
        await writeJsonFile(VENTAS_FILE, ventas); // Guardar cambios en ventas.json
        console.log(`Voucher URL actualizado en archivo local para venta ${ventaId}.`);

        // Registrar en comprobantes.json (metadata)
        comprobantes = await readJsonFile(COMPROBANTES_FILE, []); // Recargar
        comprobantes.push({
            id: Date.now(), // Nuevo ID para el registro de comprobante
            ventaId: ventaId,
            comprador: ventaData.buyerName,
            telefono: ventaData.buyerPhone,
            comprobante_nombre: fileName,
            comprobante_tipo: comprobanteFile.mimetype,
            fecha_compra: moment(ventaData.purchaseDate).format('YYYY-MM-DD'),
            url_comprobante: `/uploads/${fileName}`
        });
        await writeJsonFile(COMPROBANTES_FILE, comprobantes);
        console.log(`Comprobante registrado en ${COMPROBANTES_FILE}.`);


        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const subject = `Nuevo Comprobante de Pago para Venta #${ventaData.ticketNumber}`;
            const htmlContent = `
                <p>Se ha subido un nuevo comprobante de pago para la venta con Ticket Nro. <strong>${ventaData.ticketNumber}</strong>.</p>
                <p><b>Comprador:</b> ${ventaData.buyerName}</p>
                <p><b>Teléfono:</b> ${ventaData.buyerPhone}</p>
                <p><b>Números:</b> ${ventaData.numbers.join(', ')}</p>
                <p><b>Monto USD:</b> $${ventaData.valueUSD.toFixed(2)}</p>
                <p><b>Monto Bs:</b> Bs ${ventaData.valueBs.toFixed(2)}</p>
                <p><b>Método de Pago:</b> ${ventaData.paymentMethod}</p>
                <p><b>Referencia:</b> ${ventaData.paymentReference}</p>
                <p>Haz clic <a href="${API_BASE_URL}/uploads/${fileName}" target="_blank">aquí</a> para ver el comprobante.</p>
                <p>También puedes verlo en el panel de administración.</p>
            `;
            const attachments = [
                {
                    filename: fileName,
                    path: filePath,
                    contentType: comprobanteFile.mimetype
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo con el comprobante.');
            }
        }

        res.status(200).json({ message: 'Comprobante subido y asociado con éxito.', url: `/uploads/${fileName}` });
    } catch (error) {
        console.error('Error al subir el comprobante:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al subir el comprobante.', error: error.message });
    }
});

// Servir archivos subidos estáticamente
app.use('/uploads', express.static(UPLOADS_DIR));


// Endpoint para obtener horarios de Zulia (y Chance)
app.get('/api/horarios-zulia', async (req, res) => {
    try {
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, horariosZulia); // Recargar la más reciente
        res.json(horariosZulia);
    } catch (error) {
        console.error('Error al obtener horarios de Zulia de archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener horarios.' });
    }
});

// Endpoint para actualizar horarios de Zulia (y Chance)
app.post('/api/horarios', async (req, res) => {
    const { tipo, horarios } = req.body;
    if (!tipo || (tipo !== 'zulia' && tipo !== 'chance')) {
        return res.status(400).json({ message: 'Tipo de lotería inválido. Debe ser "zulia" o "chance".' });
    }
    if (!Array.isArray(horarios) || !horarios.every(h => typeof h === 'string')) {
        return res.status(400).json({ message: 'Formato de horarios inválido. Espera un array de strings.' });
    }
    try {
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, horariosZulia); // Recargar la más reciente
        horariosZulia[tipo] = horarios;

        await writeJsonFile(HORARIOS_ZULIA_FILE, horariosZulia);
        console.log(`Horarios de ${tipo} actualizados en archivo local y caché.`);

        res.json({ message: `Horarios de ${tipo} actualizados con éxito.`, horarios: horariosZulia[tipo] });
    } catch (error) {
        console.error(`Error al actualizar horarios de ${tipo} en archivo local:`, error.message);
        res.status(500).json({ message: `Error interno del servidor al actualizar horarios de ${tipo}.` });
    }
});

// Endpoint para obtener los resultados de Zulia por fecha
app.get('/api/resultados-zulia', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha) {
        return res.status(400).json({ message: 'Se requiere el parámetro "fecha" para consultar resultados de Zulia.' });
    }

    try {
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []); // Recargar
        const resultsForDateAndZulia = resultadosZulia.filter(r =>
            r.fecha === fecha && r.tipoLoteria === 'zulia'
        );

        res.status(200).json(resultsForDateAndZulia);
    }
    catch (error) {
        console.error('Error al obtener resultados de Zulia desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de Zulia.', error: error.message });
    }
});


// Endpoint para obtener los últimos resultados del sorteo (ahora siempre desde archivo local)
app.get('/api/resultados-sorteo', async (req, res) => {
    try {
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []); // Recargar
        console.log('Enviando resultados de sorteo al frontend desde archivo local:', resultadosZulia.length, 'resultados.');
        res.status(200).json(resultadosZulia);
    } catch (error) {
        console.error('Error al obtener resultados de sorteo desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener resultados de sorteo.', error: error.message });
    }
});

// Endpoint para guardar/actualizar los resultados del sorteo
app.post('/api/resultados-sorteo', async (req, res) => {
    const { fecha, tipoLoteria, resultadosPorHora } = req.body;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid() || !tipoLoteria || !Array.isArray(resultadosPorHora)) {
        return res.status(400).json({ message: 'Faltan datos requeridos (fecha, tipoLoteria, resultadosPorHora) o el formato es inválido.' });
    }

    const now = moment().tz("America/Caracas");
    const currentDay = now.format('YYYY-MM-DD');

    try {
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []); // Recargar
        const existingResultIndex = resultadosZulia.findIndex(r =>
            r.fecha === fecha && r.tipoLoteria === tipoLoteria
        );

        const dataToSave = {
            fecha,
            tipoLoteria,
            resultados: resultadosPorHora,
            ultimaActualizacion: now.format('YYYY-MM-DD HH:mm:ss')
        };

        if (existingResultIndex !== -1) {
            resultadosZulia[existingResultIndex] = dataToSave;
        } else {
            resultadosZulia.push(dataToSave);
        }
        await writeJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia);
        console.log('Resultados de sorteo guardados/actualizados en archivo local y caché.');

        if (fecha === currentDay && tipoLoteria === 'zulia') {
            configuracion.ultima_fecha_resultados_zulia = fecha;
            await writeJsonFile(CONFIG_FILE, configuracion);
            console.log('Configuración (ultima_fecha_resultados_zulia) actualizada en archivo local.');
        }

        res.status(200).json({ message: 'Resultados de sorteo guardados/actualizados con éxito.' });
    } catch (error) {
        console.error('Error al guardar/actualizar resultados de sorteo en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al guardar/actualizar resultados de sorteo.', error: error.message });
    }
});

/**
 * Genera un reporte de ventas en formato Excel y lo guarda en el directorio de reportes.
 * @param {Array} salesData - Array de objetos de ventas a incluir en el reporte.
 * @param {Object} config - Objeto de configuración actual (o relevante para el contexto del reporte).
 * @param {string} reportTitle - Título principal del reporte (ej., "Corte de Ventas", "Reporte de Suspensión").
 * @param {string} fileNamePrefix - Prefijo para el nombre del archivo (ej., "Corte_Ventas", "Reporte_Suspension").
 * @returns {Promise<{excelFilePath: string, excelFileName: string}>} Objeto con la ruta y el nombre del archivo Excel generado.
 */
async function generateGenericSalesExcelReport(salesData, config, reportTitle, fileNamePrefix) {
    console.log(`[DEBUG_EXCEL] Iniciando generateGenericSalesExcelReport para: ${reportTitle}`);
    console.log(`[DEBUG_EXCEL] salesData recibida (${salesData.length} items):`, JSON.stringify(salesData.slice(0, 5), null, 2), `... (total: ${salesData.length} items)`); // Limitar log

    const now = moment().tz(CARACAS_TIMEZONE);
    const todayFormatted = now.format('YYYY-MM-DD');

    const totalVentasUSD = salesData.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0);
    const totalVentasBs = salesData.reduce((sum, venta) => sum + (venta.valueBs || 0), 0);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(reportTitle);

    worksheet.columns = [
        { header: 'Campo', key: 'field', width: 25 },
        { header: 'Valor', key: 'value', width: 40 }
    ];

    worksheet.addRow({ field: 'Título del Reporte', value: reportTitle });
    worksheet.addRow({ field: 'Fecha y Hora del Reporte', value: now.format('YYYY-MM-DD HH:mm:ss') });
    worksheet.addRow({ field: 'Fecha de Sorteo Reportado', value: config.fecha_sorteo || 'N/A' });
    worksheet.addRow({ field: 'Número de Sorteo Reportado', value: String(config.numero_sorteo_correlativo || 'N/A') });
    worksheet.addRow({ field: 'Total de Tickets Vendidos', value: String(salesData.length || 0) });
    worksheet.addRow({ field: 'Total Vendido USD', value: totalVentasUSD.toFixed(2) });
    worksheet.addRow({ field: 'Total Vendido Bs', value: totalVentasBs.toFixed(2) });

    worksheet.addRow({});
    worksheet.addRow({ field: 'Detalle de Ventas' });
    worksheet.addRow({});

    const ventasHeaders = [
        { header: 'ID Interno Venta', key: 'id', width: 20 },
        { header: 'Fecha/Hora Compra', key: 'purchaseDate', width: 25 },
        { header: 'Fecha Sorteo', key: 'drawDate', width: 15 },
        { header: 'Hora Sorteo', key: 'drawTime', width: 15 },
        { header: 'Nro. Sorteo', key: 'drawNumber', width: 15 },
        { header: 'Nro. Ticket', key: 'ticketNumber', width: 15 },
        { header: 'Comprador', key: 'buyerName', width: 25 },
        { header: 'Teléfono', key: 'buyerPhone', width: 20 },
        { header: 'Números', key: 'numbers', width: 30 },
        { header: 'Valor USD', key: 'valueUSD', width: 15 },
        { header: 'Valor Bs', key: 'valueBs', width: 15 },
        { header: 'Método de Pago', key: 'paymentMethod', width: 20 },
        { header: 'Referencia Pago', key: 'paymentReference', width: 20 },
        { header: 'URL Comprobante', key: 'voucherURL', width: 35 },
        { header: 'Estado Validación', key: 'validationStatus', width: 25 },
        { header: 'Razón Anulación', key: 'voidedReason', width: 30 },
        { header: 'Fecha Anulación', key: 'voidedAt', width: 25 },
        { header: 'Razón Cierre', key: 'closedReason', width: 30 },
        { header: 'Fecha Cierre', key: 'closedAt', width: 25 }
    ];
    worksheet.addRow(ventasHeaders.map(h => h.header));

    salesData.forEach((venta, index) => {
        worksheet.addRow({
            id: venta.id,
            purchaseDate: venta.purchaseDate ? moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            drawDate: venta.drawDate || '',
            drawTime: venta.drawTime || 'N/A',
            drawNumber: venta.drawNumber || '',
            ticketNumber: venta.ticketNumber || '',
            buyerName: venta.buyerName || '',
            buyerPhone: venta.buyerPhone || '',
            numbers: (Array.isArray(venta.numbers) ? venta.numbers.join(', ') : (venta.numbers || '')),
            valueUSD: venta.valueUSD || 0,
            valueBs: venta.valueBs || 0,
            paymentMethod: venta.paymentMethod || '',
            paymentReference: venta.paymentReference || '',
            voucherURL: venta.voucherURL ? `${API_BASE_URL}${venta.voucherURL}` : '',
            validationStatus: venta.validationStatus || 'Pendiente',
            voidedReason: venta.voidedReason || '',
            voidedAt: venta.voidedAt ? moment(venta.voidedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : '',
            closedReason: venta.closedReason || '',
            closedAt: venta.closedAt ? moment(venta.closedAt).tz(CARACAS_TIMEZONE).format('YYYY-MM-DD HH:mm:ss') : ''
        });
    });

    const excelFileName = `${fileNamePrefix}_${todayFormatted}_${now.format('HHmmss')}.xlsx`;
    const excelFilePath = path.join(REPORTS_DIR, excelFileName);
    await workbook.xlsx.writeFile(excelFilePath);

    console.log(`[DEBUG_EXCEL] Excel generado en: ${excelFilePath}`);
    return { excelFilePath, excelFileName };
}

/**
 * Genera un buffer ZIP que contiene archivos Excel para cada archivo JSON especificado.
 * @returns {Promise<Buffer>} Un buffer que representa el archivo ZIP.
 */
async function generateDatabaseBackupZipBuffer() {
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    const output = new (require('stream').PassThrough)();
    archive.pipe(output);

    try {
        const filesToExport = [
            { path: CONFIG_FILE, name: 'configuracion.json' },
            { path: NUMEROS_FILE, name: 'numeros.json' },
            { path: VENTAS_FILE, name: 'ventas.json' },
            { path: HORARIOS_ZULIA_FILE, name: 'horarios_zulia.json' },
            { path: RESULTADOS_ZULIA_FILE, name: 'resultados_zulia.json' },
            { path: PREMIOS_FILE, name: 'premios.json' },
            { path: GANADORES_FILE, name: 'ganadores.json' },
            { path: COMPROBANTES_FILE, name: 'comprobantes.json' }
        ];

        for (const fileInfo of filesToExport) {
            try {
                const data = await fs.readFile(fileInfo.path, 'utf8');
                const parsedData = JSON.parse(data);

                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet(fileInfo.name.replace('.json', ''));

                if (Array.isArray(parsedData) && parsedData.length > 0) {
                    const allKeys = new Set();
                    parsedData.forEach(row => {
                        Object.keys(row).forEach(key => allKeys.add(key));
                    });
                    const columns = Array.from(allKeys).map(key => ({ header: key, key: key, width: 25 }));
                    worksheet.columns = columns;
                    worksheet.addRow(columns.map(col => col.header));
                    parsedData.forEach(row => {
                        const rowData = {};
                        columns.forEach(col => {
                            if (Array.isArray(row[col.key])) {
                                rowData[col.key] = row[col.key].join(', ');
                            } else if (typeof row[col.key] === 'object' && row[col.key] !== null) {
                                rowData[col.key] = JSON.stringify(row[col.key]);
                            } else {
                                rowData[col.key] = row[col.key];
                            }
                        });
                        worksheet.addRow(rowData);
                    });
                } else if (typeof parsedData === 'object' && parsedData !== null) { // For single object JSONs like config or prizes
                    worksheet.columns = [
                        { header: 'Key', key: 'key', width: 30 },
                        { header: 'Value', key: 'value', width: 70 }
                    ];
                    worksheet.addRow(['Key', 'Value']);
                    for (const key in parsedData) {
                        let value = parsedData[key];
                        if (Array.isArray(value)) {
                            value = value.join(', ');
                        } else if (typeof value === 'object' && value !== null) {
                            value = JSON.stringify(value);
                        }
                        worksheet.addRow([key, value]);
                    }
                } else {
                    worksheet.addRow(['No data or unsupported format']);
                }

                const excelBuffer = await workbook.xlsx.writeBuffer();
                archive.append(excelBuffer, { name: `${fileInfo.name.replace('.json', '')}_backup.xlsx` });
            } catch (readError) {
                console.warn(`No se pudo leer o procesar ${fileInfo.path} para el respaldo: ${readError.message}. Se omitirá.`);
            }
        }
        
        archive.finalize();

        return new Promise((resolve, reject) => {
            const buffers = [];
            output.on('data', chunk => buffers.push(chunk));
            output.on('end', () => resolve(Buffer.concat(buffers)));
            archive.on('error', err => reject(err));
        });

    } catch (error) {
        console.error('Error al generar el buffer ZIP de la base de datos:', error.message);
        throw error;
    }
}


app.post('/api/corte-ventas', async (req, res) => {
    console.log('[DEBUG_CORTE_VENTAS] Iniciando corte de ventas...');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const todayFormatted = now.format('YYYY-MM-DD');

        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar la más reciente

        console.log('[DEBUG_CORTE_VENTAS] Configuración actual (desde archivo local):', JSON.stringify(configuracion, null, 2));

        const ventasDelDia = ventas.filter(venta =>
            venta.drawDate === configuracion.fecha_sorteo &&
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );

        console.log(`[DEBUG_CORTE_VENTAS] Ventas del día (${configuracion.fecha_sorteo}, Confirmadas/Pendientes) desde archivo local: ${ventasDelDia.length} items.`);
        console.log('[DEBUG_CORTE_VENTAS] Detalle de ventasDelDia (primeras 5):', JSON.stringify(ventasDelDia.slice(0, 5), null, 2));


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            ventasDelDia,
            configuracion,
            'Corte de Ventas',
            'Corte_Ventas'
        );
        console.log(`[DEBUG_CORTE_VENTAS] Excel de corte de ventas generado: ${excelFileName}`);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const totalVentasUSD = ventasDelDia.reduce((sum, venta) => sum + (venta.valueUSD || 0), 0);
            const totalVentasBs = ventasDelDia.reduce((sum, venta) => sum + (venta.valueBs || 0), 0);

            const subject = `Reporte de Corte de Ventas ${todayFormatted}`;
            const htmlContent = `
                <p>Se ha realizado el corte de ventas para el día <strong>${todayFormatted}</strong>.</p>
                <p><b>Total de Ventas USD:</b> $${totalVentasUSD.toFixed(2)}</p>
                <p><b>Total de Ventas Bs:</b> Bs ${totalVentasBs.toFixed(2)}</p>
                <p>Adjunto encontrarás el detalle completo en formato Excel.</p>
            `;
            const attachments = [
                {
                    filename: excelFileName,
                    path: excelFilePath,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, subject, htmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de corte de ventas.');
            } else {
                console.log('[DEBUG_CORTE_VENTAS] Correo de corte de ventas enviado.');
            }
        }

        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        horariosZulia = await readJsonFile(HORARIOS_ZULIA_FILE, horariosZulia); // Recargar la más reciente

        const fechaSorteoConfigurada = configuracion.fecha_sorteo;
        const zuliaTimes = horariosZulia.zulia;

        let ultimaHoraSorteo = null;
        if (Array.isArray(zuliaTimes) && zuliaTimes.length > 0) {
            ultimaHoraSorteo = zuliaTimes.reduce((latestTime, currentTimeStr) => {
                const latestMoment = moment.tz(`${fechaSorteoConfigurada} ${latestTime}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                const currentMoment = moment.tz(`${fechaSorteoConfigurada} ${currentTimeStr}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);
                return currentMoment.isAfter(latestMoment) ? currentTimeStr : latestTime;
            }, zuliaTimes[0]);
        }

        const currentMomentInCaracas = moment().tz(CARACAS_TIMEZONE);
        const drawDateMoment = moment(fechaSorteoConfigurada, 'YYYY-MM-DD').tz(CARACAS_TIMEZONE);

        let shouldResetNumbers = false;
        let message = 'Corte de ventas realizado. Los números no han sido reseteados según la hora de sorteo y reservas.';

        if (ultimaHoraSorteo) {
            const ultimaHoraSorteoMoment = moment.tz(`${fechaSorteoConfigurada} ${ultimaHoraSorteo}`, 'YYYY-MM-DD hh:mm A', CARACAS_TIMEZONE);

            if ((currentMomentInCaracas.isSame(drawDateMoment, 'day') && currentMomentInCaracas.isSameOrAfter(ultimaHoraSorteoMoment)) ||
                currentMomentInCaracas.isAfter(drawDateMoment, 'day')) {
                
                shouldResetNumbers = true;
                message = 'Corte de ventas realizado. Números procesados y reseteados condicionalmente.';
            } else {
                console.log(`[Corte de Ventas] No se realizó el reseteo de números porque la última hora de sorteo de Zulia (${ultimaHoraSorteo}) aún no ha pasado para la fecha ${fechaSorteoConfigurada}, o la fecha actual es anterior al sorteo.`);
            }
        } else {
            console.warn('[Corte de Ventas] No se encontraron horarios de Zulia válidos para determinar la última hora. El reseteo de números por tiempo no se ejecutará.');
        }

        if (shouldResetNumbers) {
            numeros = await readJsonFile(NUMEROS_FILE, numeros); // Recargar la más reciente
            const currentDrawCorrelativo = parseInt(configuracion.numero_sorteo_correlativo);
            let changedCount = 0;

            numeros.forEach(num => {
                if (num.comprado && num.originalDrawNumber < currentDrawCorrelativo - 1) {
                    num.comprado = false;
                    num.originalDrawNumber = null;
                    changedCount++;
                    console.log(`Número ${num.numero} liberado. Comprado originalmente para sorteo ${num.originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
                }
            });

            if (changedCount > 0) {
                await writeJsonFile(NUMEROS_FILE, numeros);
                console.log(`Se liberaron ${changedCount} números antiguos en archivo local.`);
            } else {
                console.log('No hay números antiguos para liberar en este momento.');
            }
        }

        res.status(200).json({ message: message });

    } catch (error) {
    console.error('Error al realizar Corte de Ventas en archivo local:', error.message);
    res.status(500).json({ message: 'Error interno del servidor al realizar Corte de Ventas.', error: error.message });
    }
});


// --- RUTAS PARA PREMIOS ---

app.get('/api/premios', async (req, res) => {
    const { fecha } = req.query;

    if (!fecha || !moment(fecha, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Se requiere una fecha válida (YYYY-MM-DD) para obtener los premios.' });
    }

    const fechaFormateada = moment.tz(fecha, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        premios = await readJsonFile(PREMIOS_FILE, premios); // Recargar la más reciente

        const premiosDelDia = premios[fechaFormateada] || {};

        const premiosParaFrontend = {
            fechaSorteo: fechaFormateada,
            sorteo12PM: premiosDelDia.sorteo12PM || { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: premiosDelDia.sorteo3PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' },
            sorteo5PM: premiosDelDia.sorteo5PM || { tripleA: '', tripleB: '', 'valorTripleA': '', 'valorTripleB': '' }
        };

        res.status(200).json(premiosParaFrontend);
    } catch (error) {
        console.error('Error al obtener premios de archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener premios.' });
    }
});

app.post('/api/premios', async (req, res) => {
    const { fechaSorteo, sorteo12PM, sorteo3PM, sorteo5PM } = req.body;

    if (!fechaSorteo || !moment(fechaSorteo, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'La fecha del sorteo (YYYY-MM-DD) es requerida y debe ser válida para guardar premios.' });
    }

    const fechaFormateada = moment.tz(fechaSorteo, CARACAS_TIMEZONE).format('YYYY-MM-DD');

    try {
        premios = await readJsonFile(PREMIOS_FILE, {}); // Recargar la más reciente

        premios[fechaFormateada] = {
            sorteo12PM: sorteo12PM ? {
                tripleA: sorteo12PM.tripleA || '',
                tripleB: sorteo12PM.tripleB || '',
                valorTripleA: sorteo12PM.valorTripleA || '',
                valorTripleB: sorteo12PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo3PM: sorteo3PM ? {
                tripleA: sorteo3PM.tripleA || '',
                tripleB: sorteo3PM.tripleB || '',
                valorTripleA: sorteo3PM.valorTripleA || '',
                valorTripleB: sorteo3PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' },
            sorteo5PM: sorteo5PM ? {
                tripleA: sorteo5PM.tripleA || '',
                tripleB: sorteo5PM.tripleB || '',
                valorTripleA: sorteo5PM.valorTripleA || '',
                valorTripleB: sorteo5PM.valorTripleB || ''
            } : { tripleA: '', tripleB: '', valorTripleA: '', valorTripleB: '' }
        };

        await writeJsonFile(PREMIOS_FILE, premios);
        console.log('Premios guardados/actualizados en archivo local y caché.');

        res.status(200).json({ message: 'Premios guardados/actualizados con éxito.', premiosGuardados: premios[fechaFormateada] });

    } catch (error) {
        console.error('Error al guardar premios en archivo local:', error.message);
        console.error('Detalle del error:', error.stack);
        res.status(500).json({ message: 'Error interno del servidor al guardar premios.', error: error.message });
    }
});

app.post('/api/send-test-email', async (req, res) => {
    try {
        const { to, subject, html } = req.body;

        if (!to || !subject || !html) {
            return res.status(400).json({ message: 'Faltan parámetros: "to", "subject" y "html" son obligatorios.' });
        }

        const emailSent = await sendEmail(to, subject, html);

        if (emailSent) {
            res.status(200).json({ message: 'Correo de prueba enviado exitosamente.' });
        } else {
            res.status(500).json({ message: 'Fallo al enviar el correo de prueba. Revisa la configuración del mailer y los logs del servidor.' });
        }
    } catch (error) {
        console.error('Error en la ruta /api/send-test-email:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al enviar correo de prueba.', error: error.message });
    }
});

app.put('/api/tickets/validate/:id', async (req, res) => {
    const ventaId = parseInt(req.params.id);
    const { validationStatus } = req.body;

    const estadosValidos = ['Confirmado', 'Falso', 'Pendiente'];
    if (!validationStatus || !estadosValidos.includes(validationStatus)) {
        return res.status(400).json({ message: 'Estado de validación inválido. Debe ser "Confirmado", "Falso" o "Pendiente".' });
    }

    try {
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar la más reciente
        let ventaIndex = ventas.findIndex(v => v.id === ventaId);
        if (ventaIndex === -1) {
            return res.status(404).json({ message: 'Venta no encontrada.' });
        }
        let ventaData = ventas[ventaIndex];

        const oldValidationStatus = ventaData.validationStatus;

        ventaData.validationStatus = validationStatus;
        await writeJsonFile(VENTAS_FILE, ventas); // Guardar cambios en ventas.json

        if (validationStatus === 'Falso' && oldValidationStatus !== 'Falso') {
            numeros = await readJsonFile(NUMEROS_FILE, numeros); // Recargar
            const numerosAnulados = ventaData.numbers;
            if (numerosAnulados && numerosAnulados.length > 0) {
                numerosAnulados.forEach(numAnulado => {
                    const numObj = numeros.find(n => n.numero === numAnulado);
                    if (numObj) {
                        numObj.comprado = false;
                        numObj.originalDrawNumber = null;
                    }
                });
                await writeJsonFile(NUMEROS_FILE, numeros);
                console.log(`Números ${numerosAnulados.join(', ')} de la venta ${ventaId} (marcada como Falsa) han sido puestos nuevamente disponibles en archivo local.`);
            }
        }

        res.status(200).json({ message: `Estado de la venta ${ventaId} actualizado a "${validationStatus}" con éxito.`, venta: { id: ventaId, ...ventaData, validationStatus: validationStatus } });
    } catch (error) {
        console.error(`Error al actualizar el estado de la venta ${ventaId} en archivo local:`, error.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el estado de la venta.', error: error.message });
    }
});


// Endpoint para exportar toda la base de datos en un archivo ZIP
app.get('/api/export-database', async (req, res) => {
    const archiveName = `rifas_db_backup_${moment().format('YYYYMMDD_HHmmss')}.zip`;
    res.attachment(archiveName);

    try {
        const zipBuffer = await generateDatabaseBackupZipBuffer();
        res.status(200).send(zipBuffer);
        console.log('Base de datos local exportada y enviada como ZIP.');
    } catch (error) {
        console.error('Error al exportar la base de datos:', error.message);
        res.status(500).send('Error al exportar la base de datos.');
    }
});

// Endpoint para generar el enlace de WhatsApp para un cliente (pago confirmado)
app.post('/api/generate-whatsapp-customer-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp.' });
    }

    try {
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar
        const venta = ventas.find(v => v.id === ventaId);
        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        const purchasedNumbers = venta.numbers.join(', ');
        const valorUsd = venta.valueUSD.toFixed(2);
        const valorBs = venta.valueBs.toFixed(2);
        const metodoPago = venta.paymentMethod;
        const referenciaPago = venta.paymentReference;
        const fechaCompra = moment(venta.purchaseDate).tz(CARACAS_TIMEZONE).format('DD/MM/YYYY HH:mm');

        const whatsappMessage = encodeURIComponent(
            `¡Hola! 👋 Su compra ha sido *confirmada* con éxito. \n\n` +
            `Detalles de su ticket:\n` +
            `*Número de Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${purchasedNumbers}\n` +
            `*Valor Pagado:* $${valorUsd} USD (Bs ${valorBs})\n` +
            `*Método de Pago:* ${metodoPago}\n` +
            (referenciaPago ? `*Referencia de Pago:* ${referenciaPago}\n` : '') +
            `*Fecha de Compra:* ${fechaCompra}\n\n` +
            `¡Mucha suerte en el sorteo! Estaremos informándole sobre los resultados.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para el cliente:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});

// Endpoint para generar el enlace de WhatsApp para notificar pago falso
app.post('/api/generate-whatsapp-false-payment-link', async (req, res) => {
    const { ventaId } = req.body;

    if (!ventaId) {
        return res.status(400).json({ message: 'ID de venta requerido para generar el enlace de WhatsApp para pago falso.' });
    }

    try {
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar
        const venta = ventas.find(v => v.id === ventaId);
        if (!venta) {
            return res.status(404).json({ message: 'Venta no encontrada para generar el enlace de WhatsApp de pago falso.' });
        }

        const customerPhoneNumber = venta.buyerPhone;
        const ticketNumber = venta.ticketNumber;
        const comprador = venta.buyerName || 'Estimado cliente';

        const whatsappMessage = encodeURIComponent(
            `¡Hola ${comprador}! 👋\n\n` +
            `Lamentamos informarle que su pago para la compra con Ticket N° *${ticketNumber}* no pudo ser verificado.\n\n` +
            `Por lo tanto, su compra ha sido *anulada*.\n\n` +
            `Si cree que esto es un error o tiene alguna pregunta, por favor, contáctenos para aclarar la situación.\n\n` +
            `Gracias por su comprensión.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${customerPhoneNumber}&text=${whatsappMessage}`;

        res.status(200).json({ whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para pago falso:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp para pago falso.', error: error.message });
    }
});

// Endpoint NUEVO: Para enviar notificación de ticket ganador vía WhatsApp
app.post('/api/notify-winner', async (req, res) => {
    const {
        ventaId, // No se usa directamente en el mensaje de WhatsApp, pero puede ser útil para logs
        buyerPhone,
        buyerName,
        numbers,
        drawDate,
        drawTime,
        ticketNumber,
        coincidentNumbers,
        totalPotentialPrizeBs,
        totalPotentialPrizeUSD
    } = req.body;

    if (!buyerPhone || !buyerName || !numbers || !drawDate || !drawTime || !ticketNumber || !coincidentNumbers || totalPotentialPrizeBs === undefined || totalPotentialPrizeUSD === undefined) {
        return res.status(400).json({ message: 'Faltan datos requeridos para enviar la notificación de ganador.' });
    }

    try {
        const formattedCoincidentNumbers = Array.isArray(coincidentNumbers) ? coincidentNumbers.join(', ') : coincidentNumbers;
        const formattedPurchasedNumbers = Array.isArray(numbers) ? numbers.join(', ') : numbers;

        const whatsappMessage = encodeURIComponent(
            `¡Felicidades, ${buyerName}! 🎉🥳🎉\n\n` +
            `¡Tu ticket ha sido *GANADOR* en el sorteo! 🥳\n\n` +
            `Detalles del Ticket:\n` +
            `*Nro. Ticket:* ${ticketNumber}\n` +
            `*Números Jugados:* ${formattedPurchasedNumbers}\n` +
            `*Fecha del Sorteo:* ${drawDate}\n` +
            `*Hora del Sorteo:* ${drawTime}\n` +
            `*Números Coincidentes:* ${formattedCoincidentNumbers}\n\n` +
            `*¡Has ganado!* 💰\n` +
            `*Premio Potencial:* $${parseFloat(totalPotentialPrizeUSD).toFixed(2)} USD (Bs ${parseFloat(totalPotentialPrizeBs).toFixed(2)})\n\n` +
            `Por favor, contáctanos para coordinar la entrega de tu premio.`
        );

        const whatsappLink = `https://api.whatsapp.com/send?phone=${buyerPhone}&text=${whatsappMessage}`;

        console.log(`Generado enlace de WhatsApp para notificar a ${buyerName} (${buyerPhone}): ${whatsappLink}`);

        res.status(200).json({ message: 'Enlace de notificación de WhatsApp generado con éxito. Se intentará abrir WhatsApp.', whatsappLink: whatsappLink });

    } catch (error) {
        console.error('Error al generar el enlace de WhatsApp para notificar al ganador:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al generar el enlace de WhatsApp.', error: error.message });
    }
});


// POST /api/tickets/procesar-ganadores
app.post('/api/tickets/procesar-ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.body;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos para procesar ganadores.' });
    }

    try {
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar
        resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, resultadosZulia); // Recargar
        premios = await readJsonFile(PREMIOS_FILE, premios); // Recargar
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar

        const ticketsGanadoresParaEsteSorteo = [];

        const resultadosDelDia = resultadosZulia.find(r =>
            r.fecha === fecha && r.tipoLoteria.toLowerCase() === tipoLoteria.toLowerCase()
        );

        if (!resultadosDelDia || !resultadosDelDia.resultados || resultadosDelDia.resultados.length === 0) {
            return res.status(200).json({ message: 'No se encontraron resultados de sorteo para esta fecha y lotería para procesar ganadores.' });
        }

        const premiosDelDia = premios[fecha];
        if (!premiosDelDia) {
            return res.status(200).json({ message: 'No se encontraron configuraciones de premios para esta fecha para procesar ganadores.' });
        }

        for (const venta of ventas) {
            if (venta.drawDate === fecha && venta.drawNumber.toString() === numeroSorteo.toString()) {
                let coincidentNumbers = [];
                let totalPotentialPrizeUSD = 0;
                let totalPotentialPrizeBs = 0;

                resultadosDelDia.resultados.forEach(r => {
                    const winningTripleA = r.tripleA ? r.tripleA.toString().padStart(3, '0') : null;
                    const winningTripleB = r.tripleB ? r.tripleB.toString().padStart(3, '0') : null;

                    let currentCoincidentNumbersForHour = [];

                    if (winningTripleA && venta.numbers.includes(winningTripleA)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleA, 10));
                    }
                    if (winningTripleB && venta.numbers.includes(winningTripleB)) {
                        currentCoincidentNumbersForHour.push(parseInt(winningTripleB, 10));
                    }

                    if (currentCoincidentNumbersForHour.length > 0) {
                        let prizeConfigForHour;
                        if (r.hora.includes('12:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo12PM;
                        } else if (r.hora.includes('04:45 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo3PM;
                        } else if (r.hora.includes('07:05 PM')) {
                            prizeConfigForHour = premiosDelDia.sorteo5PM;
                        }

                        if (prizeConfigForHour) {
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleA, 10)) && prizeConfigForHour.valorTripleA) {
                                totalPotentialPrizeUSD += parseFloat(prizeConfigForHour.valorTripleA);
                            }
                            if (currentCoincidentNumbersForHour.includes(parseInt(winningTripleB, 10)) && prizeConfigForHour.valorTripleB) {
                                totalPotentialPrizeUSD += parseFloat(prizeConfigForHour.valorTripleB);
                            }
                        }
                        coincidentNumbers = Array.from(new Set([...coincidentNumbers, ...currentCoincidentNumbersForHour]));
                    }
                });

                if (coincidentNumbers.length > 0) {
                    totalPotentialPrizeBs = totalPotentialPrizeUSD * configuracion.tasa_dolar;
                    ticketsGanadoresParaEsteSorteo.push({
                        ticketNumber: venta.ticketNumber,
                        buyerName: venta.buyerName,
                        buyerPhone: venta.buyerPhone,
                        numbers: venta.numbers,
                        drawDate: venta.drawDate,
                        drawNumber: venta.drawNumber,
                        purchaseDate: venta.purchaseDate,
                        coincidentNumbers: coincidentNumbers,
                        totalPotentialPrizeUSD: totalPotentialPrizeUSD,
                        totalPotentialPrizeBs: totalPotentialPrizeBs
                    });
                }
            }
        }

        ganadores = await readJsonFile(GANADORES_FILE, []); // Recargar
        const now = moment().tz(CARACAS_TIMEZONE).toISOString();
        const newWinnersEntry = {
            drawDate: fecha,
            drawNumber: parseInt(numeroSorteo),
            lotteryType: tipoLoteria,
            winners: ticketsGanadoresParaEsteSorteo,
            processedAt: now
        };

        const existingWinnersIndex = ganadores.findIndex(w =>
            w.drawDate === fecha && w.drawNumber === parseInt(numeroSorteo) && w.lotteryType === tipoLoteria
        );

        if (existingWinnersIndex !== -1) {
            ganadores[existingWinnersIndex] = newWinnersEntry;
        } else {
            ganadores.push(newWinnersEntry);
        }
        await writeJsonFile(GANADORES_FILE, ganadores);
        console.log(`Ganadores para el sorteo ${numeroSorteo} de ${tipoLoteria} del ${fecha} guardados/actualizados en archivo local.`);

        res.status(200).json({ message: 'Ganadores procesados y guardados con éxito.', totalGanadores: ticketsGanadoresParaEsteSorteo.length });

    } catch (error) {
        console.error('Error al procesar y guardar tickets ganadores en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al procesar y guardar tickets ganadores.', error: error.message });
    }
});


// GET /api/tickets/ganadores (ahora siempre desde archivo local)
app.get('/api/tickets/ganadores', async (req, res) => {
    const { fecha, numeroSorteo, tipoLoteria } = req.query;

    if (!fecha || !numeroSorteo || !tipoLoteria) {
        return res.status(400).json({ message: 'Fecha, número de sorteo y tipo de lotería son requeridos.' });
    }

    try {
        ganadores = await readJsonFile(GANADORES_FILE, []); // Recargar
        const foundEntry = ganadores.find(w =>
            w.drawDate === fecha && w.drawNumber === parseInt(numeroSorteo) && w.lotteryType === tipoLoteria
        );

        if (foundEntry) {
            res.status(200).json({ ganadores: foundEntry.winners });
        } else {
            res.status(200).json({ ganadores: [], message: 'No se encontraron tickets ganadores procesados para esta consulta.' });
        }
    } catch (error) {
        console.error('Error al obtener ganadores desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener ganadores.', error: error.message });
    }
});

// Función para liberar números que ya excedieron la reserva de 2 sorteos
async function liberateOldReservedNumbers(currentDrawCorrelativo) {
    console.log(`[liberateOldReservedNumbers] Revisando números para liberar (correlativo actual: ${currentDrawCorrelativo})...`);
    
    numeros = await readJsonFile(NUMEROS_FILE, numeros); // Recargar
    let changedCount = 0;

    numeros.forEach(num => {
        if (num.comprado && num.originalDrawNumber < currentDrawCorrelativo - 1) {
            num.comprado = false;
            num.originalDrawNumber = null;
            changedCount++;
            console.log(`Número ${num.numero} liberado. Comprado originalmente para sorteo ${num.originalDrawNumber}, ahora en sorteo ${currentDrawCorrelativo}.`);
        }
    });

    if (changedCount > 0) {
        await writeJsonFile(NUMEROS_FILE, numeros);
        console.log(`Se liberaron ${changedCount} números antiguos en archivo local.`);
    } else {
        console.log('No hay números antiguos para liberar en este momento.');
    }
}

// Función auxiliar para avanzar la configuración del sorteo (fecha, correlativo, último ticket)
async function advanceDrawConfiguration(currentConfig, targetDate) {
    const updatedConfig = {
        ...currentConfig, // Mantener el resto de la configuración
        fecha_sorteo: targetDate,
        numero_sorteo_correlativo: (currentConfig.numero_sorteo_correlativo || 0) + 1,
        ultimo_numero_ticket: 0,
        pagina_bloqueada: false,
        last_sales_notification_count: 0,
        block_reason_message: ""
    };
    await writeJsonFile(CONFIG_FILE, updatedConfig);
    configuracion = updatedConfig; // Actualizar caché

    console.log(`Configuración avanzada en archivo local para el siguiente sorteo: Fecha ${configuracion.fecha_sorteo}, Correlativo ${configuracion.numero_sorteo_correlativo}.`);
}


/**
 * Evalúa el estado del sorteo actual basándose en el porcentaje de ventas
 * y actualiza el estado de los tickets, sin avanzar la fecha del sorteo.
 * @param {moment.Moment} nowMoment - El objeto moment actual para la hora de Caracas.
 * @returns {Promise<Object>} Resultado de la evaluación.
 */
async function evaluateDrawStatusOnly(nowMoment) {
    console.log(`[evaluateDrawStatusOnly] Iniciando evaluación de estado de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar la más reciente
        
        const currentDrawDateStr = configuracion.fecha_sorteo;

        const soldTicketsForCurrentDraw = ventas.filter(venta => 
            venta.drawDate === currentDrawDateStr && 
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );
        const totalSoldTicketsCount = soldTicketsForCurrentDraw.length;


        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalSoldTicketsCount / totalPossibleTickets) * 100;

        console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados.`);

        let message = '';
        let whatsappMessageContent = '';
        let emailSubject = '';
        let emailHtmlContent = '';
        let excelReport = { excelFilePath: null, excelFileName: null };

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido. Marcando tickets como anulados.`);

            soldTicketsForCurrentDraw.forEach(venta => {
                const ventaIndex = ventas.findIndex(v => v.id === venta.id);
                if (ventaIndex !== -1) {
                    ventas[ventaIndex].validationStatus = 'Anulado por bajo porcentaje';
                    ventas[ventaIndex].voidedReason = 'Ventas insuficientes para el sorteo';
                    ventas[ventaIndex].voidedAt = nowMoment.toISOString();
                }
            });
            message = `Sorteo del ${currentDrawDateStr} marcado como anulado por ventas insuficientes.`;
            whatsappMessageContent = `*¡Alerta de Sorteo Suspendido!* 🚨\n\nEl sorteo del *${currentDrawDateStr}* ha sido *ANULADO* debido a un bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).\n\nTodos los tickets válidos para este sorteo serán revalidados automáticamente para el próximo sorteo.`;
            emailSubject = `ALERTA: Sorteo Anulado - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>ANULADO</strong>.</p>
                <p><b>Razón:</b> Bajo porcentaje de ventas (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento de la suspensión.</p>
                <p>Todos los tickets válidos para este sorteo han sido marcados para ser revalidados automáticamente para el próximo sorteo.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido ANULADO por bajo porcentaje de ventas. Tus tickets válidos han sido revalidados para el próximo sorteo. ¡Vuelve pronto!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                configuracion,
                `Reporte de Suspensión del Sorteo ${currentDrawDateStr}`,
                'Reporte_Suspension'
            );

        } else {
            console.log(`[evaluateDrawStatusOnly] Ventas (${soldPercentage.toFixed(2)}%) cumplen o superan el ${SALES_THRESHOLD_PERCENTAGE}%. Marcando tickets como cerrados.`);

            soldTicketsForCurrentDraw.forEach(venta => {
                const ventaIndex = ventas.findIndex(v => v.id === venta.id);
                if (ventaIndex !== -1) {
                    ventas[ventaIndex].validationStatus = 'Cerrado por Suficiencia de Ventas';
                    ventas[ventaIndex].closedReason = 'Ventas suficientes para el sorteo';
                    ventas[ventaIndex].closedAt = nowMoment.toISOString();
                }
            });
            message = `Sorteo del ${currentDrawDateStr} marcado como cerrado por suficiencia de ventas.`;
            whatsappMessageContent = `*¡Sorteo Cerrado Exitosamente!* ✅\n\nEl sorteo del *${currentDrawDateStr}* ha sido *CERRADO* con éxito. Se alcanzó el porcentaje de ventas (${soldPercentage.toFixed(2)}%) requerido.`;
            emailSubject = `NOTIFICACIÓN: Sorteo Cerrado Exitosamente - ${currentDrawDateStr}`;
            emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo del <strong>${currentDrawDateStr}</strong> ha sido <strong>CERRADO EXITOSAMENTE</strong>.</p>
                <p><b>Detalles:</b> Se alcanzó o superó el porcentaje de ventas requerido (${soldPercentage.toFixed(2)}%).</p>
                <p>Adjunto encontrarás el reporte de ventas al momento del cierre.</p>
                <p>La página de compra para este sorteo ha sido bloqueada. Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            configuracion.pagina_bloqueada = true;
            configuracion.block_reason_message = "El sorteo ha sido CERRADO exitosamente por haber alcanzado las ventas requeridas. No se aceptan más compras para este sorteo. ¡Gracias por participar!";

            excelReport = await generateGenericSalesExcelReport(
                soldTicketsForCurrentDraw,
                configuracion,
                `Reporte de Cierre del Sorteo ${currentDrawDateStr}`,
                'Reporte_Cierre'
            );
        }
        await writeJsonFile(VENTAS_FILE, ventas); // Guardar cambios en ventas.json
        await writeJsonFile(CONFIG_FILE, configuracion); // Guardar cambios en configuracion.json
        console.log('[evaluateDrawStatusOnly] Estado de ventas y configuración actualizados en archivo local.');

        await sendWhatsappNotification(whatsappMessageContent);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const attachments = excelReport.excelFilePath ? [{
                filename: excelReport.excelFileName,
                path: excelReport.excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de suspensión/cierre.');
            }
        }

        return { success: true, message: message, evaluatedDate: currentDrawDateStr, salesPercentage: soldPercentage };

    } catch (error) {
        console.error('[evaluateDrawStatusOnly] ERROR durante la evaluación del sorteo en archivo local:', error.message);
        return { success: false, message: `Error interno al evaluar estado de sorteo: ${error.message}` };
    }
}


// --- Lógica central para la verificación, anulación/cierre y AVANCE del sorteo (Cierre Manual) ---
async function cerrarSorteoManualmente(nowMoment) {
    console.log(`[cerrarSorteoManualmente] Iniciando cierre manual de sorteo en: ${nowMoment.format('YYYY-MM-DD HH:mm:ss')}`);

    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        
        const currentDrawCorrelativo = configuracion.numero_sorteo_correlativo;

        const evaluationResult = await evaluateDrawStatusOnly(nowMoment);
        if (!evaluationResult.success) {
            return evaluationResult;
        }

        await liberateOldReservedNumbers(currentDrawCorrelativo);

        const nextDayDate = nowMoment.clone().add(1, 'days').format('YYYY-MM-DD');
        await advanceDrawConfiguration(configuracion, nextDayDate);

        const whatsappMessage = `*¡Sorteo Finalizado y Avanzado!* 🥳\n\nEl sorteo del *${evaluationResult.evaluatedDate}* ha sido finalizado. Ventas: *${evaluationResult.salesPercentage.toFixed(2)}%*.\n\nLa configuración ha avanzado al Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha *${configuracion.fecha_sorteo}*.`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `CONFIRMACIÓN: Avance de Sorteo Manual - A Sorteo ${configuracion.numero_sorteo_correlativo}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les confirma que se ha realizado el <strong>avance de sorteo manual</strong>.</p>
                <p><b>Sorteo Anterior:</b> Fecha ${evaluationResult.evaluatedDate}, Ventas ${evaluationResult.salesPercentage.toFixed(2)}%</p>
                <p><b>Nuevo Sorteo Activo:</b> Nro. <b>${configuracion.numero_sorteo_correlativo}</b> para la fecha <b>${configuracion.fecha_sorteo}</b>.</p>
                <p>La página de compra ha sido desbloqueada para nuevas ventas.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de cierre manual y avance.');
            }
        }

        return {
            success: true,
            message: `${evaluationResult.message} y la configuración del sorteo ha avanzado para el siguiente.`,
            closedDate: evaluationResult.evaluatedDate,
            salesPercentage: evaluationResult.salesPercentage
        };

    } catch (error) {
        console.error('[cerrarSorteoManualmente] ERROR durante el cierre manual del sorteo en archivo local:', error.message);
        return { success: false, message: `Error interno: ${error.message}` };
    }
}


// --- ENDPOINT PARA CIERRE MANUAL DEL SORTEO (Full Close + Advance) ---
app.post('/api/cerrar-sorteo-manualmente', async (req, res) => {
    console.log('API: Recibida solicitud para cierre manual de sorteo.');
    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        
        const currentDrawDateStr = configuracion.fecha_sorteo;

        const simulatedMoment = moment().tz(CARACAS_TIMEZONE);
        const currentDrawDateMoment = moment.tz(currentDrawDateStr, 'YYYY-MM-DD', CARACAS_TIMEZONE);

        if (simulatedMoment.isSame(currentDrawDateMoment, 'day')) {
             simulatedMoment.set({ hour: DRAW_SUSPENSION_HOUR, minute: DRAW_SUSPENSION_MINUTE + 5, second: 0 });
        } else if (simulatedMoment.isBefore(currentDrawDateMoment, 'day')) {
             return res.status(400).json({ message: 'No se puede cerrar manualmente un sorteo cuya fecha aún no ha llegado.' });
        }

        const result = await cerrarSorteoManualmente(simulatedMoment);

        if (result.success) {
            res.status(200).json({ message: result.message, closedDate: result.closedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de cierre manual de sorteo en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al cerrar el sorteo manualmente.', error: error.message });
    }
});


// --- ENDPOINT PARA SUSPENDER SORTEO (Evaluate Sales Only) ---
app.post('/api/suspender-sorteo', async (req, res) => {
    console.log('API: Recibida solicitud para suspender sorteo (evaluación de ventas).');
    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        
        const now = moment().tz(CARACAS_TIMEZONE);

        const result = await evaluateDrawStatusOnly(now);
        if (result.success) {
            res.status(200).json({ message: result.message, evaluatedDate: result.evaluatedDate, salesPercentage: result.salesPercentage });
        } else {
            res.status(200).json({ message: result.message, salesPercentage: result.salesPercentage });
        }
    } catch (error) {
        console.error('Error en la API de suspensión de sorteo en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al suspender sorteo.', error: error.message });
    }
});


// --- NUEVO ENDPOINT: Establecer fecha de sorteo manualmente (después de suspensión) ---
app.post('/api/set-manual-draw-date', async (req, res) => {
    const { newDrawDate } = req.body;
    console.log(`API: Recibida solicitud para establecer fecha de sorteo manualmente a: ${newDrawDate}.`);

    if (!newDrawDate || !moment(newDrawDate, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).json({ message: 'Fecha de sorteo inválida. Debe serYYYY-MM-DD.' });
    }

    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        
        const oldDrawDate = configuracion.fecha_sorteo;
        const oldDrawCorrelativo = configuracion.numero_sorteo_correlativo; 

        await advanceDrawConfiguration(configuracion, newDrawDate);

        await liberateOldReservedNumbers(configuracion.numero_sorteo_correlativo);

        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar
        const salesForOldDraw = ventas.filter(venta => 
            venta.drawDate === oldDrawDate && 
            ['Confirmado', 'Pendiente', 'Cerrado por Suficiencia de Ventas', 'Anulado por bajo porcentaje'].includes(venta.validationStatus)
        );


        const { excelFilePath, excelFileName } = await generateGenericSalesExcelReport(
            salesForOldDraw,
            { fecha_sorteo: oldDrawDate, numero_sorteo_correlativo: oldDrawCorrelativo },
            `Reporte de Reprogramación del Sorteo ${oldDrawDate}`,
            'Reporte_Reprogramacion'
        );

        const whatsappMessage = `*¡Sorteo Reprogramado!* 🗓️\n\nLa fecha del sorteo ha sido actualizada manualmente. Anteriormente Sorteo Nro. *${oldDrawCorrelativo}* de fecha *${oldDrawDate}*.\n\nAhora Sorteo Nro. *${configuracion.numero_sorteo_correlativo}* para la fecha: *${newDrawDate}*.\n\n¡La página de compra está nuevamente activa!`;
        await sendWhatsappNotification(whatsappMessage);

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `NOTIFICACIÓN: Sorteo Reprogramado - Nueva Fecha ${newDrawDate}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se les informa que el sorteo ha sido <strong>reprogramado manualmente</strong>.</p>
                <p><b>Fecha Anterior:</b> ${oldDrawDate} (Sorteo Nro. ${oldDrawCorrelativo})</p>
                <p><b>Nueva Fecha:</b> ${newDrawDate} (Sorteo Nro. ${configuracion.numero_sorteo_correlativo})</p>
                <p>Adjunto encontrarás el reporte de ventas del sorteo anterior (${oldDrawDate}) al momento de la reprogramación.</p>
                <p>La página de compra ha sido desbloqueada automáticamente.</p>
                <p>Por favor, revisen el panel de administración para más detalles.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = excelFilePath ? [{
                filename: excelFileName,
                path: excelFilePath,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            }] : [];

            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (!emailSent) {
                console.error('Fallo al enviar el correo de notificación de reprogramación.');
            }
        }

        res.status(200).json({
            success: true,
            message: `Fecha del sorteo actualizada manualmente a ${newDrawDate}. El número de sorteo ha avanzado al ${configuracion.numero_sorteo_correlativo} y los números reservados antiguos han sido liberados.`,
            newConfig: configuracion
        });

    } catch (error) {
        console.error('Error en la API de set-manual-draw-date en archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al establecer la fecha del sorteo manualmente.', error: error.message });
    }
});


// NUEVO ENDPOINT: Notificación de ventas para desarrolladores
app.post('/api/developer-sales-notification', async (req, res) => {
    console.log('API: Recibida solicitud para notificación de ventas para desarrolladores.');
    try {
        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente
        ventas = await readJsonFile(VENTAS_FILE, ventas); // Recargar la más reciente
        
        const now = moment().tz(CARACAS_TIMEZONE);

        const currentDrawDateStr = configuracion.fecha_sorteo;
        const ventasParaFechaSorteo = ventas.filter(venta => 
            venta.drawDate === currentDrawDateStr && 
            (venta.validationStatus === 'Confirmado' || venta.validationStatus === 'Pendiente')
        );

        const totalVentas = ventasParaFechaSorteo.length;
        const totalPossibleTickets = TOTAL_RAFFLE_NUMBERS;
        const soldPercentage = (totalVentas / totalPossibleTickets) * 100;

        let messageText = `*Notificación de Ventas para Desarrolladores*\n\n`;
        messageText += `*Hora de Notificación:* ${now.format('DD/MM/YYYY HH:mm:ss')}\n`;
        messageText += `*Fecha de Sorteo Activo:* ${currentDrawDateStr}\n`;
        messageText += `*Tickets Vendidos:* ${totalVentas} de ${totalPossibleTickets}\n`;
        messageText += `*Porcentaje de Ventas:* ${soldPercentage.toFixed(2)}%\n\n`;

        if (soldPercentage < SALES_THRESHOLD_PERCENTAGE) {
            messageText += `*Estado:* Las ventas están por debajo del ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        } else {
            messageText += `*Estado:* Las ventas han alcanzado o superado el ${SALES_THRESHOLD_PERCENTAGE}% requerido.`;
        }

        await sendWhatsappNotification(messageText);

        res.status(200).json({ message: 'Notificación de ventas para desarrolladores enviada exitosamente por WhatsApp.' });

    } catch (error) {
        console.error('Error al enviar notificación de ventas para desarrolladores desde archivo local:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al enviar notificación de ventas para desarrolladores.', error: error.message });
    }
});


// Endpoint para limpiar todos los datos (útil para reinicios de sorteo)
app.post('/api/admin/limpiar-datos', async (req, res) => {
    console.log('API: Recibida solicitud para limpiar datos.');
    try {
        // Resetear números
        const initialNumbers = [];
        for (let i = 0; i < TOTAL_RAFFLE_NUMBERS; i++) {
            const numStr = i.toString().padStart(3, '0');
            initialNumbers.push({ numero: numStr, comprado: false, originalDrawNumber: null });
        }
        await writeJsonFile(NUMEROS_FILE, initialNumbers);
        numeros = initialNumbers;

        // Limpiar ventas, resultados, ganadores y comprobantes
        await writeJsonFile(VENTAS_FILE, []);
        ventas = [];
        await writeJsonFile(RESULTADOS_ZULIA_FILE, []);
        resultadosZulia = [];
        await writeJsonFile(GANADORES_FILE, []);
        ganadores = [];
        await writeJsonFile(COMPROBANTES_FILE, []);
        comprobantes = [];

        // Resetear configuración a valores iniciales (o un estado limpio)
        configuracion = {
            tasa_dolar: 36.50,
            pagina_bloqueada: false,
            fecha_sorteo: moment().tz(CARACAS_TIMEZONE).add(1, 'days').format('YYYY-MM-DD'),
            precio_ticket: 3.00,
            numero_sorteo_correlativo: 1,
            ultimo_numero_ticket: 0,
            ultima_fecha_resultados_zulia: null,
            admin_whatsapp_numbers: configuracion.admin_whatsapp_numbers, // Mantener los números de WhatsApp
            mail_config: configuracion.mail_config, // Mantener la configuración de correo
            admin_email_for_reports: configuracion.admin_email_for_reports, // Mantener los correos de reporte
            raffleNumbersInitialized: true, // Ya inicializados
            last_sales_notification_count: 0,
            sales_notification_threshold: 20,
            block_reason_message: ""
        };
        await writeJsonFile(CONFIG_FILE, configuracion);

        // Opcional: Limpiar archivos de comprobantes subidos
        const files = await fs.readdir(UPLOADS_DIR);
        for (const file of files) {
            await fs.unlink(path.join(UPLOADS_DIR, file));
        }
        console.log('Archivos de comprobantes en /uploads eliminados.');


        res.status(200).json({ message: 'Todos los datos de la aplicación han sido limpiados y reseteados.' });
        console.log('Todos los datos de la aplicación han sido limpiados y reseteados.');

    } catch (error) {
        console.error('Error al limpiar datos:', error.message);
        res.status(500).json({ message: 'Error interno del servidor al limpiar datos.', error: error.message });
    }
});


// Tareas programadas (Cron Jobs)
// Se ejecutarán después de que el servidor se inicie y los datos se carguen

/**
 * Función asíncrona para la tarea programada de verificación diaria de ventas
 * y posible anulación/cierre de sorteo, y avance al siguiente sorteo.
 */
async function dailyDrawCheckCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    const cronResult = await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: ${cronResult.message}`);
}

cron.schedule('15 12 * * *', dailyDrawCheckCronJob, {
    timezone: CARACAS_TIMEZONE
});

/**
 * Función asíncrona para la tarea programada de Notificación de ventas por WhatsApp y Email.
 * Se ejecuta periódicamente para enviar resúmenes de ventas a los administradores.
 */
async function salesSummaryCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications();
}

cron.schedule('*/55 * * * *', salesSummaryCronJob);

/**
 * NUEVA FUNCIÓN CRON JOB: Respaldo automático de la base de datos y envío por correo.
 * Se ejecuta cada 55 minutos para generar un backup y enviarlo.
 */
async function dailyDatabaseBackupCronJob() {
    console.log('CRON JOB: Iniciando respaldo automático de la base de datos y envío por correo.');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const backupFileName = `rifas_db_backup_${now.format('YYYYMMDD_HHmmss')}.zip`;
        const zipBuffer = await generateDatabaseBackupZipBuffer();

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `Respaldo Automático de Base de Datos - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se ha generado el respaldo automático de la base de datos de Rifas.</p>
                <p>Fecha y Hora del Respaldo: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
                <p>Adjunto encontrarás el archivo ZIP con los datos exportados a Excel.</p>
                <p>Por favor, guarden este archivo en un lugar seguro.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = [
                {
                    filename: backupFileName,
                    content: zipBuffer,
                    contentType: 'application/zip'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (emailSent) {
                console.log('Respaldo de base de datos enviado por correo exitosamente.');
            } else {
                console.error('Fallo al enviar el correo de respaldo de base de datos.');
            }
        } else {
            console.warn('No hay correos de administrador configurados para enviar el respaldo de la base de datos.');
        }
    } catch (error) {
        console.error('Error durante el cron job de respaldo automático de la base de datos:', error.message);
    }
}

cron.schedule('*/55 * * * *', dailyDatabaseBackupCronJob, {
    timezone: CARACAS_TIMEZONE
});


// --- Funciones de limpieza de datos antiguos (adaptadas para archivos locales) ---

/**
 * Elimina ventas antiguas del archivo 'ventas.json' y actualiza los números de rifa asociados.
 * @param {number} daysToRetain Días para retener las ventas (ej. 30 para retener 30 días, eliminar más antiguos).
 */
async function cleanOldSalesAndRaffleNumbers(daysToRetain = 30) {
    console.log(`INFO: Iniciando limpieza de ventas y números de rifa anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO: Fecha de corte para eliminación: ${cutoffDate}`);

    ventas = await readJsonFile(VENTAS_FILE, []); // Recargar
    numeros = await readJsonFile(NUMEROS_FILE, []); // Recargar

    const oldSales = ventas.filter(sale => moment(sale.purchaseDate).isBefore(cutoffDate));
    const salesToKeep = ventas.filter(sale => !moment(sale.purchaseDate).isBefore(cutoffDate));

    console.log(`INFO: Encontradas ${oldSales.length} ventas antiguas para procesar.`);

    // Actualizar el estado 'comprado' de los números de rifa asociados a estas ventas antiguas
    const numbersToUpdate = new Set();
    oldSales.forEach(sale => {
        if (Array.isArray(sale.numbers)) {
            sale.numbers.forEach(num => numbersToUpdate.add(num));
        }
    });

    if (numbersToUpdate.size > 0) {
        console.log(`INFO: Procesando ${numbersToUpdate.size} números de rifa para posible actualización.`);
        numbers.forEach(numObj => {
            if (numbersToUpdate.has(numObj.numero)) {
                numObj.comprado = false; // Marcar como no vendido
                numObj.originalDrawNumber = null;
            }
        });
        await writeJsonFile(NUMEROS_FILE, numeros);
        console.log('INFO: Números de rifa asociados a ventas antiguas actualizados (comprado: false).');
    } else {
        console.log('INFO: No hay números de rifa para actualizar de ventas antiguas.');
    }

    await writeJsonFile(VENTAS_FILE, salesToKeep);
    ventas = salesToKeep; // Actualizar caché
    console.log(`INFO: Total de ventas antiguas eliminadas: ${oldSales.length}. Total de ventas restantes: ${ventas.length}`);
}

/**
 * Elimina documentos de resultados de sorteos antiguos.
 * @param {number} daysToRetain Días para retener los resultados (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldDrawResults(daysToRetain = 60) {
    console.log(`INFO: Iniciando limpieza de resultados de sorteos anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO: Fecha de corte para eliminación de resultados: ${cutoffDate}`);

    resultadosZulia = await readJsonFile(RESULTADOS_ZULIA_FILE, []); // Recargar
    const resultsToKeep = resultadosZulia.filter(res => moment(res.fecha).isSameOrAfter(cutoffDate));
    const oldResultsCount = resultadosZulia.length - resultsToKeep.length;

    await writeJsonFile(RESULTADOS_ZULIA_FILE, resultsToKeep);
    resultadosZulia = resultsToKeep; // Actualizar caché
    console.log(`INFO: Total de resultados de sorteos antiguos eliminados: ${oldResultsCount}. Total restantes: ${resultadosZulia.length}`);
}

/**
 * Elimina documentos de premios antiguos.
 * @param {number} daysToRetain Días para retener los premios (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldPrizes(daysToRetain = 60) {
    console.log(`INFO: Iniciando limpieza de premios anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO: Fecha de corte para eliminación de premios: ${cutoffDate}`);

    premios = await readJsonFile(PREMIOS_FILE, {}); // Recargar
    const updatedPrizes = {};
    let deletedPrizesCount = 0;

    for (const fecha in premios) {
        if (moment(fecha).isSameOrAfter(cutoffDate)) {
            updatedPrizes[fecha] = premios[fecha];
        } else {
            deletedPrizesCount++;
        }
    }

    await writeJsonFile(PREMIOS_FILE, updatedPrizes);
    premios = updatedPrizes; // Actualizar caché
    console.log(`INFO: Total de premios antiguos eliminados: ${deletedPrizesCount}. Total restantes: ${Object.keys(premios).length}`);
}

/**
 * Elimina documentos de ganadores antiguos.
 * @param {number} daysToRetain Días para retener los ganadores (ej. 60 para retener 60 días, eliminar más antiguos).
 */
async function cleanOldWinners(daysToRetain = 60) {
    console.log(`INFO: Iniciando limpieza de ganadores anteriores a ${daysToRetain} días.`);
    const cutoffDate = moment().tz(CARACAS_TIMEZONE).subtract(daysToRetain, 'days').format('YYYY-MM-DD');
    console.log(`INFO: Fecha de corte para eliminación de ganadores: ${cutoffDate}`);

    ganadores = await readJsonFile(GANADORES_FILE, []); // Recargar
    const winnersToKeep = ganadores.filter(winner => moment(winner.drawDate).isSameOrAfter(cutoffDate));
    const oldWinnersCount = ganadores.length - winnersToKeep.length;

    await writeJsonFile(GANADORES_FILE, winnersToKeep);
    ganadores = winnersToKeep; // Actualizar caché
    console.log(`INFO: Total de ganadores antiguos eliminados: ${oldWinnersCount}. Total restantes: ${ganadores.length}`);
}


// Tareas programadas (Cron Jobs)
// Se ejecutarán después de que el servidor se inicie y los datos se carguen

/**
 * Función asíncrona para la tarea programada de verificación diaria de ventas
 * y posible anulación/cierre de sorteo, y avance al siguiente sorteo.
 */
async function dailyDrawCheckCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para verificar ventas y posible anulación/cierre de sorteo.');
    const cronResult = await cerrarSorteoManualmente(moment().tz(CARACAS_TIMEZONE));
    console.log(`CRON JOB Resultado: ${cronResult.message}`);
}

cron.schedule('15 12 * * *', dailyDrawCheckCronJob, {
    timezone: CARACAS_TIMEZONE
});

/**
 * Función asíncrona para la tarea programada de Notificación de ventas por WhatsApp y Email.
 * Se ejecuta periódicamente para enviar resúmenes de ventas a los administradores.
 */
async function salesSummaryCronJob() {
    console.log('CRON JOB: Ejecutando tarea programada para enviar notificación de resumen de ventas por WhatsApp y Email.');
    await sendSalesSummaryNotifications();
}

cron.schedule('*/55 * * * *', salesSummaryCronJob);

/**
 * NUEVA FUNCIÓN CRON JOB: Respaldo automático de la base de datos y envío por correo.
 * Se ejecuta cada 55 minutos para generar un backup y enviarlo.
 */
async function dailyDatabaseBackupCronJob() {
    console.log('CRON JOB: Iniciando respaldo automático de la base de datos y envío por correo.');
    try {
        const now = moment().tz(CARACAS_TIMEZONE);
        const backupFileName = `rifas_db_backup_${now.format('YYYYMMDD_HHmmss')}.zip`;
        const zipBuffer = await generateDatabaseBackupZipBuffer();

        configuracion = await readJsonFile(CONFIG_FILE, configuracion); // Recargar la más reciente

        if (configuracion.admin_email_for_reports && configuracion.admin_email_for_reports.length > 0) {
            const emailSubject = `Respaldo Automático de Base de Datos - ${now.format('YYYY-MM-DD HH:mm')}`;
            const emailHtmlContent = `
                <p>Estimados administradores,</p>
                <p>Se ha generado el respaldo automático de la base de datos de Rifas.</p>
                <p>Fecha y Hora del Respaldo: ${now.format('DD/MM/YYYY HH:mm:ss')}</p>
                <p>Adjunto encontrarás el archivo ZIP con los datos exportados a Excel.</p>
                <p>Por favor, guarden este archivo en un lugar seguro.</p>
                <p>Atentamente,<br>El equipo de Rifas</p>
            `;
            const attachments = [
                {
                    filename: backupFileName,
                    content: zipBuffer,
                    contentType: 'application/zip'
                }
            ];
            const emailSent = await sendEmail(configuracion.admin_email_for_reports, emailSubject, emailHtmlContent, attachments);
            if (emailSent) {
                console.log('Respaldo de base de datos enviado por correo exitosamente.');
            } else {
                console.error('Fallo al enviar el correo de respaldo de base de datos.');
            }
        } else {
            console.warn('No hay correos de administrador configurados para enviar el respaldo de la base de datos.');
        }
    } catch (error) {
        console.error('Error durante el cron job de respaldo automático de la base de datos:', error.message);
    }
}

cron.schedule('*/55 * * * *', dailyDatabaseBackupCronJob, {
    timezone: CARACAS_TIMEZONE
});


// Cron jobs para la limpieza de datos antiguos
cron.schedule('0 3 * * *', async () => { // Cada día a las 03:00 AM
    console.log('CRON JOB: Ejecutando limpieza de datos antiguos.');
    await cleanOldSalesAndRaffleNumbers(30); // Eliminar ventas de más de 30 días
    await cleanOldDrawResults(60); // Eliminar resultados de más de 60 días
    await cleanOldPrizes(60); // Eliminar premios de más de 60 días
    await cleanOldWinners(60); // Eliminar ganadores de más de 60 días
    console.log('CRON JOB: Limpieza de datos antiguos finalizada.');
}, {
    timezone: CARACAS_TIMEZONE
});


// Inicialización del servidor
(async () => {
    try {
        console.log('DEBUG: Iniciando IIFE de inicialización del servidor.');
        await ensureDataAndComprobantesDirs();
        console.log('DEBUG: Directorios asegurados.');
        await loadInitialData();
        console.log('DEBUG: Datos iniciales cargados.');
        configureMailer();
        console.log('DEBUG: Mailer configurado.');
        app.listen(port, () => {
            console.log(`Servidor de la API escuchando en el puerto ${port}`);
            console.log(`API Base URL: ${API_BASE_URL}`);
        });
    } catch (err) {
        console.error('Failed to initialize data and start server:', err.message);
        process.exit(1);
    }
})();
